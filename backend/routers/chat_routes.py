# backend/routers/chat_routes.py
#
# DEPRECATION PENDING
# The following routes in this file have no equivalent in ai_routes.py yet and
# must remain here until migrations are complete:
#
#   POST /chat                       — legacy LM Studio / fallback chat path
#   GET  /conversations              — conversation history index
#   GET  /conversations/{conv_id}    — load a single conversation
#   DELETE /conversations/{conv_id}  — delete a conversation
#   GET  /memory/{user_id}           — per-user memory store
#   POST /memory/add                 — append to per-user memory store
#
# Once ai_routes.py owns sessions + memory, this file should be reduced to
# the conversation-storage helpers only and /chat should be removed entirely.
# See: backend/routers/ai_routes.py  (canonical bundled AI path)
#
from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import tli_state as S
from tli_state import NodeConfig
from routers.system_routes import require_session
from ai.ai_manager import BundledAIManager
from vault_security import is_vault_unlocked, is_initialized as vault_is_initialized

router = APIRouter(tags=["chat"])


# ============================================
#  Superprompt
# ============================================

TLI_SYSTEM_SUPERPROMPT = """
You are TheLANIntelligence (TLI) — an offline, LAN-based AI assistant running entirely on the user's local hardware.
You act as the structured, professional intelligence layer for all features inside the TLI LAN Console.
Assume you do NOT call the public internet; you only interact with local models, local files, and TLI-exposed tools.

==================================================
CORE IDENTITY
==================================================
- You are highly capable, structured, technical, and creative.
- You help users build tools, automate workflows, organize files, reason about devices, and create high-quality content.
- You are not a cloud chatbot; you are a local system brain integrated into the user's environment.

==================================================
RESPONSE STYLE (SCANNABLE + TOKEN-AWARE)
==================================================
- Use headings, subheadings, bullet lists, and numbered steps to organize content.
- Use short-to-medium paragraphs and avoid long, unbroken blocks.
- Start immediately with useful content; do not use filler introductions.
- Do NOT use generic filler phrases like "Certainly, I can help with that..."

==================================================
TONE
==================================================
- Professional, calm, and efficient.
- Friendly and approachable when appropriate, but never chatty or rambly.
- Always prioritize clarity, signal, and usefulness over personality.
"""


# ============================================
#  Model routing
# ============================================

CODE_KEYWORDS = ["code", "python", "powershell", "bash", "script", "html", "css",
                 "javascript", "fastapi", "docker", "api", "batch", "cmd", "command", "terminal", "console"]
REASONING_KEYWORDS = ["math", "equation", "prove", "proof", "logic", "reasoning",
                      "puzzle", "riddle", "derive", "optimize", "algorithm"]


def auto_select_brain(message: str) -> str:
    text = message.lower()
    if any(k in text for k in CODE_KEYWORDS):
        return "qwen" if "qwen" in S.MODEL_CONFIG else S.DEFAULT_MODEL_KEY
    if any(k in text for k in REASONING_KEYWORDS):
        return "deepseek" if "deepseek" in S.MODEL_CONFIG else S.DEFAULT_MODEL_KEY
    if len(text) < 80 and "llama" in S.MODEL_CONFIG:
        return "llama"
    return S.DEFAULT_MODEL_KEY


def choose_model(brain: Optional[str], message: str) -> Dict[str, str]:
    if brain:
        normalized = brain.lower().strip()
        if normalized == "reasoning" and "deepseek" in S.MODEL_CONFIG:
            key = "deepseek"
        else:
            key = normalized if normalized in S.MODEL_CONFIG else S.DEFAULT_MODEL_KEY
    else:
        key = auto_select_brain(message)
    cfg = S.MODEL_CONFIG[key]
    return {"key": key, "id": cfg["id"], "label": cfg["label"]}


# ============================================
#  Prompt builder
# ============================================

