"""Explicit, stateless model compute on an authenticated TLI computer.

The host owns conversation, memory and actions. This worker only forwards a
bounded prepared text request to an already available loopback model runtime.
"""
from __future__ import annotations

import copy
import http.client
import ipaddress
import json
import math
import re
import socket
import threading
import time
from contextlib import contextmanager, nullcontext
from urllib.parse import urlsplit

from fastapi import HTTPException

import node_identity
import peer_trust as P
import tli_state as S

PROTOCOL = "tli-peer-inference-v1"
MAX_OUTPUT = 128 * 1024
MAX_WIRE = 1024 * 1024
MAX_LINE = 16384
MAX_TOKENS = 2048
_SLOT = threading.Lock()
_HEX = re.compile(r"^[a-f0-9]{64}$")


def _exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        P.fail(422, "invalid_inference_request", "The inference request does not match its text-only contract.")


def _text(value, maximum=256):
    if not isinstance(value, str) or not 0 < len(value) <= maximum or any(ord(c) < 32 for c in value):
        return False
    try:
        value.encode("utf-8", errors="strict")
        return True
    except UnicodeError:
        return False


def _output_size(value):
    try:
        return len(value.encode("utf-8", errors="strict"))
    except UnicodeError:
        P.fail(502, "invalid_inference_text", "The inference response contained invalid Unicode text.")


def _hash(value):
    return isinstance(value, str) and _HEX.fullmatch(value) is not None


def _peer(card):
    return {"id": card["node_id"], "name": card["name"]}


def peers():
    """Saved authorized identities only; never discover, probe or load models."""
    found = []
    for ident in S.load_mesh_directory():
        try:
            _, card, _ = P.trusted(ident, "inference")
            found.append(_peer(card))
        except HTTPException:
            continue
    return {"protocol": PROTOCOL, "peers": sorted(found, key=lambda row: (row["name"].casefold(), row["id"]))}


def selection(value):
    _exact(value, {"peer_id", "trust_revision", "resource_id", "resource_revision"})
    if not _text(value["peer_id"], 128) or not all(_hash(value[k]) for k in ("trust_revision", "resource_id", "resource_revision")):
        P.fail(422, "invalid_inference_selection", "Select a reviewed computer and one of its advertised models.")
    _, card, revision = P.trusted(value["peer_id"], "inference")
    if revision != value["trust_revision"]:
        P.fail(409, "peer_changed", "The selected computer's trust changed. Review its models again.")
    return {**value, "peer": _peer(card)}


def _resource_id(provider, model):
    return P.digest({"provider": provider, "model_id": model})


def _public_resource(row):
    return {key: row[key] for key in ("id", "revision", "provider", "model_id", "label", "context_window")}


def _validate_resource(row):
    _exact(row, {"id", "revision", "provider", "model_id", "label", "context_window"})
    if (row["provider"] not in ("bundled", "lmstudio") or not _text(row["model_id"])
            or not _text(row["label"]) or not _hash(row["id"]) or not _hash(row["revision"])
            or row["id"] != _resource_id(row["provider"], row["model_id"])
            or (row["context_window"] is not None and (type(row["context_window"]) is not int or not 1 <= row["context_window"] <= 1_000_000))):
        P.fail(502, "invalid_inference_resource", "The peer supplied an invalid model resource.")
    return row


