"""Text inference for specialist screens, without chat tools or state changes.

The caller supplies a reviewed provider binding. This adapter never starts a
runtime, selects a model, invokes intents, follows redirects or falls back to
another provider. Prompt text and answers are not persisted here.
"""
from __future__ import annotations

import hashlib
import json
from contextlib import nullcontext
from dataclasses import dataclass
from urllib.parse import urlparse

import requests
from fastapi import HTTPException

import tli_state as S
from intelligence import input_budget


@dataclass(frozen=True)
class Binding:
    provider: str
    model: str
    url: str
    identity: str
    adapter: object

    @property
    def key(self):
        return hashlib.sha256(json.dumps([self.provider, self.model, self.url, self.identity]).encode()).hexdigest()

    def public(self):
        try:
            host = urlparse(self.url).hostname
        except ValueError:
            host = None
        return {"provider": self.provider, "model": self.model, "provider_key": self.key,
                "label": "Integrated AI" if self.provider == "bundled" else "LM Studio",
                "checked_at": S.now_iso(), "readiness": "not_tested", "inference_host": host}


def bind(provider="bundled"):
    if provider == "bundled":
        from ai.ai_manager import BundledAIManager
        manager = BundledAIManager.get()
        return Binding(provider, manager.active_preset_id,
                       manager.base_url.rstrip("/") + "/v1/chat/completions",
                       str(manager.cfg.model_path), manager)
    if provider == "lmstudio":
        adapter = S.lm_provider
        model = (S.MODEL_CONFIG.get(S.DEFAULT_MODEL_KEY) or {}).get("id")
        if not isinstance(model, str) or not model.strip() or len(model) > 256:
            raise HTTPException(409, "Select an LM Studio model in Settings before requesting advice.")
        return Binding(provider, model, adapter.chat_url, str(id(adapter)), adapter)
    raise HTTPException(422, "Choose Integrated AI or LM Studio for this advice.")


def prepare(provider, provider_key, messages, *, max_tokens=1000):
    selected = bind(provider)
    if provider_key is not None and selected.key != provider_key:
        raise HTTPException(409, "The selected AI model or endpoint changed. Check the provider again before retrying.")
    budget = input_budget.for_provider(selected.provider, manager=selected.adapter,
                                      provider=selected.adapter, model_id=selected.model,
                                      max_tokens=max_tokens).validate(messages)
    return selected, budget


def stream(selected, messages, *, max_tokens=1000):
    """Yield only text deltas. A terminal marker and nonempty content are required."""
    guard = selected.adapter.generation() if selected.provider == "bundled" else nullcontext()
    with guard:
        current, _ = prepare(selected.provider, selected.key, messages, max_tokens=max_tokens)
        if selected.provider == "bundled" and not current.adapter.is_healthy():
            raise HTTPException(503, "Integrated AI is unavailable. Start it in AI settings or choose an available LM Studio provider.")
        payload = {"model": "local" if selected.provider == "bundled" else selected.model,
                   "messages": messages, "temperature": 0.25, "max_tokens": max_tokens, "stream": True}
        received = completed = False
        output_size = 0
        try:
            with requests.post(current.url, json=payload, stream=True, timeout=(3, 90), allow_redirects=False) as response:
                if not 200 <= response.status_code < 300:
                    raise HTTPException(502, "The selected AI provider rejected the advice request. Check its availability and selected model.")
                for raw in response.iter_lines(chunk_size=1):
                    line = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
                    if not line or not line.startswith("data:"):
                        continue
                    body = line[5:].strip()
                    if body == "[DONE]":
                        completed = True
                        break
                    if len(body) > 65536:
                        raise HTTPException(502, "The AI provider returned an oversized stream event.")
                    try:
                        data = json.loads(body)
                        if data.get("error"):
                            raise HTTPException(502, "The selected AI provider reported an error.")
                        if selected.provider == "lmstudio" and data.get("model") and data["model"] != selected.model:
                            raise HTTPException(502, "LM Studio answered with a different model than the reviewed selection. Check its selected model before retrying.")
                        choices = data.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        if choice.get("finish_reason") in ("length", "content_filter"):
                            raise HTTPException(502, "The AI reply ended before complete advice was produced.")
                        delta = choice.get("delta") or {}
                        text = delta.get("content")
                    except (ValueError, TypeError, AttributeError, IndexError):
                        raise HTTPException(502, "The AI provider returned an unreadable stream event.") from None
                    if isinstance(text, str) and text:
                        output_size += len(text)
                        if output_size > 24000:
                            raise HTTPException(502, "The AI reply exceeded the local output limit.")
                        received = True
                        yield text
        except requests.RequestException:
            raise HTTPException(503, "The selected AI provider could not complete the request. Retry when it is available.") from None
        if not completed or not received:
            raise HTTPException(502, "The AI stream ended without complete advice.")
