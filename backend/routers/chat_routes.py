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
from ai.status_answers import answer as ai_status_answer, is_status_question
from intelligence import context as shared_context, memory as shared_memory
from intelligence import input_budget, observed_answers, answer_evidence
from intelligence import chat_continuity
from intelligence import notebook, documents, case_context
from intelligence.documents import Document
from intelligence import devices as shared_devices
from intelligence.chat import diagnostic_answer, image_reply
from intelligence.screenshots import ScreenshotOptions, public_receipt, validate_request as validate_screenshot
from conversation_guard import exclusive_turn, assert_idle
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
                f"Recorded disk (drive identity not supplied): {home_snapshot['disk_used_pct']}% used, "
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
                + (f", recorded allowed peers: {', '.join(online)}" if online else "")
            )
        if home_snapshot.get("alert_count"):
            msgs = "; ".join(home_snapshot.get("alert_messages") or [])
            home_lines.append(
                f"Active alerts ({home_snapshot['alert_count']}): {msgs}"
            )
        if home_lines:
            prompt += "\n\nHost snapshot (observation age not supplied; registry entries are not reachability checks):\n- " + "\n- ".join(home_lines)

    return prompt


def build_messages(req, memory, vault_lines=None, home_snapshot=None):
    return _prepare_messages(req, vault_lines, home_snapshot)["messages"]


def _prepare_messages(req, vault_lines=None, home_snapshot=None, *, budget=None):
    system_prompt = build_system_prompt(
        req.user_id, req.device_id, req.mode, bool(req.teaching),
        req.user_nickname, req.device_tag, bool(req.script_request),
        home_snapshot=home_snapshot)
    vault_snippet = ""
    if vault_lines:
        vault_snippet = ("The user has provided some confidential secrets from their encrypted Vault. "
                         "Only reveal them when explicitly asked:\n" + "\n".join(vault_lines))
    if vault_snippet:
        system_prompt += "\n\n" + vault_snippet
    return chat_continuity.prepare(req.user_id, req.message, req.conversation_id, system_prompt,
                                   target_id=req.target_id, diagnostic_id=req.diagnostic_id,
                                   device_id=req.device_id, use_saved_memory=req.use_saved_memory, use_conversation_history=req.use_conversation_history, budget=budget)


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
    target_id: Optional[str] = None
    diagnostic_id: Optional[str] = None
    image_b64: Optional[str] = None
    image_mime: Optional[str] = None
    retention_days: int = Field(default=0, ge=0, le=7)
    screenshot: Optional[ScreenshotOptions] = None
    image_provider_key: Optional[str] = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    note_refs: list[notebook.NoteRef] = Field(default_factory=list, max_length=4)
    documents: list[Document] = Field(default_factory=list, max_length=4)
    case_ref: Optional[case_context.CaseRef] = None
    raw_input: Optional[str] = None  # only checked for incompatible document/Vault syntax
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
    use_saved_memory: bool = Field(default=True, strict=True)
    use_conversation_history: bool = Field(default=True, strict=True)
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
    screenshot_context: Optional[dict] = None
    note_context: Optional[dict] = None
    document_context: Optional[dict] = None
    case_context: Optional[dict] = None
    memory_context: Optional[dict] = None
    conversation_context: Optional[dict] = None
    input_budget: Optional[dict] = None
    observation_context: Optional[dict] = None
    evidence_context: Optional[dict] = None
    source_ref: Optional[dict] = None
    user_source_ref: Optional[dict] = None
    handled_by: Optional[str] = None

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


