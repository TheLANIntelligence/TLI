"""Explicit temporary related-note search using an existing loopback embedder.

This is not ordinary Chat recall. No model is downloaded, selected or started by
TLI. Only reviewed note text and an explicitly submitted query reach the chosen
embedding endpoint. Sources stay authoritative; indexes contain vectors/IDs only.
"""
from array import array
import asyncio
import copy
import hashlib
import json
import math
import secrets
import threading
import time

import httpx
from fastapi import HTTPException
import tli_state as S
from intelligence import memory

PROTOCOL = "tli-related-notes-v1"
MAX_NOTES = 64
MAX_TEXT_BYTES = 64 * 1024
MAX_DIMENSIONS = 4096
TTL = 30 * 60
_lock = threading.RLock()
_reviews, _indexes, _building, _searching = {}, {}, set(), set()
_generations = {}
_slots = threading.BoundedSemaphore(2)
PROBE = "TLI related-note embedding consistency check."


def _owner(user):
    return str(S.DATA_DIR), user


def _session(user, token):
    if token:
        allowed = S.validate_session_token(token) and S.get_session_user_id(token) == user
    else:
        allowed = user == "local" and not S.load_pin_config()["enabled"]
    if not allowed:
        raise HTTPException(401, "Your browser session changed. No related-note request was sent or accepted.")


def invalidate(user):
    owner = _owner(user)
    with _lock:
        _generations[owner] = _generations.get(owner, 0) + 1
        for store in (_reviews, _indexes):
            for key, value in list(store.items()):
                if value["owner"] == owner:
                    del store[key]


def clear_browser(token=None):
    with _lock:
        for store in (_reviews, _indexes):
            for key, value in list(store.items()):
                if token is None or value["browser_token"] == token:
                    del store[key]


def _prune():
    now = time.monotonic()
    for store in (_reviews, _indexes):
        for key, value in list(store.items()):
            if value["expires"] <= now or value["browser_token"] and not S.validate_session_token(value["browser_token"]):
                del store[key]


def _lookup(store, ident, user, browser_token):
    _session(user, browser_token)
    _prune()
    value = store.get(ident)
    if not value or value["owner"] != _owner(user) or value["browser_token"] != browser_token:
        raise HTTPException(409, "This related-note index or review changed, expired or belongs to another session. Review your notes again.")
    return value


def _facts(user, refs):
    facts = {fact["id"]: fact for fact in memory.list_facts(user) if not fact["id"].startswith("device-")}
    selected, seen, total = [], set(), 0
    for ref in refs:
        fact = facts.get(ref["id"])
        if ref["id"] in seen or fact is None or fact["revision"] != ref["revision"]:
            raise HTTPException(409, "A selected note changed or was deleted. Review the current notes; no old contents were reconstructed.")
        seen.add(ref["id"])
        text = ((fact.get("title") + "\n") if fact.get("title") else "") + fact["text"]
        total += len(text.encode("utf-8"))
        if total > MAX_TEXT_BYTES:
            raise HTTPException(413, "Selected notes exceed 64 KiB. Select fewer whole notes; no text was silently shortened.")
        selected.append((fact, text))
    return selected, total


def review(user, browser_token, refs, port, model, api_key):
    _session(user, browser_token)
    with _lock:
        generation = _generations.get(_owner(user), 0)
    selected, size = _facts(user, refs)
    value = {"owner": _owner(user), "browser_token": browser_token, "refs": copy.deepcopy(refs),
             "config": {"port": port, "model": model, "api_key": api_key}, "expires": time.monotonic() + 300}
    with _lock:
        _session(user, browser_token)
        if generation != _generations.get(_owner(user), 0):
            raise HTTPException(409, "Notes changed during review. Check the current notes again.")
        _prune()
        if len(_reviews) >= 8:
            raise HTTPException(429, "Too many related-note reviews are open. Close one or wait for its expiry.")
        ident = secrets.token_urlsafe(24); _reviews[ident] = value
    return {"ok": True, "protocol": PROTOCOL, "review_id": ident, "expires_in_seconds": 300,
            "endpoint": f"http://127.0.0.1:{port}/v1/embeddings", "model": model,
            "notes": [{"id": fact["id"], "revision": fact["revision"], "title": fact.get("title") or "Untitled note",
                       "text": fact["text"], "source": fact.get("source"), "device_id": fact.get("device_id")} for fact, _ in selected],
            "text_bytes": size, "inference_called": False, "actions_performed": False,
            "scope": "Build sends these whole notes to the chosen embedding server on this TLI computer. "
                     "That server controls model loading and any onward processing. TLI's selected chat model is unchanged. "
                     "A temporary vector index lasts up to 30 minutes and is discarded on note changes, lock or restart."}