def models(peer_id, *, check=None):
    if not _text(peer_id, 128):
        P.fail(422, "invalid_peer_id", "Select one reviewed computer.")
    _, card, revision = P.trusted(peer_id, "inference")
    result = P.request(peer_id, "GET", "/agent/peer/inference", grant="inference", expected_revision=revision, check=check)
    if result.status_code == 404:
        P.fail(409, "peer_inference_unsupported", "Update TLI on the selected computer to enable trusted inference.")
    if not result.ok:
        P.fail(result.status_code if result.status_code in (403, 409, 429, 503) else 502,
               "peer_models_unavailable", "The selected computer could not provide authorized model resources.")
    try:
        value = result.json()
        if (not isinstance(value, dict) or set(value) != {"protocol", "peer", "identity_fingerprint", "resources", "checked_at"}
                or value["protocol"] != PROTOCOL or value["peer"] != _peer(card)
                or value["identity_fingerprint"] != card["identity_fingerprint"]
                or not isinstance(value["resources"], list) or len(value["resources"]) > 32
                or not _text(value["checked_at"], 128)):
            raise ValueError()
        resources = [_validate_resource(row) for row in value["resources"]]
        if len({row["id"] for row in resources}) != len(resources):
            raise ValueError()
    except (ValueError, TypeError, KeyError):
        P.fail(502, "invalid_peer_models", "The model response did not match the reviewed computer.")
    return {"protocol": PROTOCOL, "peer": _peer(card), "trust_revision": revision,
            "resources": resources, "checked_at": value["checked_at"]}


def _local_url(value, expected_path):
    """No DNS, proxy environment, credentials, remote origins or redirects."""
    try:
        parsed = urlsplit(value)
        host = "127.0.0.1" if parsed.hostname == "localhost" else parsed.hostname
        address = ipaddress.ip_address(host)
        if (not address.is_loopback or parsed.scheme not in ("http", "https") or parsed.username is not None
                or parsed.password is not None or parsed.path != expected_path or parsed.query or parsed.fragment):
            raise ValueError()
        port = (443 if parsed.scheme == "https" else 80) if parsed.port is None else parsed.port
        if not 1 <= port <= 65535:
            raise ValueError()
        hostpart = f"[{address}]" if address.version == 6 else str(address)
        return f"{parsed.scheme}://{hostpart}:{port}{expected_path}"
    except (ValueError, TypeError, AttributeError):
        P.fail(409, "local_inference_required", "Only an already configured loopback model server can supply LAN inference.")


@contextmanager
def _local_response(url, method="GET", payload=None, *, check=lambda: None, before_send=None, seconds=8):
    parsed = urlsplit(url)
    connection = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    conn = connection(parsed.hostname, parsed.port, timeout=5)
    timer = None
    expired = threading.Event()
    started = time.monotonic()
    try:
        check()
        conn.connect()
        sock = conn.sock
        remaining = seconds - (time.monotonic() - started)
        if remaining <= 0:
            P.fail(504, "inference_timeout", "The local model did not respond before its deadline.")
        sock.settimeout(min(90, remaining))
        def expire():
            expired.set()
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        timer = threading.Timer(remaining, expire)
        timer.daemon = True
        timer.start()
        check()
        if before_send is not None:
            before_send()
        check()
        raw = P.canonical(payload) if payload is not None else None
        conn.request(method, parsed.path, body=raw, headers={"Content-Type": "application/json", "Accept": "text/event-stream" if method == "POST" else "application/json"})
        response = conn.getresponse()
        if response.status != 200:
            P.fail(503 if response.status in (404, 503) else 502, "local_inference_unavailable", "The selected local model rejected the request. No redirect or fallback was followed.")
        check()
        yield response
        if expired.is_set():
            P.fail(504, "inference_timeout", "The model inference deadline expired.")
    except HTTPException:
        raise
    except (TimeoutError, socket.timeout):
        P.fail(504, "inference_timeout", "The local model did not respond before its deadline.")
    except Exception:
        P.fail(504 if expired.is_set() else 503, "local_inference_unavailable", "The selected local model is unavailable. TLI did not request a model start or switch.")
    finally:
        if timer:
            timer.cancel()
        conn.close()


def _local_json(url, *, check=lambda: None):
    with _local_response(url, check=check) as response:
        raw = response.read(P.MAX_BODY + 1)
        if len(raw) > P.MAX_BODY:
            P.fail(502, "model_catalog_limit", "The local model catalogue exceeded its bound.")
        try:
            return json.loads(raw)
        except (ValueError, UnicodeError):
            P.fail(502, "invalid_model_catalog", "The local model catalogue was invalid.")