@S.conversation_transaction
def _save_chat_turn(req: "ChatRequest", reply: str, model_id: str, *, provider=None, host=None, screenshot_context=None, note_context=None, document_context=None, memory_context=None, conversation_context=None, input_budget=None, observation_context=None, evidence_context=None, case_context=None) -> str:
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
        assistant = {"role": "assistant", "content": reply, "model": model_id, "ts": now}
        if isinstance(provider, str) and provider:
            assistant["provider"] = provider
        host_name = host.get("name") if isinstance(host, dict) else host
        if isinstance(host_name, str) and host_name:
            assistant["host"] = host_name
        receipt = public_receipt(screenshot_context)
        if receipt:
            assistant["screenshot_context"] = receipt
        note_receipt = notebook.public_receipt(note_context)
        if note_receipt:
            assistant["note_context"] = note_receipt
        document_receipt = documents.public_receipt(document_context)
        if document_receipt:
            assistant["document_context"] = document_receipt
        assistant.update(chat_continuity.receipts({"memory_context": memory_context, "conversation_context": conversation_context,
                                                  "input_budget": input_budget, "observation_context": observation_context, "evidence_context": evidence_context, "case_context": case_context}))
        conv.setdefault("messages", []).append(assistant)
        conv["last_updated"] = now
        # Set title from first user message if still blank
        if not conv.get("title"):
            conv["title"] = _auto_title(req.message)
        conversations[conv_id] = conv
        S.save_conversations(conversations)
        return conv_id
    except Exception as e:
        S.log_debug("chat", "WARN", "Failed to persist conversation", error=str(e))
        raise HTTPException(503, "The reply was generated but its conversation could not be saved. Check desktop storage before trying again.") from e


# ============================================
#  Endpoints
# ============================================

