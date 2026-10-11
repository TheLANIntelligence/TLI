"""Read-only, heuristic text budgets. Never starts or probes a model.

The configured context is not a tokenizer measurement or a guarantee of fit.
Unknown providers retain the existing character ceiling. Formatting and output
allowances are explicit, and selected reference text is never silently cut.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import HTTPException

MAX_CHARS = 12000
DEFAULT_OUTPUT_TOKENS = 1024
TEMPLATE_ALLOWANCE = 64
MESSAGE_ALLOWANCE = 12
_ASCII_WORDS = re.compile(r"[A-Za-z0-9\s]+", re.ASCII)


def _positive(value, ceiling=1_000_000):
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value <= ceiling


def estimate_text(text):
    """Conservative planning heuristic, deliberately not named a token count.

    Ordinary ASCII words/spacing use three characters per estimated token.
    Punctuation uses one per character; non-ASCII uses one per UTF-8 byte.
    This reduces the optimistic English-only bias for code and multilingual text.
    """
    if not isinstance(text, str):
        raise HTTPException(422, "This input budget supports text messages only.")
    try:
        raw_size = len(text.encode("utf-8", errors="strict"))
    except UnicodeError:
        raise HTTPException(422, "The question and selected text must contain valid UTF-8.") from None
    estimated = raw_size
    for match in _ASCII_WORDS.finditer(text):
        size = len(match.group())
        estimated -= size - math.ceil(size / 3)
    return estimated


def text_usage(messages):
    if not isinstance(messages, (list, tuple)) or not messages or len(messages) > 128:
        raise HTTPException(422, "Provide a bounded list of text messages.")
    characters = utf8_bytes = estimated = 0
    for item in messages:
        if not isinstance(item, dict) or item.get("role") not in ("system", "user", "assistant"):
            raise HTTPException(422, "This input budget supports system, user and assistant text messages only.")
        text = item.get("content")
        estimated += estimate_text(text)
        characters += len(text)
        utf8_bytes += len(text.encode("utf-8"))
    allowance = TEMPLATE_ALLOWANCE + MESSAGE_ALLOWANCE * len(messages)
    return {"input_characters": characters, "input_utf8_bytes": utf8_bytes,
            "estimated_input_tokens": estimated + allowance,
            "formatting_allowance_tokens": allowance}


@dataclass(frozen=True)
class TextBudget:
    provider: str = "unknown"
    model: str | None = None
    context_tokens: int | None = None
    capacity_source: str = "unavailable"
    max_tokens: int = DEFAULT_OUTPUT_TOKENS
    character_limit: int = MAX_CHARS

    def __post_init__(self):
        if not _positive(self.max_tokens):
            raise HTTPException(422, "The response limit must be a positive whole number of tokens.")
        if not _positive(self.character_limit, MAX_CHARS):
            raise ValueError("Invalid local text ceiling")
        if self.context_tokens is not None and not _positive(self.context_tokens):
            raise ValueError("Invalid configured context")

    @property
    def input_token_allowance(self):
        return None if self.context_tokens is None else self.context_tokens - self.max_tokens

    def fits(self, messages):
        usage = text_usage(messages)
        return (usage["input_characters"] <= self.character_limit and
                (self.context_tokens is None or usage["estimated_input_tokens"] + self.max_tokens <= self.context_tokens))

    def validate(self, messages):
        usage = text_usage(messages)
        if usage["input_characters"] > self.character_limit:
            raise HTTPException(422, "This question, instructions and formatted reference text exceed the local text limit. Shorten the question or select fewer notes or shorter document excerpts. Nothing was shortened or sent.")
        if self.context_tokens is not None and usage["estimated_input_tokens"] + self.max_tokens > self.context_tokens:
            raise HTTPException(422, "This text request is estimated to exceed the selected model's configured context after reserving room for its answer. Shorten the question, remove selected context, or reduce the response limit. Nothing was shortened or sent.")
        return {"version": 1, "provider": self.provider, "model": self.model,
                "capacity_status": "configured" if self.context_tokens is not None else "unknown",
                "context_tokens": self.context_tokens, "capacity_source": self.capacity_source,
                "reserved_output_tokens": self.max_tokens, "character_limit": self.character_limit,
                **usage, "estimation": "heuristic", "fit": "estimated" if self.context_tokens is not None else "unknown",
                "checked_at": datetime.now(timezone.utc).isoformat()}


def for_provider(name, *, max_tokens=None, manager=None, provider=None, model_id=None, character_limit=MAX_CHARS):
    """Only consume an explicit adapter's local metadata; no network discovery.

    Call again inside the existing generation guard immediately before transport,
    since a previous calculation cannot authorize a different runtime/model.
    """
    name = name if name in ("bundled", "lmstudio") else "unknown"
    output = DEFAULT_OUTPUT_TOKENS if max_tokens is None else max_tokens
    adapter = manager if name == "bundled" else provider if name == "lmstudio" else None
    capacity = None
    method = getattr(adapter, "text_capacity", None)
    if callable(method):
        try:
            capacity = method() if name == "bundled" else method(model_id)
        except Exception:
            capacity = None  # unreadable capacity is unknown, not compatible
    context = None
    source = "unavailable"
    model = model_id if isinstance(model_id, str) and 0 < len(model_id) <= 256 else None
    if isinstance(capacity, dict):
        reported = capacity.get("model")
        matches = name == "bundled" or not model or reported == model
        if isinstance(reported, str) and 0 < len(reported) <= 256 and (name == "bundled" or not model):
            model = reported
        # Current adapters expose configuration only. Never promote listed model
        # limits, selected presets, or unknown third-party fields to actual fit.
        if name == "bundled" and matches and capacity.get("status") == "configured" and capacity.get("source") == "owned_runtime_launch" and _positive(capacity.get("context_tokens")):
            context, source = capacity["context_tokens"], "owned_runtime_launch"
    return TextBudget(name, model, context, source, output, character_limit)


def public_receipt(value):
    """Project additive retained metadata; never retain prompts or raw provider data."""
    if not isinstance(value, dict):
        return None
    try:
        context = value.get("context_tokens")
        if value.get("version") != 1 or isinstance(value.get("version"), bool):
            return None
        if value.get("provider") not in ("bundled", "lmstudio", "unknown") or value.get("estimation") != "heuristic":
            return None
        model = value.get("model")
        if model is not None and (not isinstance(model, str) or not 0 < len(model) <= 256):
            return None
        status = "configured" if context is not None else "unknown"
        source = "owned_runtime_launch" if context is not None else "unavailable"
        if value.get("capacity_status") != status or value.get("capacity_source") != source or value.get("fit") != ("estimated" if context is not None else "unknown"):
            return None
        if context is not None and not _positive(context):
            return None
        fields = ("reserved_output_tokens", "character_limit", "input_characters", "input_utf8_bytes", "estimated_input_tokens", "formatting_allowance_tokens")
        if any(not _positive(value.get(key)) for key in fields):
            return None
        if value["character_limit"] > MAX_CHARS or value["input_characters"] > value["character_limit"] or value["input_utf8_bytes"] < value["input_characters"]:
            return None
        allowance = value["formatting_allowance_tokens"]
        if (value["input_utf8_bytes"] > value["input_characters"] * 4 or
                not TEMPLATE_ALLOWANCE + MESSAGE_ALLOWANCE <= allowance <= TEMPLATE_ALLOWANCE + MESSAGE_ALLOWANCE * 128 or
                (allowance - TEMPLATE_ALLOWANCE) % MESSAGE_ALLOWANCE or
                value["estimated_input_tokens"] > value["input_utf8_bytes"] + allowance):
            return None
        if value["estimated_input_tokens"] < value["formatting_allowance_tokens"] or (context is not None and value["estimated_input_tokens"] + value["reserved_output_tokens"] > context):
            return None
        checked = value.get("checked_at")
        if not isinstance(checked, str) or len(checked) > 64 or datetime.fromisoformat(checked.replace("Z", "+00:00")).tzinfo is None:
            return None
        return {key: value[key] for key in ("version", "provider", "model", "capacity_status", "context_tokens", "capacity_source",
                                          *fields, "estimation", "fit", "checked_at")}
    except (ValueError, TypeError, KeyError):
        return None