def _bundled_binding(manager):
    capacity = manager.text_capacity()
    process = getattr(manager, "_proc", None)
    command = getattr(process, "args", None)
    if (capacity.get("status") != "configured" or capacity.get("source") != "owned_runtime_launch"
            or capacity.get("model") != manager.active_preset_id or process is None or process.poll() is not None
            or type(capacity.get("context_tokens")) is not int or not 1 <= capacity["context_tokens"] <= 1_000_000
            or not isinstance(command, (list, tuple))):
        P.fail(409, "owned_runtime_required", "LAN inference requires the selected bundled model to be running in TLI's own verified runtime.")
    for flag, expected in (("--model", str(manager.cfg.model_path)), ("--host", manager.cfg.host), ("--port", str(manager.cfg.port))):
        if command.count(flag) != 1 or command.index(flag) + 1 >= len(command) or str(command[command.index(flag) + 1]) != expected:
            P.fail(409, "owned_runtime_required", "The bundled listener no longer matches the model runtime launched by TLI.")
    return {"url": _local_url(manager.base_url.rstrip("/") + "/v1/chat/completions", "/v1/chat/completions"),
            "model": manager.active_preset_id, "path": str(manager.cfg.model_path),
            "process": process.pid, "context": capacity["context_tokens"]}


def _lm_binding():
    provider = S.lm_provider
    chat = _local_url(provider.chat_url, "/v1/chat/completions")
    listed = _local_url(provider.models_url, "/v1/models")
    if chat.rsplit("/v1/", 1)[0] != listed.rsplit("/v1/", 1)[0]:
        P.fail(409, "local_inference_required", "LM Studio chat and model discovery must use the same configured loopback server.")
    return {"url": chat, "catalog_url": listed.rsplit("/v1/", 1)[0] + "/api/v1/models"}


def _revalidate_loaded(resource, check):
    """Check the exact external instance again immediately before sending text.

    LM Studio owns its server-side JIT setting; this read cannot lock that other
    process. Disable JIT there to require unloaded instances to fail closed.
    """
    check()
    if resource["provider"] != "lmstudio":
        return
    value = _local_json(resource["_binding"]["catalog_url"], check=check)
    models = value.get("models") if isinstance(value, dict) else None
    if isinstance(models, list) and len(models) <= 512:
        for model in models:
            if not isinstance(model, dict) or model.get("type") != "llm" or model.get("key") != resource["_model_key"]:
                continue
            instances = model.get("loaded_instances")
            if not isinstance(instances, list) or len(instances) > 32:
                continue
            for instance in instances:
                if not isinstance(instance, dict) or instance.get("id") != resource["model_id"] or not isinstance(instance.get("config"), dict):
                    continue
                revision = P.digest({**resource["_binding"], "key": model["key"], "instance": instance["id"], "config": instance["config"]})
                if revision == resource["revision"]:
                    check()
                    return
    P.fail(409, "inference_resource_changed", "The selected LM Studio instance unloaded or changed before sending. Refresh its model resources.")


