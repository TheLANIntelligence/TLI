"""Explicit reviewed LAN inference for the small-app Builder's text completion.

This adapter never reads projects, selects another model, or executes generated
code. The caller authorizes source sharing before preparing existing files.
"""
from __future__ import annotations

import copy
import json
from collections.abc import Callable
from contextlib import closing

from fastapi import HTTPException

import lan_inference
from ai.lan_chat import Selection
from .llm_client import ModelOffline


Completion = Callable[[list[dict[str, str]], float, int], tuple[str, str]]
_META_FIELDS = {"type", "protocol", "peer", "identity_fingerprint", "resource_id", "resource_revision", "provider", "model"}


def _source_consent(messages: list[dict[str, str]], allowed: bool) -> None:
    if allowed:
        return
    # web_apps uses a structured user message for retained app files. Generated
    # assistant text in a validation-repair attempt is already part of this job.
    for message in messages:
        if message["role"] != "user":
            continue
        try:
            value = json.loads(message["content"])
        except (ValueError, TypeError):
            continue
        if isinstance(value, dict) and "previous_files" in value:
            raise ValueError("Review and explicitly allow sharing this app's existing source with the selected LAN computer before revising it.")


def completion(selection: Selection, *, check: Callable[[], None],
               allow_existing_source: bool = False) -> Completion:
    """Bind an explicit selection and return a callable compatible with _chat.

    Pass the result of operation_access(request, owner) as check. Access is
    rechecked for every invocation and event, including completion. The existing
    LAN token bound applies even when the Builder asks for a larger completion.
    A transport failure becomes ModelOffline so the app retains its last good
    revision; access revocation is re-raised unchanged to the request boundary.

    allow_existing_source is a secondary guard. The authenticated caller must
    check the user's opt-in *before* generate_app reads a retained app revision.
    """
    if not isinstance(selection, Selection) or not callable(check) or type(allow_existing_source) is not bool:
        raise ValueError("Choose an explicit LAN model and provide the authenticated operation check.")
    check()
    value = Selection.model_validate(selection.model_dump()).model_dump()
    # Initial binding is local trust validation, not a model call or discovery.
    lan_inference.selection(value)
    check()

    def complete(messages: list[dict[str, str]], temperature: float, max_tokens: int) -> tuple[str, str]:
        access_failure: Exception | None = None

        def recheck() -> None:
            nonlocal access_failure
            try:
                check()
            except Exception as exc:
                access_failure = exc
                raise

        recheck()
        if type(max_tokens) is not int or max_tokens < 1:
            raise ValueError("Choose a positive integer output-token limit.")
        bounded_tokens = min(max_tokens, lan_inference.MAX_TOKENS)
        # Central validation refuses tool/image messages and oversized contexts;
        # nothing is silently shortened to fit the selected peer.
        try:
            lan_inference._validate_messages(messages, bounded_tokens, temperature)
        except HTTPException as exc:
            raise ValueError("The prepared app request exceeds or violates the LAN text-only input limits. Nothing was sent.") from exc
        prepared = copy.deepcopy(messages)
        _source_consent(prepared, allow_existing_source)
        chunks: list[str] = []
        produced = 0
        metadata = None
        count = 0
        try:
            selected = lan_inference.selection(copy.deepcopy(value))
            recheck()
            with closing(lan_inference.stream(selected, prepared, max_tokens=bounded_tokens,
                                              temperature=temperature, check=recheck)) as events:
                for event in events:
                    recheck()
                    count += 1
                    if count > 8192 or not isinstance(event, dict):
                        raise ValueError("The LAN model returned an invalid or oversized event sequence.")
                    kind = event.get("type")
                    if kind == "meta" and metadata is None and not chunks:
                        if (set(event) != _META_FIELDS or event["protocol"] != lan_inference.PROTOCOL
                                or event["peer"] != selected["peer"]
                                or event["resource_id"] != value["resource_id"]
                                or event["resource_revision"] != value["resource_revision"]
                                or not lan_inference._hash(event["identity_fingerprint"])
                                or event["provider"] not in ("bundled", "lmstudio")
                                or not lan_inference._text(event["model"])
                                or lan_inference._resource_id(event["provider"], event["model"]) != value["resource_id"]):
                            raise ValueError("The LAN model identity did not match the reviewed selection.")
                        metadata = event
                    elif kind == "delta" and metadata is not None and set(event) == {"type", "text"} and isinstance(event["text"], str):
                        produced += len(event["text"].encode("utf-8", errors="strict"))
                        if produced > lan_inference.MAX_OUTPUT:
                            raise ValueError("The LAN model exceeded the bounded output size.")
                        chunks.append(event["text"])
                    elif kind == "done" and metadata is not None and set(event) == {"type"}:
                        text = "".join(chunks).strip()
                        if not text:
                            raise ValueError("The LAN model returned an empty answer.")
                        recheck()
                        peer = selected["peer"]
                        backend = f"LAN · {peer['name']} ({peer['id']}) · {metadata['provider']}/{metadata['model']}"
                        return text, backend
                    else:
                        raise ValueError("The LAN model returned an error or unsupported response event.")
            raise ValueError("The LAN model stream ended before completion.")
        except Exception as exc:
            if access_failure is not None:
                raise access_failure
            detail = ""
            if isinstance(exc, HTTPException):
                detail = exc.detail if isinstance(exc.detail, str) else exc.detail.get("message", "") if isinstance(exc.detail, dict) else ""
            elif isinstance(exc, (ValueError, UnicodeError)):
                detail = str(exc)
            raise ModelOffline((detail[:600] + " " if detail else "The selected LAN computer could not finish the build. ") +
                               "No transport retry, local fallback, or tool execution was performed.") from exc

    return complete