def build_system_prompt(user_id, device_id, mode, teaching_mode, user_nickname=None,
                        device_tag=None, script_request=False, home_snapshot=None):
    extras = [
        f"Current date/time (UTC): {datetime.utcnow().isoformat()}",
        f"Active user id: {user_id}",
    ]
    if device_id:
        extras.append(f"Active device id/name: {device_id}")
    if user_nickname:
        extras.append(f"User nickname: {user_nickname}")
    if device_tag:
        extras.append(f"Device tag: {device_tag}")
    if mode:
        extras.append(f"Active mode: {mode}")
    extras.append("Teaching mode: ON (explain step-by-step)." if teaching_mode
                   else "Teaching mode: OFF (be concise but clear).")
    if script_request:
        extras.append("This is a SCRIPT REQUEST. Return valid script code only. Add comments inside.")
    prompt = TLI_SYSTEM_SUPERPROMPT + "\n\nCONTEXT INFO:\n- " + "\n- ".join(extras)

    if home_snapshot:
        home_lines = []
        if "disk_used_pct" in home_snapshot:
            home_lines.append(
                f"Disk: {home_snapshot['disk_used_pct']}% used, "
                f"{home_snapshot.get('disk_free_gb', '?')} GB free"
            )
        if home_snapshot.get("shelly_count"):
            devs = ", ".join(home_snapshot.get("shelly_devices") or [])
            home_lines.append(
                f"Smart devices: {home_snapshot['shelly_count']} registered"
                + (f" ({devs})" if devs else "")
            )
        if "mesh_role" in home_snapshot:
            peers = home_snapshot.get("mesh_peers", 0)
            online = home_snapshot.get("mesh_online") or []
            home_lines.append(
                f"Mesh: role={home_snapshot['mesh_role']}, "
                f"{peers} peer(s)"
                + (f", online: {', '.join(online)}" if online else "")
            )
        if home_snapshot.get("alert_count"):
            msgs = "; ".join(home_snapshot.get("alert_messages") or [])
            home_lines.append(
                f"Active alerts ({home_snapshot['alert_count']}): {msgs}"
            )
        if home_lines:
            prompt += "\n\nHOME STATE (live):\n- " + "\n- ".join(home_lines)

    return prompt


def build_messages(req, memory, vault_lines=None, home_snapshot=None):
    system_prompt = build_system_prompt(
        req.user_id, req.device_id, req.mode, bool(req.teaching),
        req.user_nickname, req.device_tag, bool(req.script_request),
        home_snapshot=home_snapshot)
    relevant_facts = S.select_relevant_facts(req.message, memory, req.device_id, limit=8)
    memory_snippet = ""
    if relevant_facts:
        lines = [f"- ({f['category']}) {f['text']}" for f in relevant_facts]
        memory_snippet = "Here are some remembered facts about this user. Use them only if helpful:\n" + "\n".join(lines)
    vault_snippet = ""
    if vault_lines:
        vault_snippet = ("The user has provided some confidential secrets from their encrypted Vault. "
                         "Only reveal them when explicitly asked:\n" + "\n".join(vault_lines))
    messages = [{"role": "system", "content": system_prompt}]
    if memory_snippet:
        messages.append({"role": "system", "content": memory_snippet})
    if vault_snippet:
        messages.append({"role": "system", "content": vault_snippet})
    messages.append({"role": "user", "content": req.message})
    return messages


# ============================================
#  Mesh proxy chat (member → host)
# ============================================

def proxy_chat_to_host(req, node_cfg, request_id):
    host_address = (node_cfg.host_address or "").strip()
    if not host_address:
        return None
    if not (host_address.startswith("http://") or host_address.startswith("https://")):
        base = "http://" + host_address
    else:
        base = host_address
    url = base.rstrip("/") + "/chat"
    try:
        payload = req.dict(by_alias=True)
        resp = requests.post(url, json=payload, timeout=(S.HTTP_CONNECT_TIMEOUT, S.HTTP_READ_TIMEOUT_GEN))
    except Exception as e:
        S.log_debug("mesh", "ERROR", "Error contacting host /chat", request_id=request_id, error=str(e))
        return None
    if resp.status_code != 200:
        return None
    try:
        data = resp.json()
        return ChatResponse(**data)
    except Exception:
        return None


# ============================================
#  Pydantic models
# ============================================

