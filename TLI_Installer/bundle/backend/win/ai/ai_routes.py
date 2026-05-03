"""
TLI Bundled AI - ai_routes.py

FastAPI router that provides:
- GET  /api/ai/status
- POST /api/ai/chat
- POST /api/ai/clear-session
- POST /api/ai/clear-device-memory

Assumptions:
- llama.cpp server is OpenAI-compatible:
  - POST {base}/v1/chat/completions
  - GET  {base}/v1/models
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .ai_manager import BundledAIManager


router = APIRouter(prefix="/api/ai", tags=["BundledAI"])


# ----------------------------
# Paths
# ----------------------------
AI_DIR = Path(__file__).resolve().parent
MEMORY_DIR = AI_DIR / "memory"
SESSION_DIR = MEMORY_DIR / "session"
DEVICES_DIR = MEMORY_DIR / "devices"

SESSION_DIR.mkdir(parents=True, exist_ok=True)
DEVICES_DIR.mkdir(parents=True, exist_ok=True)


# ----------------------------
# Helpers
# ----------------------------
def _session_path(session_id: str) -> Path:
    return SESSION_DIR / f"{session_id}.json"


def _load_session(session_id: str) -> List[Dict[str, str]]:
    """
    Returns a list of OpenAI chat messages:
      [{"role":"system","content":"..."}, ...]
    """
    p = _session_path(session_id)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_session(session_id: str, messages: List[Dict[str, str]]) -> None:
    p = _session_path(session_id)
    p.write_text(json.dumps(messages, ensure_ascii=False, indent=2), encoding="utf-8")


def _append_turn(session_id: str, role: str, content: str) -> None:
    msgs = _load_session(session_id)
    msgs.append({"role": role, "content": content})
    # hard cap: keep last ~20 messages to control context size
    if len(msgs) > 21:
        msgs = msgs[-21:]
    _save_session(session_id, msgs)


def _read_file_safe(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def _get_system_prompt() -> str:
    prompt_path = AI_DIR / "prompts" / "system_default.txt"
    p = _read_file_safe(prompt_path).strip()
    if not p:
        # Fallback minimal behavior if file missing
        p = "You are an offline technician assistant. Do not invent facts. Ask for error codes or scans when needed."
    return p


def _llama_chat(base_url: str, payload: Dict[str, Any], timeout_s: int = 120) -> Dict[str, Any]:
    """
    POST to llama server OpenAI-compatible endpoint.
    Uses stdlib only.
    """
    import urllib.request
    import urllib.error

    url = base_url + "/v1/chat/completions"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise HTTPException(status_code=502, detail=f"AI server HTTPError {e.code}: {body}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI server request failed: {str(e)}")


# ----------------------------
# Request / Response models
# ----------------------------
class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    session_id: Optional[str] = None
    device_id: Optional[str] = None  # reserved for future device-memory
    max_tokens: int = 550
    temperature: float = 0.2


class ChatResponse(BaseModel):
    session_id: str
    reply: str
    model: Optional[str] = None
    elapsed_ms: int


class ClearSessionRequest(BaseModel):
    session_id: str


class ClearDeviceMemoryRequest(BaseModel):
    device_id: str


# ----------------------------
# Routes
# ----------------------------
@router.get("/status")
def ai_status() -> Dict[str, Any]:
    mgr = BundledAIManager.get()

    # IMPORTANT: start the runtime if it's not already running
    healthy = mgr.ensure_running()

    return {
        "healthy": healthy,
        "base_url": mgr.base_url,
        "model_expected": "phi-3.5-mini-instruct.Q4_K_M.gguf",
    }


@router.get("/status")
def ai_status() -> Dict[str, Any]:
    mgr = BundledAIManager.get()

    # IMPORTANT: ensure runtime is started for accurate status
    healthy = mgr.ensure_running()

    return {
        "healthy": healthy,
        "base_url": mgr.base_url,
        "model_expected": "phi-3.5-mini-instruct.Q4_K_M.gguf",
    }

@router.post("/chat", response_model=ChatResponse)
def ai_chat(req: ChatRequest) -> ChatResponse:
    mgr = BundledAIManager.get()

    # Ensure server is up
    if not mgr.ensure_running():
        raise HTTPException(
            status_code=503,
            detail="Bundled AI runtime is not available. Ensure llama_server.exe and the model file exist in backend/ai.",
        )

    session_id = req.session_id or str(uuid.uuid4())

    # Build messages: system prompt + previous session + new user message
    system_prompt = _get_system_prompt()
    messages: List[Dict[str, str]] = [{"role": "system", "content": system_prompt}]

    prior = _load_session(session_id)
    # Prior already includes system? We store only user/assistant turns.
    for m in prior:
        if m.get("role") in ("user", "assistant"):
            messages.append({"role": m["role"], "content": m.get("content", "")})

    # Append the new user message (also store it)
    user_text = req.message.strip()
    messages.append({"role": "user", "content": user_text})
    _append_turn(session_id, "user", user_text)

    # Make request
    payload = {
        "model": "tli-bundled-phi-3.5-mini",
        "messages": messages,
        "max_tokens": int(req.max_tokens),
        "temperature": float(req.temperature),
        "stream": False,
    }

    t0 = time.time()
    result = _llama_chat(mgr.base_url, payload, timeout_s=120)
    elapsed_ms = int((time.time() - t0) * 1000)

    # Parse response safely
    reply = ""
    model = result.get("model")
    try:
        reply = result["choices"][0]["message"]["content"]
    except Exception:
        reply = ""

    reply = (reply or "").strip()
    if not reply:
        raise HTTPException(status_code=502, detail="AI server returned an empty response.")

    _append_turn(session_id, "assistant", reply)

    return ChatResponse(session_id=session_id, reply=reply, model=model, elapsed_ms=elapsed_ms)


@router.post("/clear-session")
def clear_session(req: ClearSessionRequest) -> Dict[str, Any]:
    p = _session_path(req.session_id)
    if p.exists():
        p.unlink()
    return {"ok": True, "session_id": req.session_id}


@router.post("/clear-device-memory")
def clear_device_memory(req: ClearDeviceMemoryRequest) -> Dict[str, Any]:
    """
    v1 placeholder:
    We will implement per-device sqlite memory next.
    For now, delete any file that matches device_id.* inside memory/devices.
    """
    deleted = 0
    for file in DEVICES_DIR.glob(f"{req.device_id}.*"):
        try:
            file.unlink()
            deleted += 1
        except Exception:
            pass
    return {"ok": True, "device_id": req.device_id, "deleted_files": deleted}