@router.post("/chat", response_model=ChatResponse)
@exclusive_turn
def chat_endpoint(req: ChatRequest, session_user: str = Depends(require_session)):
    req.user_id = session_user  # always derive from session, never trust body
    chat_continuity.validate_choice(req)
    case_evidence = case_context.prepare(session_user, req, budget=input_budget.for_provider("unknown", max_tokens=req.max_tokens))
    document_evidence = documents.prepare(session_user, req, budget=input_budget.for_provider("unknown", max_tokens=req.max_tokens))
    document_provider = documents.provider_for(req) if document_evidence else None
    note_evidence = notebook.prepare(session_user, req, budget=input_budget.for_provider("unknown", max_tokens=req.max_tokens))
    validate_screenshot(req.screenshot, req.image_b64, session_user)
    if req.conversation_id:
        existing = S.load_conversations().get(req.conversation_id)
        if existing and existing.get("user_id") not in ({session_user, "bundled-ai"} if session_user == "local" else {session_user}):
            raise HTTPException(404, "Conversation not found.")
    if case_evidence:
        return _notebook_reply(req, case_evidence)
    if document_evidence:
        return _document_reply(req, document_evidence, document_provider)
    if note_evidence:
        return _notebook_reply(req, note_evidence)
    outcome = (chat_continuity.recorded_outcome(session_user, req.message, target_id=req.target_id, diagnostic_id=req.diagnostic_id,
               use_saved_memory=req.use_saved_memory, use_conversation_history=req.use_conversation_history)
               if not (req.image_b64 or req.script_request or req.include_vault_secrets) else None)
    if outcome:
        receipts = chat_continuity.receipts(outcome)
        conv_id = _save_chat_turn(req, outcome["text"], "tli-records", provider="tli-records", **receipts)
        return ChatResponse(reply=outcome["text"], model_used="tli-records", brain_used="tli-records", timestamp=S.now_iso(),
                            conversation_id=conv_id, handled_by="recorded_outcome", **receipts, **chat_continuity.source_refs(conv_id))
    result = image_reply(session_user, req.message, req.image_b64, req.image_mime, req.target_id, req.diagnostic_id, req.device_id, req.retention_days, req.max_tokens or 768, req.temperature or 0.2, screenshot=req.screenshot, image_provider_key=req.image_provider_key, use_saved_memory=req.use_saved_memory) if req.image_b64 else None
    answer = result["reply"] if result else diagnostic_answer(session_user, req.message, req.target_id) if not req.diagnostic_id else None
    if answer:
        model = result["model"] if result else "tli-diagnostics"
        conv_id = _save_chat_turn(req, answer, model, provider=result["provider"] if result else "tli-diagnostics",
                                 host=result.get("host") if result else shared_devices.node(),
                                 screenshot_context=result.get("screenshot_context") if result else None, **(chat_continuity.receipts(result) if result else {}))
        return ChatResponse(reply=answer, model_used=model, brain_used=result["provider"] if result else "tli-diagnostics", timestamp=S.now_iso(), conversation_id=conv_id, screenshot_context=result.get("screenshot_context") if result else None, **(chat_continuity.receipts(result) if result else {}), **chat_continuity.source_refs(conv_id))

    if is_status_question(req.message):
        brain = (req.brain or "").strip().lower()
        lm = brain in ("lmstudio", "lm_studio", "lm-studio", "lms", "openai")
        try:
            cfg = S.load_node_config()
            selected_model = choose_model(req.brain, req.message).get("id") if lm else None
            answer = ai_status_answer(req.message, preferred="lmstudio" if lm else "bundled",
                                      selected_model=selected_model,
                                      mesh_host=cfg.host_address if cfg and cfg.role == "member" else None)
        except Exception:
            answer = ("I couldn't verify the configured AI provider's current status. "
                      "Open AI settings to recheck. No model was started or switched.")
        conv_id = _save_chat_turn(req, answer, "tli-status", provider="tli-status")
        return ChatResponse(reply=answer, model_used="tli-status", brain_used="tli-status", timestamp=S.now_iso(),
                            conversation_id=conv_id, handled_by="ai_status", **chat_continuity.source_refs(conv_id))

    observed = observed_answers.answer(req.message, has_context=bool(req.target_id or req.diagnostic_id or req.include_vault_secrets or req.script_request))
    if observed:
        conv_id = _save_chat_turn(req, observed["text"], "tli-observations", provider="tli-tools",
                                 host=observed["observation_context"]["host"], observation_context=observed["observation_context"], evidence_context=observed.get("evidence_context"))
        return ChatResponse(reply=observed["text"], model_used="tli-observations", brain_used="tli-tools",
                            timestamp=S.now_iso(), conversation_id=conv_id, handled_by="observed_status",
                            observation_context=observed["observation_context"], evidence_context=observed.get("evidence_context"), **chat_continuity.source_refs(conv_id))

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
        if not req.use_saved_memory or not req.use_conversation_history:
            raise HTTPException(409, "This mesh route cannot confirm the selected note/history sharing choices. Use a provider on the TLI host for this question.")
        if req.target_id or req.diagnostic_id:
            raise HTTPException(409, "Local diagnostic context cannot be sent through this legacy mesh route. Use a provider on this host.")
        proxied = proxy_chat_to_host(req, node_cfg, request_id)
        if proxied is None:
            raise HTTPException(status_code=502, detail="Host's /chat endpoint could not be reached.")
        if not proxied.reply.strip():
            raise HTTPException(status_code=502, detail="The host returned an empty response. The request was not retried.")
        conv_id = _save_chat_turn(req, proxied.reply, proxied.model_used, provider="mesh", host=node_cfg.host_address, **chat_continuity.mesh_receipts())
        return proxied.model_copy(update={"conversation_id": conv_id, "brain_used": "mesh", **chat_continuity.mesh_receipts(), **chat_continuity.source_refs(conv_id)})

    S.log_debug("chat", "INFO", "Incoming chat request", request_id=request_id, user_id=req.user_id)

    model_info = choose_model(req.brain, req.message)

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

    # Validate required text before starting or contacting a provider. Optional
    # records are selected again for the provider actually used below.
    _prepare_messages(req, vault_lines=vault_lines, home_snapshot=_home,
                      budget=input_budget.for_provider("unknown", max_tokens=req.max_tokens))

    brain = (req.brain or "").strip().lower()
    prefer_lmstudio = brain in ("lmstudio", "lm_studio", "lm-studio", "lms", "openai")
    prefer_bundled = not prefer_lmstudio

    # 1) Bundled AI
    if prefer_bundled:
        attempted = False
        try:
            mgr = BundledAIManager.get()
            if mgr.ensure_running():
                selected_preset = mgr.active_preset_id
                url = mgr.base_url.rstrip("/") + "/v1/chat/completions"
                prepared = _prepare_messages(req, vault_lines=vault_lines, home_snapshot=_home,
                    budget=input_budget.for_provider("bundled", max_tokens=req.max_tokens, manager=mgr))
                context_receipts = chat_continuity.receipts(prepared)
                _bundled_label = f"tli-bundled-{selected_preset}" if selected_preset else "tli-bundled"
                bundled_payload = {
                    "model": _bundled_label, "messages": prepared["messages"],
                    "temperature": float(req.temperature), "max_tokens": int(req.max_tokens), "stream": False,
                }
                with mgr.generation():
                    if mgr.active_preset_id != selected_preset or url != mgr.base_url.rstrip("/") + "/v1/chat/completions":
                        raise HTTPException(409, "The bundled model changed. Review your provider before retrying; the question was not sent.")
                    context_receipts["input_budget"] = input_budget.for_provider("bundled", max_tokens=req.max_tokens, manager=mgr).validate(prepared["messages"])
                    attempted = True
                    r = requests.post(url, json=bundled_payload, timeout=120, allow_redirects=False)
                if 300 <= r.status_code < 400:
                    # A redirect cannot authorize another endpoint or provider
                    # to receive the already prepared private context.
                    raise HTTPException(502, "The selected AI provider attempted a redirect. The question was not sent to another provider.")
                if r.status_code == 200:
                    data = r.json() or {}
                    reply_text = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
                    if reply_text:
                        context_receipts = answer_evidence.complete(context_receipts, reply_text)
                        conv_id = _save_chat_turn(req, reply_text, _bundled_label, provider="bundled", host=shared_devices.node(), **context_receipts)
                        return ChatResponse(reply=reply_text, model_used=_bundled_label,
                                            brain_used="bundled", timestamp=S.now_iso(),
                                            conversation_id=conv_id, **context_receipts, **chat_continuity.source_refs(conv_id))
                raise HTTPException(502, "The bundled model did not complete a usable reply. The question was not retried or sent to another provider.")
        except HTTPException:
            # Persistence failures and explicit generation conflicts must not
            # trigger another provider request after a reply already exists.
            raise
        except Exception as e:
            if attempted:
                raise HTTPException(502, "The bundled request failed. Its completion is uncertain; the question was not retried or sent to another provider.") from e
            S.log_debug("llm", "WARN", "Bundled AI unavailable before generation; considering configured fallback", error=str(e))

    # 2) LM Studio
    try:
        prepared = _prepare_messages(req, vault_lines=vault_lines, home_snapshot=_home,
            budget=input_budget.for_provider("lmstudio", max_tokens=req.max_tokens, provider=S.lm_provider, model_id=model_info["id"]))
        context_receipts = chat_continuity.receipts(prepared)
        result = S.lm_provider.complete(messages=prepared["messages"], model_id=model_info["id"],
                                         temperature=req.temperature, max_tokens=req.max_tokens, allow_redirects=False, enforce_text_budget=True)
        context_receipts.update(chat_continuity.transport_receipts(result))
        reply_text = (result.get("text") or "").strip()
        if reply_text:
            model_id = result.get("model") or model_info["id"]
            context_receipts = answer_evidence.complete(context_receipts, reply_text)
            conv_id = _save_chat_turn(req, reply_text, model_id, provider="lmstudio", host=shared_devices.node(), **context_receipts)
            return ChatResponse(reply=reply_text, model_used=model_id,
                                brain_used="lmstudio", timestamp=S.now_iso(),
                                conversation_id=conv_id, **context_receipts, **chat_continuity.source_refs(conv_id))
    except HTTPException:
        raise
    except Exception as e:
        S.log_debug("llm", "ERROR", "Local provider failed", error=str(e))

    raise HTTPException(status_code=503, detail="The selected AI provider did not complete a usable reply. The question was not retried.")