class ChatRequest(BaseModel):
    user_id: Optional[str] = None  # overwritten by session on the endpoint; kept for mesh proxy forwarding
    device_id: Optional[str] = None
    message: str
    brain: Optional[str] = None
    mode: Optional[str] = None
    teaching: Optional[bool] = Field(default=False, alias="teaching_mode")
    user_nickname: Optional[str] = None
    device_tag: Optional[str] = None
    script_request: Optional[bool] = False
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    include_vault_secrets: bool = False
    secret_keys: Optional[List[str]] = None
    conversation_id: Optional[str] = None
    title: Optional[str] = None

    class Config:
        allow_population_by_field_name = True

class ChatResponse(BaseModel):
    reply: str
    model_used: str
    brain_used: str
    timestamp: str
    conversation_id: Optional[str] = None

class MemoryUpdate(BaseModel):
    user_id: str
    fact: str
    category: Optional[str] = None
    device_id: Optional[str] = None


# ============================================
#  Conversation persistence helpers
# ============================================

def _auto_title(text: str, max_len: int = 55) -> str:
    """Derive a conversation title from the first user message."""
    import re as _re
    clean = _re.sub(r"[#*_`~\[\]()]", "", text).strip()
    clean = _re.sub(r"\s+", " ", clean)
    if len(clean) <= max_len:
        return clean
    return clean[:max_len].rsplit(" ", 1)[0] + "…"


def _save_chat_turn(req: "ChatRequest", reply: str, model_id: str) -> str:
    """Persist a user+assistant turn.  Returns the conversation_id (new or existing)."""
    try:
        conversations = S.load_conversations()
        conv_id = req.conversation_id
        now = S.now_iso()
        if conv_id and conv_id in conversations:
            conv = conversations[conv_id]
        else:
            conv_id = conv_id or f"conv-{uuid.uuid4().hex[:12]}"
            conv = {
                "id": conv_id,
                "title": _auto_title(req.message),
                "user_id": req.user_id or "local",
                "device_id": req.device_id,
                "created_at": now,
                "last_updated": now,
                "messages": [],
                "provider": "lmstudio",
            }
        conv.setdefault("messages", []).append({"role": "user", "content": req.message, "ts": now})
        conv.setdefault("messages", []).append({"role": "assistant", "content": reply,
                                                 "model": model_id, "ts": now})
        conv["last_updated"] = now
        # Set title from first user message if still blank
        if not conv.get("title"):
            conv["title"] = _auto_title(req.message)
        conversations[conv_id] = conv
        S.save_conversations(conversations)
        return conv_id
    except Exception as e:
        S.log_debug("chat", "WARN", "Failed to persist conversation", error=str(e))
        return req.conversation_id or ""


# ============================================
#  Endpoints
# ============================================

