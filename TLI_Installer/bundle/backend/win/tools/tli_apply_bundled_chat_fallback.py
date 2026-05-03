import re
import sys
import time
from pathlib import Path
import shutil
import py_compile

MAIN = Path(__file__).resolve().parent.parent / "main.py"

FALLBACK_BLOCK = r'''
# --- Bundled AI fallback (llama.cpp) ---
        try:
            mgr = BundledAIManager.get()
            if mgr.ensure_running():
                user_text = ""
                if hasattr(req, "message") and req.message:
                    user_text = req.message
                elif hasattr(req, "prompt") and req.prompt:
                    user_text = req.prompt
                else:
                    user_text = str(req)

                bundled_payload = {
                    "model": "phi-3.5-mini-instruct.Q4_K_M.gguf",
                    "messages": [
                        {"role": "system", "content": "You are TLI Bundled AI. Be accurate, concise, and practical."},
                        {"role": "user", "content": user_text},
                    ],
                    "temperature": getattr(req, "temperature", 0.2),
                    "max_tokens": getattr(req, "max_tokens", 512),
                    "stream": False,
                }

                url = mgr.base_url.rstrip("/") + "/v1/chat/completions"
                r = requests.post(url, json=bundled_payload, timeout=120)

                if r.status_code == 200:
                    data = r.json() or {}
                    reply_text = (
                        ((data.get("choices") or [{}])[0].get("message") or {}).get("content")
                        or ""
                    ).strip()

                    if reply_text:
                        return ChatResponse(
                            reply=reply_text,
                            model_used="tli-bundled-phi-3.5-mini",
                            brain_used="bundled",
                            timestamp=now_iso(),
                            conversation_id=getattr(req, "conversation_id", None),
                        )
        except Exception:
            pass

'''

def ensure_import(text: str, needle: str, add_line: str) -> str:
    if needle in text:
        return text
    # Insert after the last import line near top
    lines = text.splitlines(True)
    last_import = -1
    for i, ln in enumerate(lines[:250]):
        if ln.startswith("import ") or ln.startswith("from "):
            last_import = i
    if last_import >= 0:
        lines.insert(last_import + 1, add_line + "\n")
    else:
        lines.insert(0, add_line + "\n")
    return "".join(lines)

def main():
    if not MAIN.exists():
        print(f"[PATCH] ERROR: main.py not found at {MAIN}")
        sys.exit(1)

    original = MAIN.read_text(encoding="utf-8", errors="replace")

    # If already patched, exit cleanly
    if "Bundled AI fallback used (LM Studio unreachable)" in original:
        print("[PATCH] Already patched. Nothing to do.")
        sys.exit(0)

    # Ensure required imports exist
    patched = original
    patched = ensure_import(patched, "import requests", "import requests")
    patched = ensure_import(patched, "BundledAIManager", "from ai.ai_manager import BundledAIManager")

    # Insert fallback inside /chat except block:
    # Find the pattern: proxy_resp = try_proxy_chat_to_host(...) then if proxy_resp return, then raise HTTPException(...)
    insert_pat = re.compile(
        r"(proxy_resp\s*=\s*try_proxy_chat_to_host\([^\)]*\)\s*\n"
        r"\s*if\s+proxy_resp\s+is\s+not\s+None:\s*\n"
        r"\s*return\s+proxy_resp\s*\n\s*\n)(\s*raise\s+HTTPException\()",
        re.MULTILINE
    )
    m = insert_pat.search(patched)
    if not m:
        print("[PATCH] ERROR: Could not find the /chat proxy+raise block to patch.")
        print("        This means your /chat handler structure differs from expected.")
        sys.exit(2)

    patched = insert_pat.sub(r"\1" + FALLBACK_BLOCK + r"\2", patched, count=1)

    # Write temp file and compile-check before replacing
    ts = time.strftime("%Y%m%d_%H%M%S")
    backup = MAIN.with_name(f"main_backup_{ts}.py")
    tmp = MAIN.with_name(f"main_tmp_{ts}.py")

    shutil.copy2(MAIN, backup)
    tmp.write_text(patched, encoding="utf-8")

    try:
        py_compile.compile(str(tmp), doraise=True)
    except Exception as e:
        print("[PATCH] ❌ Compile failed. Restoring backup.")
        shutil.copy2(backup, MAIN)
        print("[PATCH] Error:", e)
        sys.exit(3)

    # Replace main.py only if compile succeeded
    shutil.copy2(tmp, MAIN)
    print("[PATCH] ✅ Patch applied successfully.")
    print("[PATCH] Backup saved to:", backup.name)

if __name__ == "__main__":
    main()