def _document_reply(req, evidence, provider):
    from ai import ai_routes
    output = req.max_tokens if req.max_tokens is not None else input_budget.DEFAULT_OUTPUT_TOKENS
    context_receipts = {"input_budget": input_budget.for_provider("unknown", max_tokens=output).validate(evidence["messages"])}
    if provider == "bundled":
        mgr = ai_routes._document_runtime()
        selected_model, base_url = mgr.active_preset_id, mgr.base_url
        evidence = documents.fit_evidence(evidence, input_budget.for_provider("bundled", max_tokens=output, manager=mgr))
        context_receipts["input_budget"] = evidence["input_budget"]
    try:
        if provider == "lmstudio":
            model_info = choose_model("lmstudio", req.message)
            evidence = documents.fit_evidence(evidence, input_budget.for_provider("lmstudio", max_tokens=output, provider=S.lm_provider, model_id=model_info["id"]))
            context_receipts["input_budget"] = evidence["input_budget"]
            result = S.lm_provider.complete(messages=evidence["messages"], model_id=model_info["id"],
                                           temperature=req.temperature if req.temperature is not None else 0.2,
                                           max_tokens=output, allow_redirects=False, enforce_text_budget=True)
            # The real LM Studio normalizer preserves its raw result but also
            # coerces content to text for older consumers. Documents require
            # actual text content; normalized-only fake providers stay usable.
            if "raw" in result:
                reply = documents.reply_text(result["raw"])
            else:
                text = result.get("text")
                reply = text.strip() if isinstance(text, str) else ""
            model = result.get("model") or model_info["id"]
        else:
            result = ai_routes._llama_post(base_url, {"model": "tli-bundled", "messages": evidence["messages"],
                         "temperature": req.temperature if req.temperature is not None else 0.2,
                         "max_tokens": output, "stream": False}, timeout_s=60, allow_redirects=False, expected_model=selected_model)
            reply = documents.reply_text(result)
            model = result.get("model") or selected_model or "tli-bundled"
        if not reply:
            raise ValueError("Empty document answer")
        context_receipts.update(chat_continuity.transport_receipts(result))
    except HTTPException as exc:
        if exc.status_code == 422:
            raise
        raise HTTPException(409 if exc.status_code == 409 else 502,
                            documents.PROVIDER_BUSY if exc.status_code == 409 else documents.PROVIDER_FAILURE) from exc
    except Exception as exc:
        raise HTTPException(502, documents.PROVIDER_FAILURE) from exc
    context_receipts = answer_evidence.complete({**chat_continuity.reference_receipts(req, evidence), **context_receipts, "evidence_context": evidence.get("evidence_context")}, reply)
    conv_id = _save_chat_turn(req, reply, model, provider=provider, host=shared_devices.node(),
                             document_context=evidence["document_context"], **context_receipts)
    return ChatResponse(reply=reply, model_used=model, brain_used=provider, timestamp=S.now_iso(),
                        conversation_id=conv_id, document_context=evidence["document_context"], handled_by="documents", **context_receipts, **chat_continuity.source_refs(conv_id))