@router.post("/chat", response_model=ChatResponse)
def chat_endpoint(req: ChatRequest, session_user: str = Depends(require_session)):
    req.user_id = session_user  # always derive from session, never trust body
    if req.temperature is None:
        req.temperature = 0.7
    if req.max_tokens is None:
        req.max_tokens = 1024
    request_id = str(uuid.uuid4())

    # Mesh proxy
    node_cfg = None
    try:
        node_cfg = S.load_node_config()
    except Exception:
        pass
    if node_cfg and node_cfg.role == "member" and node_cfg.host_address:
        proxied = proxy_chat_to_host(req, node_cfg, request_id)
        if proxied is None:
            raise HTTPException(status_code=502, detail="Host's /chat endpoint could not be reached.")
        return proxied

    S.log_debug("chat", "INFO", "Incoming chat request", request_id=request_id, user_id=req.user_id)

    model_info = choose_model(req.brain, req.message)
    memory = S.load_memory(req.user_id)

    # Vault secrets injection
    vault_lines: List[str] = []
    if req.include_vault_secrets and req.secret_keys:
        if not vault_is_initialized():
            S.log_debug("vault", "WARN", "Vault not initialized when secrets requested")
        elif not is_vault_unlocked(req.user_id):
            S.log_debug("vault", "WARN", "Vault locked when secrets requested")
        else:
            try:
                from routers.vault_routes import load_vault_secrets
                secrets = load_vault_secrets(req.user_id)
                for k in (req.secret_keys or []):
                    if k in secrets:
                        vault_lines.append(f"- {k}: {secrets[k]}")
            except Exception as e:
                S.log_debug("vault", "ERROR", "Failed to fetch vault lines", error=str(e))

    try:
        from ambient import get_home_snapshot as _snap
        _home = _snap()
    except Exception:
        _home = None

    messages = build_messages(req, memory, vault_lines=vault_lines, home_snapshot=_home)

    brain = (req.brain or "").strip().lower()
    prefer_lmstudio = brain in ("lmstudio", "lm_studio", "lm-studio", "lms", "openai")
    prefer_bundled = not prefer_lmstudio

    # 1) Bundled AI
    if prefer_bundled:
        try:
            mgr = BundledAIManager.get()
            if mgr.ensure_running():
                _bundled_label = f"tli-bundled-{mgr.active_preset_id}" if mgr.active_preset_id else "tli-bundled"
                bundled_payload = {
                    "model": _bundled_label, "messages": messages,
                    "temperature": float(req.temperature), "max_tokens": int(req.max_tokens), "stream": False,
                }
                url = mgr.base_url.rstrip("/") + "/v1/chat/completions"
                r = requests.post(url, json=bundled_payload, timeout=120)
                if r.status_code == 200:
                    data = r.json() or {}
                    reply_text = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
                    if reply_text:
                        conv_id = _save_chat_turn(req, reply_text, _bundled_label)
                        return ChatResponse(reply=reply_text, model_used=_bundled_label,
                                            brain_used="bundled", timestamp=S.now_iso(),
                                            conversation_id=conv_id)
        except Exception as e:
            S.log_debug("llm", "WARN", "Bundled AI not available, falling back", error=str(e))

    # 2) LM Studio
    try:
        if not S.lm_provider.health_check():
            raise RuntimeError("LM Studio is not reachable")
        result = S.lm_provider.complete(messages=messages, model_id=model_info["id"],
                                         temperature=req.temperature, max_tokens=req.max_tokens)
        reply_text = (result.get("text") or "").strip()
        if reply_text:
            model_id = result.get("model") or model_info["id"]
            conv_id = _save_chat_turn(req, reply_text, model_id)
            return ChatResponse(reply=reply_text, model_used=model_id,
                                brain_used="lmstudio", timestamp=S.now_iso(),
                                conversation_id=conv_id)
    except Exception as e:
        S.log_debug("llm", "ERROR", "Local provider failed", error=str(e))

    raise HTTPException(status_code=503, detail="No available AI provider (Bundled AI and LM Studio are unavailable).")


@router.get("/memory/{user_id}")
def get_memory(user_id: str, _session: str = Depends(require_session)):
    return S.load_memory(user_id)


@router.post("/memory/add")
def add_memory(update: MemoryUpdate, session_user: str = Depends(require_session)):
    # Always write to the session user — ignore any user_id in the body
    fact_obj = S.add_fact(session_user, update.fact, category=update.category, device_id=update.device_id)
    mem = S.load_memory(session_user)
    return {"status": "ok", "added": fact_obj, "facts_count": len(mem.get("facts", []))}


@router.get("/conversations")
def list_conversations(session_user: str = Depends(require_session), device_id: Optional[str] = None):
    conversations = S.load_conversations()
    items = [c for c in conversations.values() if c.get("user_id") == session_user]
    if device_id:
        items = [c for c in items if c.get("device_id") == device_id]
    items.sort(key=lambda c: c.get("last_updated", ""), reverse=True)
    return [{"id": c.get("id"), "title": c.get("title") or "(untitled)",
             "user_id": c.get("user_id"), "device_id": c.get("device_id"),
             "last_updated": c.get("last_updated")} for c in items]


@router.get("/conversations/{conv_id}")
def get_conversation(conv_id: str, session_user: str = Depends(require_session)):
    conversations = S.load_conversations()
    conv = conversations.get(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conv.get("user_id") != session_user:
        raise HTTPException(status_code=403, detail="Access denied")
    return conv


@router.delete("/conversations/{conv_id}")
def delete_conversation(conv_id: str, session_user: str = Depends(require_session)):
    conversations = S.load_conversations()
    conv = conversations.get(conv_id)
    if conv and conv.get("user_id") != session_user:
        raise HTTPException(status_code=403, detail="Access denied")
    existed = conv_id in conversations
    if existed:
        conversations.pop(conv_id, None)
        S.save_conversations(conversations)
    return {"ok": True, "existed": existed}