def _resources(*, check=lambda: None, include_bundled=True):
    rows = []
    if include_bundled:
        # A lightweight Node has no bundled runtime lifecycle or filesystem.
        # Keep this import inside the full-host branch, including on catalog reads.
        from ai.ai_manager import BundledAIManager, MODEL_PRESETS
        manager = BundledAIManager.get()
        try:
            binding = _bundled_binding(manager)  # validate origin before even health probes
            check()
            health_path = manager.cfg.health_path
            health_url = _local_url(manager.base_url.rstrip("/") + health_path, health_path)
            if not manager._transition and isinstance(_local_json(health_url, check=check), dict):
                if _bundled_binding(manager) != binding:
                    raise ValueError()
                model = manager.active_preset_id
                if not _text(model):
                    raise ValueError()
                row = {"id": _resource_id("bundled", model), "revision": P.digest(binding), "provider": "bundled", "model_id": model,
                       "label": MODEL_PRESETS.get(model, {}).get("name", model), "context_window": binding["context"],
                       "_binding": binding, "_manager": manager, "_upstream_model": "tli-bundled"}
                _validate_resource(_public_resource(row))
                rows.append(row)
        except (HTTPException, AttributeError, ValueError, TypeError):
            check()
    try:
        binding = _lm_binding()
        value = _local_json(binding["catalog_url"], check=check)
        listed = value.get("models") if isinstance(value, dict) else None
        if not isinstance(listed, list) or len(listed) > 512:
            raise ValueError()
        for model in listed:
            if not isinstance(model, dict) or model.get("type") != "llm" or not _text(model.get("key")):
                continue
            instances = model.get("loaded_instances")
            if not isinstance(instances, list) or len(instances) > 32:
                continue
            for instance in instances:
                if not isinstance(instance, dict) or not _text(instance.get("id")) or not isinstance(instance.get("config"), dict):
                    continue
                config = instance["config"]
                context = config.get("context_length")
                if type(context) is not int or not 1 <= context <= 1_000_000:
                    context = None
                stamp = {**binding, "key": model["key"], "instance": instance["id"], "config": config}
                row = {"id": _resource_id("lmstudio", instance["id"]), "revision": P.digest(stamp), "provider": "lmstudio",
                       "model_id": instance["id"], "label": model.get("display_name") if _text(model.get("display_name")) else instance["id"],
                       "context_window": context, "_binding": binding, "_upstream_model": instance["id"], "_model_key": model["key"]}
                rows.append(row)
                if len(rows) >= 32:
                    break
            if len(rows) >= 32:
                break
    except (HTTPException, AttributeError, ValueError, TypeError):
        check()
    check()
    unique = {row["id"]: row for row in rows}
    return list(unique.values())


def capability(access, *, resource_loader=None):
    check = lambda: P.revalidate(access)
    check()
    rows = (resource_loader or _resources)(check=check)
    cfg = S.load_node_config()
    check()
    return {"protocol": PROTOCOL, "peer": {"id": cfg.node_id, "name": cfg.node_name},
            "identity_fingerprint": node_identity.fingerprint(), "resources": [_public_resource(row) for row in rows], "checked_at": S.now_iso()}


def _validate_messages(messages, max_tokens, temperature):
    if not isinstance(messages, list) or not 1 <= len(messages) <= 128:
        P.fail(422, "invalid_inference_messages", "Provide a bounded list of prepared text messages.")
    for message in messages:
        _exact(message, {"role", "content"})
        if message["role"] not in ("system", "user", "assistant") or not isinstance(message["content"], str):
            P.fail(422, "text_inference_only", "LAN inference accepts only system, user and assistant text. Tools and images are not supported.")
    if type(max_tokens) is not int or not 1 <= max_tokens <= MAX_TOKENS:
        P.fail(422, "inference_token_limit", "Choose an output limit between 1 and 2048 tokens.")
    if type(temperature) not in (int, float) or not math.isfinite(temperature) or not 0 <= temperature <= 2:
        P.fail(422, "inference_temperature", "Choose a finite temperature between 0 and 2.")
    try:
        if len(P.canonical(messages)) > P.MAX_BODY - 1024:
            P.fail(413, "peer_body_limit", "The prepared context exceeds the inference input limit. Nothing was shortened or sent.")
    except (UnicodeError, ValueError):
        P.fail(422, "invalid_inference_text", "Prepared context must contain valid UTF-8 text.")


def _events(lines):
    """Bounded SSE parser shared by the upstream and signed peer transports."""
    data = []
    frame_bytes = total = count = 0
    for raw in lines:
        if not isinstance(raw, bytes) or len(raw) > MAX_LINE:
            P.fail(502, "invalid_inference_stream", "The inference stream contained an oversized or invalid line.")
        total += len(raw)
        if total > MAX_WIRE:
            P.fail(502, "inference_stream_limit", "The inference stream exceeded its wire limit.")
        try:
            line = raw.decode("utf-8", errors="strict").rstrip("\r\n")
        except UnicodeError:
            P.fail(502, "invalid_inference_stream", "The inference stream contained invalid UTF-8.")
        if not line:
            if data:
                count += 1
                if count > 8192:
                    P.fail(502, "inference_stream_limit", "The inference stream contained too many events.")
                yield "\n".join(data)
            data, frame_bytes = [], 0
        elif line.startswith("data:"):
            part = line[5:]
            if part.startswith(" "):
                part = part[1:]
            frame_bytes += len(raw)
            if frame_bytes > MAX_LINE:
                P.fail(502, "inference_stream_limit", "The inference event exceeded its bound.")
            data.append(part)
        elif not line.startswith((":", "event:", "id:", "retry:")):
            P.fail(502, "invalid_inference_stream", "The inference stream had invalid event framing.")
    if data:
        P.fail(502, "inference_interrupted", "The inference stream ended inside an event. No retry was sent.")


