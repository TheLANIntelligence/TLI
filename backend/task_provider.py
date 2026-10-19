"""Task reasoning adapters. A selected provider never silently falls back."""
from __future__ import annotations

import json
import os
import ipaddress
from urllib.parse import urlsplit
from contextlib import nullcontext
import httpx
from fastapi import HTTPException
from pydantic import ValidationError
import tli_state as S
from task_models import Provider, ToolStep, FinalStep, tool_definitions, validate_arguments

MAX_RESPONSE = 1024 * 1024
MAX_CONTEXT = 48000


def local_url(url):
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError()
        if parsed.hostname != "localhost" and not ipaddress.ip_address(parsed.hostname).is_loopback:
            raise ValueError()
        if not parsed.port:
            raise ValueError()
    except (ValueError, TypeError):
        raise HTTPException(409, "Local task inference must use a loopback model endpoint. Use an explicitly reviewed LAN provider for another computer.") from None
    return url


def binding(provider):
    provider = Provider.model_validate(provider)
    if provider.kind == "lan":
        if provider.selection is None:
            raise HTTPException(422, "Select a reviewed LAN model.")
        import lan_inference
        lan_inference.selection(provider.selection.model_dump())
    if provider.kind == "lmstudio":
        if not provider.model:
            raise HTTPException(422, "Select the exact LM Studio model ID.")
        return {"url": local_url(S.lm_provider.chat_url), "model": provider.model}
    if provider.kind == "bundled":
        from ai.ai_manager import BundledAIManager
        manager = BundledAIManager.get()
        return {"url": local_url(manager.base_url.rstrip("/") + "/v1/chat/completions"),
                "preset": manager._active_preset, "model_path": str(manager.cfg.model_path)}
    return provider.model_dump()


def parse_step(value):
    try:
        obj = json.loads(value) if isinstance(value, str) else value
        step = FinalStep.model_validate(obj) if isinstance(obj, dict) and obj.get("kind") == "final" else ToolStep.model_validate(obj)
        if isinstance(step, ToolStep):
            validate_arguments(step.tool, step.arguments)
        return step.model_dump()
    except (ValueError, TypeError, ValidationError) as exc:
        raise HTTPException(502, "The selected model returned an invalid task step. No proposed action was executed.") from exc


def post_json(url, payload, check, *, key=None):
    check()
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    try:
        with httpx.Client(trust_env=False, follow_redirects=False, timeout=httpx.Timeout(120, connect=8)) as client:
            with client.stream("POST", url, json=payload, headers=headers) as response:
                if response.status_code != 200:
                    raise HTTPException(502, f"Selected model returned HTTP {response.status_code}. No fallback was used.")
                output = bytearray()
                for chunk in response.iter_bytes():
                    check()
                    output.extend(chunk)
                    if len(output) > MAX_RESPONSE:
                        raise HTTPException(502, "The model response exceeded the task limit.")
        check()
        return json.loads(output)
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, "The selected model request failed. No provider fallback or action retry occurred.") from exc


def complete(provider, messages, check):
    provider = Provider.model_validate(provider)
    if len(json.dumps(messages, ensure_ascii=False)) > MAX_CONTEXT:
        raise HTTPException(413, "Task context reached its limit. Review receipts and continue with a narrower task.")
    check()
    if provider.kind == "lan":
        if provider.selection is None:
            raise HTTPException(422, "Select a reviewed LAN model.")
        from builder.lan_compute import completion
        text, _ = completion(provider.selection, check=check, allow_existing_source=True)(messages, .1, 2048)
        return parse_step(text)
    if provider.kind == "openai":
        key = os.environ.get("TLI_OPENAI_API_KEY", "").strip()
        if not key or not provider.model:
            raise HTTPException(409, "Configure TLI_OPENAI_API_KEY on the host and select an OpenAI model before using cloud tasks.")
        payload = {"model": provider.model, "input": messages, "store": False,
                   "reasoning": {"effort": provider.reasoning}, "max_output_tokens": 8192,
                   "tools": tool_definitions(), "parallel_tool_calls": False}
        data = post_json("https://api.openai.com/v1/responses", payload, check, key=key)
        if data.get("status") != "completed":
            raise HTTPException(502, "Cloud reasoning did not complete. No action was executed.")
        calls = [item for item in data.get("output", []) if item.get("type") == "function_call"]
        if calls:
            if len(calls) != 1:
                raise HTTPException(502, "Expected one bounded task action.")
            try:
                args = json.loads(calls[0]["arguments"])
            except (KeyError, ValueError) as exc:
                raise HTTPException(502, "Malformed cloud tool arguments.") from exc
            return parse_step({"kind": "tool", "tool": calls[0]["name"], "arguments": args})
        text = "".join(part.get("text", "") for item in data.get("output", []) if item.get("type") == "message"
                       for part in item.get("content", []) if part.get("type") == "output_text")
        return parse_step(text)
    guard = nullcontext()
    if provider.kind == "bundled":
        from ai.ai_manager import BundledAIManager
        manager = BundledAIManager.get()
        if not manager.is_healthy():
            raise HTTPException(409, "Start the selected bundled model before running a task.")
        url = local_url(manager.base_url.rstrip("/") + "/v1/chat/completions")
        guard = manager.generation()
    else:
        if not provider.model:
            raise HTTPException(422, "Select the exact LM Studio model ID.")
        url = local_url(S.lm_provider.chat_url)
    payload = {"messages": messages, "max_tokens": 4096, "temperature": .1, "stream": False}
    if provider.model:
        payload["model"] = provider.model
    if provider.tool_mode == "native":
        payload["tools"] = [{"type": "function", "function": {k: v for k, v in item.items() if k != "type"}} for item in tool_definitions()]
        payload["parallel_tool_calls"] = False
    with guard:
        data = post_json(url, payload, check)
    check()
    if provider.kind == "lmstudio" and data.get("model") != provider.model:
        raise HTTPException(502, "The local provider answered with a different model. No action was executed.")
    try:
        choice = data["choices"][0]
        if choice.get("finish_reason") not in ("stop", "tool_calls"):
            raise ValueError("Incomplete generation")
        message = choice["message"]
        calls = message.get("tool_calls", [])
        if calls:
            if provider.tool_mode != "native" or len(calls) != 1:
                raise ValueError("Unsupported tool response")
            function = calls[0]["function"]
            return parse_step({"kind": "tool", "tool": function["name"], "arguments": json.loads(function["arguments"])})
        return parse_step(message["content"])
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise HTTPException(502, "The selected local model returned an incomplete or invalid task step.") from exc


def cloud_search(provider, query, check):
    key = os.environ.get("TLI_OPENAI_API_KEY", "").strip()
    if not key:
        raise HTTPException(409, "Cloud search is not configured.")
    data = post_json("https://api.openai.com/v1/responses", {
        "model": provider["model"], "store": False, "max_output_tokens": 2048,
        "input": "Search public sources for this query. Summarize evidence and cite sources. Query: " + query,
        "tools": [{"type": "web_search"}], "tool_choice": "required"}, check, key=key)
    if data.get("status") != "completed":
        raise HTTPException(502, "Web research did not complete.")
    parts = [part for item in data.get("output", []) if item.get("type") == "message" for part in item.get("content", [])]
    return {"text": "\n".join(p.get("text", "") for p in parts)[:12000],
            "sources": [a for p in parts for a in p.get("annotations", []) if a.get("type") == "url_citation"][:20]}
