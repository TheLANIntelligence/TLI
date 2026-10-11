"""Requester-owned conversation continuity for explicitly selected LAN inference."""
from __future__ import annotations

import math
from contextlib import closing

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

import lan_inference
from companion_auth import operation_access
from intelligence import answer_evidence, chat_continuity, context, input_budget


class Selection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    peer_id: str = Field(min_length=1, max_length=128)
    trust_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    resource_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    resource_revision: str = Field(pattern=r"^[a-f0-9]{64}$")


def validate_request(req):
    """Reject unsupported sharing before reading any selected private reference."""
    if req.lan_inference is None:
        return
    if any((req.image_b64, req.screenshot, req.documents, req.note_refs, req.case_ref,
            req.include_vault_secrets, req.secret_keys)):
        raise HTTPException(409, "LAN inference currently supports text with your saved-note and conversation-history settings. Remove selected images, documents, notes, cases and Vault secrets before using LAN inference.")
    if not 1 <= req.max_tokens <= 2048 or not math.isfinite(req.temperature) or not 0 <= req.temperature <= 2:
        raise HTTPException(422, "LAN inference requires 1–2048 output tokens and a temperature between 0 and 2.")


def response_events(request, value, user_text, conv_id, *, device_id, active_panel,
                    target_id, diagnostic_id, max_tokens, temperature,
                    use_saved_memory, use_conversation_history, build_prompt, save_turn):
    """Send prepared text only; the worker never owns a user session or executes tools."""
    user = context.request_user(request)
    check = operation_access(request, user)
    check()
    selected = lan_inference.selection(value.model_dump() if hasattr(value, "model_dump") else value)
    evidence = chat_continuity.prepare(
        user, user_text, conv_id, build_prompt(device_id=device_id, active_panel=active_panel),
        target_id=target_id, diagnostic_id=diagnostic_id, device_id=device_id,
        use_saved_memory=use_saved_memory, use_conversation_history=use_conversation_history,
        budget=input_budget.for_provider("unknown", max_tokens=max_tokens))
    check()
    receipts = chat_continuity.receipts(evidence)
    save_turn(conv_id, "user", user_text)
    peer = selected["peer"]
    metadata = None
    chunks = []
    size = 0
    with closing(lan_inference.stream(selected, evidence["messages"], max_tokens=max_tokens,
                                      temperature=temperature, check=check)) as events:
        for event in events:
            check()
            kind = event.get("type")
            if kind == "meta" and metadata is None and not chunks:
                if event.get("peer") != peer or not isinstance(event.get("model"), str) or not event["model"]:
                    raise HTTPException(502, "LAN inference returned invalid model identity.")
                metadata = {"type": "meta", "session_id": conv_id, "conversation_id": conv_id,
                            "provider": "lan", "handled_by": "lan_inference", "model": event["model"],
                            "inference_host": peer, "host": evidence["host"]}
                yield metadata
            elif kind == "delta" and metadata is not None and isinstance(event.get("text"), str):
                size += len(event["text"].encode("utf-8"))
                if size > 131072:
                    raise HTTPException(502, "LAN inference exceeded the answer size limit.")
                chunks.append(event["text"])
                yield {"type": "delta", "text": event["text"]}
            elif kind == "done" and metadata is not None:
                reply = "".join(chunks).strip()
                if not reply:
                    raise HTTPException(502, "LAN inference returned an empty answer.")
                receipts = answer_evidence.complete(receipts, reply)
                check()
                save_turn(conv_id, "assistant", reply, provider="lan", model=metadata["model"],
                          host=evidence["host"], inference_host=peer, **receipts)
                check()
                yield {"type": "meta", **receipts, **chat_continuity.source_refs(conv_id)}
                yield {"type": "done"}
                return
            else:
                raise HTTPException(502, "LAN inference returned an invalid response.")
    raise HTTPException(502, "LAN inference was interrupted before completion. The request was not retried.")