def _response_lines(response):
    while True:
        line = response.readline(MAX_LINE + 1)
        if not line:
            return
        yield line


def _upstream(resource, messages, max_tokens, temperature, check):
    payload = {"model": resource["_upstream_model"], "messages": messages, "max_tokens": max_tokens,
               "temperature": temperature, "stream": True}
    finish = False
    produced = 0
    with _local_response(resource["_binding"]["url"], "POST", payload, check=check,
                         before_send=lambda: _revalidate_loaded(resource, check), seconds=120) as response:
        if response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "text/event-stream":
            P.fail(502, "invalid_model_stream", "The selected local model did not return an event stream.")
        for raw in _events(_response_lines(response)):
            check()
            if raw == "[DONE]":
                if not finish:
                    P.fail(502, "inference_interrupted", "The model ended without completing its answer.")
                yield {"type": "done"}
                return
            try:
                value = json.loads(raw)
                if not isinstance(value, dict) or value.get("error"):
                    raise ValueError()
                if resource["provider"] == "lmstudio" and value.get("model") not in (resource["model_id"], resource.get("_model_key")):
                    raise ValueError()
                choices = value.get("choices")
                if not isinstance(choices, list) or len(choices) > 1:
                    raise ValueError()
                if not choices:  # optional usage-only frame
                    continue
                choice = choices[0]
                delta = choice.get("delta")
                if not isinstance(delta, dict) or delta.get("tool_calls") or delta.get("function_call"):
                    raise ValueError()
                content = delta.get("content")
                if content is not None and not isinstance(content, str):
                    raise ValueError()
                reason = choice.get("finish_reason")
                if reason not in (None, "stop", "length") or (finish and content):
                    raise ValueError()
            except (ValueError, TypeError, KeyError, AttributeError):
                P.fail(502, "invalid_model_stream", "The selected local model returned an unsupported inference event.")
            if content:
                produced += _output_size(content)
                if produced > MAX_OUTPUT:
                    P.fail(502, "inference_output_limit", "The model answer exceeded its output limit.")
                yield {"type": "delta", "text": content}
            finish = finish or reason in ("stop", "length")
    P.fail(502, "inference_interrupted", "The model response ended before its completion marker. No retry was sent.")


def worker_stream(body, access, *, resource_loader=None):
    """No conversation, tool, action, model-start or persistent-memory access."""
    _exact(body, {"protocol", "resource_id", "resource_revision", "messages", "max_tokens", "temperature"})
    if body["protocol"] != PROTOCOL or not _hash(body["resource_id"]) or not _hash(body["resource_revision"]):
        P.fail(422, "invalid_inference_request", "Review an advertised inference resource first.")
    _validate_messages(body["messages"], body["max_tokens"], body["temperature"])
    P.revalidate(access)
    if not _SLOT.acquire(blocking=False):
        P.fail(429, "inference_busy", "This computer is already serving a LAN inference request.")
    try:
        recheck = lambda: P.revalidate(access)
        resources = (resource_loader or _resources)(check=recheck)
        row = next((r for r in resources if r["id"] == body["resource_id"] and r["revision"] == body["resource_revision"]), None)
        if row is None:
            P.fail(409, "inference_resource_changed", "The selected model is unavailable or changed. Review its resources again; no model was started or switched.")
        manager = row.get("_manager")
        def check():
            P.revalidate(access)
            current = _bundled_binding(manager) if manager else _lm_binding()
            if current != row["_binding"] or (manager and manager._transition):
                P.fail(409, "inference_resource_changed", "The selected model configuration changed. Inference was stopped.")
        with manager.generation() if manager else nullcontext():
            check()
            if row["context_window"] is not None:
                from intelligence.input_budget import text_usage
                if text_usage(body["messages"])["estimated_input_tokens"] + body["max_tokens"] > row["context_window"]:
                    P.fail(422, "inference_context_limit", "The prepared context is estimated to exceed this model's configured context. Nothing was shortened or sent.")
            cfg = S.load_node_config()
            yield {"type": "meta", "protocol": PROTOCOL, "peer": {"id": cfg.node_id, "name": cfg.node_name},
                   "identity_fingerprint": node_identity.fingerprint(), "resource_id": row["id"], "resource_revision": row["revision"],
                   "provider": row["provider"], "model": row["model_id"]}
            upstream = _upstream(row, body["messages"], body["max_tokens"], body["temperature"], check)
            try:
                for event in upstream:
                    check()
                    yield event
            finally:
                upstream.close()
    finally:
        _SLOT.release()