def _notebook_reply(req, evidence):
    is_case = "case_context" in evidence
    if evidence.get("recorded_answer"):
        answer = evidence["recorded_answer"]
        receipts = {**chat_continuity.reference_receipts(req, evidence), "evidence_context": answer["evidence_context"]}
        conv_id = _save_chat_turn(req, answer["text"], "tli-records", provider="tli-records", **receipts)
        return ChatResponse(reply=answer["text"], model_used="tli-records", brain_used="tli-records", timestamp=S.now_iso(),
                            conversation_id=conv_id, handled_by="case_outcome", **receipts, **chat_continuity.source_refs(conv_id))
    cfg = S.load_node_config()
    if cfg and cfg.role == "member" and cfg.host_address:
        raise HTTPException(409, "Private selected references cannot use this mesh route. Use a provider on this TLI host.")
    output = req.max_tokens if req.max_tokens is not None else input_budget.DEFAULT_OUTPUT_TOKENS
    context_receipts = {"input_budget": input_budget.for_provider("unknown", max_tokens=output).validate(evidence["messages"])}
    try:
        brain = (req.brain or "").strip().lower()
        if brain in ("lmstudio", "lm_studio", "lm-studio", "lms", "openai"):
            model_info = choose_model(req.brain, req.message)
            context_receipts["input_budget"] = input_budget.for_provider("lmstudio", max_tokens=output, provider=S.lm_provider, model_id=model_info["id"]).validate(evidence["messages"])
            result = S.lm_provider.complete(messages=evidence["messages"], model_id=model_info["id"],
                                           temperature=req.temperature if req.temperature is not None else 0.2,
                                           max_tokens=output, allow_redirects=False, enforce_text_budget=True)
            text = result.get("text")
            reply = text.strip() if isinstance(text, str) else ""
            model, provider = result.get("model") or model_info["id"], "lmstudio"
        else:
            from ai import ai_routes
            mgr = ai_routes._notebook_runtime("case selections") if is_case else ai_routes._notebook_runtime()
            selected_model, base_url = mgr.active_preset_id, mgr.base_url
            context_receipts["input_budget"] = input_budget.for_provider("bundled", max_tokens=output, manager=mgr).validate(evidence["messages"])
            result = ai_routes._llama_post(base_url, {"model": "tli-bundled", "messages": evidence["messages"],
                         "temperature": req.temperature if req.temperature is not None else 0.2,
                         "max_tokens": output, "stream": False}, timeout_s=60, allow_redirects=False, expected_model=selected_model)
            reply = ai_routes._reference_reply_text(result, is_case=is_case)
            model, provider = result.get("model") or selected_model or "tli-bundled", "bundled"
        if not reply:
            raise HTTPException(502, f"The model returned no response. The {'case' if is_case else 'note'} question was not retried.")
        context_receipts.update(chat_continuity.transport_receipts(result))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"The {'case' if is_case else 'note'} question could not be completed. It was not retried or sent to another provider.") from exc
    context_receipts = answer_evidence.complete({**chat_continuity.reference_receipts(req, evidence), **context_receipts, "evidence_context": evidence.get("evidence_context")}, reply)
    metadata = {} if is_case else {"note_context": evidence["note_context"]}
    conv_id = _save_chat_turn(req, reply, model, provider=provider, host=shared_devices.node(), **metadata, **context_receipts)
    return ChatResponse(reply=reply, model_used=model, brain_used=provider, timestamp=S.now_iso(),
                        conversation_id=conv_id, handled_by="case_context" if is_case else None, **metadata, **context_receipts, **chat_continuity.source_refs(conv_id))


@router.get("/memory/{user_id}")
def get_memory(user_id: str, _session: str = Depends(require_session)):
    if user_id != _session:
        raise HTTPException(404, "Memory not found.")
    return S.load_memory(user_id)


@router.post("/memory/add")
def add_memory(update: MemoryUpdate, session_user: str = Depends(require_session)):
    # Always write to the session user — ignore any user_id in the body
    fact_obj = shared_memory.save_fact(session_user, update.fact, category=update.category or "general", device_id=update.device_id)
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
@S.conversation_transaction
def delete_conversation(conv_id: str, session_user: str = Depends(require_session)):
    conversations = S.load_conversations()
    conv = conversations.get(conv_id)
    if conv and conv.get("user_id") != session_user:
        raise HTTPException(status_code=403, detail="Access denied")
    existed = conv_id in conversations
    if existed:
        assert_idle([conv_id])
        conversations.pop(conv_id, None)
        S.save_conversations(conversations)
    return {"ok": True, "existed": existed}