def _strict_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Repeated JSON member")
        value[key] = item
    return value


async def _embeddings(config, texts, *, check=lambda: None):
    payload = {"model": config["model"], "input": texts, "encoding_format": "float"}
    headers = {"Content-Type": "application/json"}
    if config["api_key"]:
        headers["Authorization"] = "Bearer " + config["api_key"]
    raw = bytearray()
    try:
        async with asyncio.timeout(20), httpx.AsyncClient(timeout=httpx.Timeout(10, connect=2), follow_redirects=False, trust_env=False) as client:
            # Opening a client can yield; a lock or saved-note change before the
            # actual request must prevent dispatch of the reviewed private text.
            check()
            async with client.stream("POST", f"http://127.0.0.1:{config['port']}/v1/embeddings", json=payload, headers=headers) as response:
                check()
                if response.status_code != 200:
                    raise HTTPException(503, f"The selected embedding server returned HTTP {response.status_code}. No fallback model or endpoint was used.")
                async for chunk in response.aiter_bytes():
                    check()
                    if len(raw) + len(chunk) > 2 * 1024 * 1024:
                        raise HTTPException(503, "The embedding response exceeded its size limit.")
                    raw.extend(chunk)
        check()
        data = json.loads(raw, object_pairs_hook=_strict_object)
        if (not isinstance(data, dict) or data.get("model") != config["model"] or not isinstance(data.get("data"), list)
                or len(data["data"]) != len(texts)):
            raise ValueError("Invalid model or batch identity")
        rows = data["data"]
        if any(not isinstance(row, dict) or type(row.get("index")) is not int for row in rows):
            raise ValueError("Invalid embedding order")
        rows = sorted(rows, key=lambda row: row["index"])
        vectors = []
        for index, row in enumerate(rows):
            vector = row.get("embedding")
            if (row["index"] != index or not isinstance(vector, list) or not 1 <= len(vector) <= MAX_DIMENSIONS or
                    any(type(v) not in (int, float) or not math.isfinite(v) or abs(v) > 1e12 for v in vector)):
                raise ValueError("Invalid vector")
            norm = math.sqrt(sum(v * v for v in vector))
            if norm <= 0 or vectors and len(vector) != len(vectors[0]):
                raise ValueError("Invalid dimensions or norm")
            vectors.append(array('f', (v / norm for v in vector)))
        return vectors
    except HTTPException:
        raise
    except (TimeoutError, httpx.HTTPError) as exc:
        raise HTTPException(503, "The chosen loopback embedding server did not respond in time. No retry or model switch occurred.") from exc
    except (ValueError, TypeError, OverflowError, RecursionError) as exc:
        raise HTTPException(503, "The embedding server returned invalid vectors or a different model. No index was accepted.") from exc