def stream(selected, messages, *, max_tokens, temperature, check=None):
    chosen = selection({key: selected[key] for key in ("peer_id", "trust_revision", "resource_id", "resource_revision")})
    _, card, _ = P.trusted(chosen["peer_id"], "inference")
    _validate_messages(messages, max_tokens, temperature)
    body = {"protocol": PROTOCOL, "resource_id": chosen["resource_id"], "resource_revision": chosen["resource_revision"],
            "messages": copy.deepcopy(messages), "max_tokens": max_tokens, "temperature": temperature}
    lines = P.stream_request(chosen["peer_id"], json_body=body, expected_revision=chosen["trust_revision"], check=check)
    got_meta = False
    produced = 0
    try:
        for raw in _events(lines):
            if check is not None:
                check()
            try:
                event = json.loads(raw)
            except ValueError:
                P.fail(502, "invalid_peer_stream", "The peer returned an invalid inference event.")
            if not isinstance(event, dict):
                P.fail(502, "invalid_peer_stream", "The peer returned an invalid inference event.")
            kind = event.get("type")
            if kind == "error":
                status = event.get("status_code")
                P.fail(status if type(status) is int and status in (403, 409, 413, 422, 429, 503, 504) else 502,
                       "peer_inference_failed", "The selected computer could not complete inference. No retry or fallback was sent.")
            if kind == "meta":
                expected = {"type", "protocol", "peer", "identity_fingerprint", "resource_id", "resource_revision", "provider", "model"}
                if (got_meta or set(event) != expected or event["protocol"] != PROTOCOL or event["peer"] != _peer(card)
                        or event["identity_fingerprint"] != card["identity_fingerprint"]
                        or event["resource_id"] != chosen["resource_id"] or event["resource_revision"] != chosen["resource_revision"]
                        or event["provider"] not in ("bundled", "lmstudio") or not _text(event["model"])
                        or _resource_id(event["provider"], event["model"]) != chosen["resource_id"]):
                    P.fail(502, "invalid_peer_identity", "The inference response did not match the reviewed computer and selected model.")
                got_meta = True
                yield event
            elif kind == "delta":
                if not got_meta or set(event) != {"type", "text"} or not isinstance(event["text"], str):
                    P.fail(502, "invalid_peer_stream", "The peer sent text before a valid model identity or an invalid text event.")
                produced += _output_size(event["text"])
                if produced > MAX_OUTPUT:
                    P.fail(502, "inference_output_limit", "The peer answer exceeded its output limit.")
                yield event
            elif kind == "done":
                if not got_meta or set(event) != {"type"}:
                    P.fail(502, "invalid_peer_stream", "The peer sent an invalid completion event.")
                yield event
                return
            else:
                P.fail(502, "invalid_peer_stream", "The peer returned an unsupported inference event.")
        P.fail(502, "inference_interrupted", "The peer inference stream ended before completion. No retry was sent.")
    finally:
        lines.close()