async def build(user, browser_token, ident):
    with _lock:
        pending = copy.deepcopy(_lookup(_reviews, ident, user, browser_token))
        owner = pending["owner"]
        if owner in _building or not _slots.acquire(blocking=False):
            raise HTTPException(429, "A related-note build is already in progress. Wait before trying again.")
        if len(_indexes) >= 4 and not any(v["owner"] == owner for v in _indexes.values()):
            _slots.release()
            raise HTTPException(429, "The temporary note-index limit was reached. Close an index first.")
        _building.add(owner)
        generation = _generations.get(owner, 0)
    try:
        selected, _ = _facts(user, pending["refs"])
        def current():
            with _lock:
                _lookup(_reviews, ident, user, browser_token)
                if generation != _generations.get(owner, 0):
                    raise HTTPException(409, "Notes or the session changed. Build was discarded.")
        vectors, probe = [], None
        async with asyncio.timeout(90):
            for offset in range(0, len(selected), 8):
                current()
                batch = await _embeddings(pending["config"], [PROBE, *[text for _, text in selected[offset:offset + 8]]], check=current)
                if probe is None:
                    probe = batch[0]
                elif not _consistent(probe, batch[0]):
                    raise HTTPException(503, "The embedding behavior changed during the build. No index was accepted.")
                batch = batch[1:]
                if vectors and len(batch[0]) != len(vectors[0]):
                    raise HTTPException(503, "Embedding dimensions changed between batches. No index was saved.")
                vectors.extend(batch)
        _facts(user, pending["refs"])
        with _lock:
            _lookup(_reviews, ident, user, browser_token)
            if generation != _generations.get(owner, 0):
                raise HTTPException(409, "Notes or the session changed. Build was discarded.")
            if len(_indexes) >= 4 and not any(v["owner"] == owner and v["browser_token"] == browser_token for v in _indexes.values()):
                raise HTTPException(429, "The temporary index limit was reached. The previous indexes were retained.")
            for key, value in list(_indexes.items()):
                if value["owner"] == owner and value["browser_token"] == browser_token:
                    del _indexes[key]
            index_id = secrets.token_urlsafe(24)
            _indexes[index_id] = {**pending, "vectors": vectors, "probe": probe, "expires": time.monotonic() + TTL}
            del _reviews[ident]
        return {"ok": True, "protocol": PROTOCOL, "index_id": index_id, "note_count": len(vectors),
                "dimensions": len(vectors[0]), "expires_in_seconds": TTL, "model": pending["config"]["model"],
                "source_retained": False, "scope": "Temporary similarity index built from the reviewed notes. Similarity does not validate a note or establish current health. The server model name and a consistency probe are checked; the underlying weights are not identified or quality-validated."}
    except TimeoutError:
        raise HTTPException(503, "The related-note build exceeded 90 seconds. The previous working index, if any, was retained.") from None
    finally:
        with _lock:
            _building.discard(owner)
        _slots.release()


async def search(user, browser_token, ident, query, target_id=None):
    if not query.strip():
        raise HTTPException(422, "Describe the note you want to find.")
    with _lock:
        value = _lookup(_indexes, ident, user, browser_token)
        generation = _generations.get(value["owner"], 0)
    selected, _ = _facts(user, value["refs"])
    if target_id:
        from intelligence.devices import get
        get(target_id)
    with _lock:
        if ident in _searching or not _slots.acquire(blocking=False):
            raise HTTPException(429, "A related-note search is already in progress or the service is busy. Retry deliberately when ready.")
        _searching.add(ident)
    try:
        def current():
            with _lock:
                _lookup(_indexes, ident, user, browser_token)
                if generation != _generations.get(value["owner"], 0):
                    raise HTTPException(409, "Your notes or session changed. The old similarity results were discarded.")
        current()
        vectors = await _embeddings(value["config"], [PROBE, query], check=current)
        if not _consistent(vectors[0], value["probe"]):
            raise HTTPException(503, "Embedding behavior changed. Rebuild the index with the selected model; these results were discarded.")
        selected, _ = _facts(user, value["refs"])
        with _lock:
            _lookup(_indexes, ident, user, browser_token)
            if generation != _generations.get(value["owner"], 0):
                raise HTTPException(409, "Your notes changed. The old similarity results were discarded.")
        rows = []
        for (fact, _), vector in zip(selected, value["vectors"]):
            if fact.get("device_id") and fact["device_id"] != target_id:
                continue
            score = max(-1.0, min(1.0, sum(a * b for a, b in zip(vectors[1], vector))))
            rows.append({"id": fact["id"], "revision": fact["revision"], "title": fact.get("title") or "Untitled note",
                         "source": fact.get("source"), "device_id": fact.get("device_id"), "updated_at": fact.get("updated_at"),
                         "similarity": round(score, 4)})
        rows.sort(key=lambda row: (-row["similarity"], row["id"]))
        current()
        return {"ok": True, "protocol": PROTOCOL, "results": rows[:8], "candidate_count": len(rows), "target_id": target_id,
                "actions_performed": False, "chat_context_changed": False,
                "scope": "Ranked similarity candidates, not confirmed relevant facts. Open and review a note before using it. Device-scoped notes require that exact selected device. No question was sent to Chat."}
    finally:
        with _lock:
            _searching.discard(ident)
        _slots.release()


def _consistent(before, after):
    return len(before) == len(after) and all(abs(a - b) <= 1e-5 for a, b in zip(before, after))


def discard(user, browser_token, ident):
    with _lock:
        for store in (_reviews, _indexes):
            value = store.get(ident)
            if value and value["owner"] == _owner(user) and value["browser_token"] == browser_token:
                del store[ident]
    return {"ok": True, "discarded": True}
