"""Explicit one-file transfers over reviewed signed HTTPS.

The messages grant permits an offer, not content. Content requires a separate
receiver credential-bound consent. There are no automatic retries or workers.
"""
from __future__ import annotations

import base64
import hashlib
import math
import re
import secrets
import time

from fastapi import HTTPException

import companion_auth as A
import peer_trust as P
import peer_transfer_store as D
import tli_state as S

PROTOCOL = "tli-peer-file-v1"
TTL = 1800
_BINDINGS = {}
_REVIEWS = {}
_ACTIVE = set()
TERMINAL = {"received", "delivered", "cancelled", "declined", "expired", "discarded"}


def capabilities():
    return {"ok": True, "protocol": PROTOCOL, "max_file_bytes": D.MAX_FILE,
            "chunk_bytes": D.CHUNK, "max_active_per_owner": 4, "max_retained_records": D.MAX_RECORDS,
            "max_retained_raw_bytes": D.MAX_RAW, "max_encrypted_store_bytes": D.MAX_DISK,
            "review_seconds": TTL, "destination": "TLI Inbox (encrypted on host)",
            "receiver_consent_required": True, "automatic_retry": False}


def _hash(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        P.fail(422, "invalid_checksum", "A SHA-256 checksum is required.")
    return value


def _exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        P.fail(422, "invalid_transfer_request", "The transfer request does not match its bounded contract.")


def _peer(peer_id):
    if not isinstance(peer_id, str) or not 1 <= len(peer_id) <= 200:
        P.fail(422, "invalid_peer_id", "Select one reviewed computer identifier.")
    entry, card, revision = P.trusted(peer_id, "messages")
    owner = entry["peer_trust"].get("reviewed_by")
    if not isinstance(owner, str) or not owner or len(owner) > 200:
        P.fail(409, "review_required", "Review this peer from the receiving owner's account first.")
    return owner, card, revision


def _owned(transfer_id, owner, direction=None):
    record = D.load(transfer_id)
    if record["owner"] != owner:
        P.fail(404, "transfer_not_found", "Transfer not found.")
    if direction and record["direction"] != direction:
        P.fail(409, "transfer_direction", "This operation does not apply to this transfer.")
    return record


def _bind(record, owner, request):
    check = A.operation_access(request, owner)
    credential = P._credential(request)
    _BINDINGS[record["id"]] = (credential, check)
    record["credential"] = credential


def _check(record, request=None):
    current = D.load(record["id"])
    if current["state"] in {"cancelled", "declined", "expired", "discarded"}:
        P.fail(409, "transfer_stopped", "This transfer is stopped. No further content was sent.")
    if time.time() > current["expires_at"]:
        P.fail(409, "transfer_expired", "The transfer's review period expired. No further content was sent.")
    if _peer(record["peer_id"])[2] != record["peer_revision"]:
        P.fail(409, "peer_changed", "Peer trust changed. Existing transfer content was preserved; start a newly reviewed transfer.")
    binding = _BINDINGS.get(record["id"])
    if not binding or binding[0] != current.get("credential"):
        P.fail(409, "transfer_resume_required", "This transfer needs an explicit review or resume after the server restarted.")
    if request is not None and binding[0] != P._credential(request):
        P.fail(409, "transfer_session_changed", "Resume this transfer explicitly in the current session first.")
    binding[1]()


def public(record):
    state = record["state"]
    if state not in TERMINAL and time.time() > record["expires_at"]:
        state = "expired"
    return {"protocol": PROTOCOL, "id": record["id"], "direction": record["direction"],
            "peer": {"id": record["peer_id"], "name": record["peer_name"]},
            "filename": record["filename"], "size": record["size"], "sha256": record.get("sha256"),
            "state": state, "created_at": record["created_at"], "expires_at": record["expires_at"],
            "staged_bytes": record["bytes"], "acknowledged_bytes": record.get("acknowledged_bytes", 0),
            "verified": record["state"] in {"received", "delivered"},
            "destination": "TLI Inbox (encrypted on host)", "automatic_retry": False,
            "resume_required": record["id"] not in _BINDINGS and state not in TERMINAL,
            "uncertain_operation": record.get("uncertain_operation"),
            "cancel_scope": "Local stop prevents subsequent chunks. It does not recall content already received or confirm that the peer discarded it."}


def listing(owner):
    with D.LOCK:
        return {"ok": True, "protocol": PROTOCOL, "transfers": [public(D.load(key)) for key, value in D.index()["records"].items() if value["owner"] == owner]}


def get(transfer_id, owner):
    with D.LOCK:
        return public(_owned(transfer_id, owner))


def _admit(owner, incoming=False):
    records = [D.load(key) for key in D.index()["records"]]
    active = lambda r: r["state"] not in TERMINAL and r["expires_at"] > time.time()
    if sum(r["owner"] == owner and active(r) for r in records) >= 4:
        P.fail(429, "transfer_busy", "Four transfers are already pending or active for this account.")
    if incoming and sum(r["direction"] == "incoming" and active(r) for r in records) >= 32:
        P.fail(429, "transfer_busy", "The receiving host's pending transfer limit has been reached.")


def create(body, owner, request):
    _exact(body, {"request_id", "peer_id", "filename", "size"})
    D.identifier(body["request_id"])
    D.filename(body["filename"])
    if type(body["size"]) is not int or not 0 <= body["size"] <= D.MAX_FILE:
        P.fail(413, "transfer_size_limit", "Select one file of at most 250 MiB.")
    with D.LOCK:
        _, card, revision = _peer(body["peer_id"])
        # Exact request IDs never silently create another upload after a lost reply.
        for key, row in D.index()["records"].items():
            if row["owner"] == owner:
                existing = D.load(key)
                if existing.get("request_id") == body["request_id"]:
                    if existing.get("request") != body:
                        P.fail(409, "transfer_request_changed", "This request identifier already belongs to another file.")
                    return public(existing)
        _admit(owner)
        now = time.time()
        record = {"id": secrets.token_hex(16), "owner": owner, "request_id": body["request_id"], "request": body,
                  "direction": "outgoing", "peer_id": body["peer_id"], "peer_name": card["name"], "peer_revision": revision,
                  "filename": body["filename"], "size": body["size"], "state": "staging", "bytes": 0,
                  "chunks": [], "pending_chunk": None, "created_at": now, "expires_at": now + TTL}
        _bind(record, owner, request)
        D.create(record)
        return public(record)


def _chunk(record, body):
    _exact(body, {"index", "data", "sha256"})
    number, checksum = body["index"], _hash(body["sha256"])
    if type(number) is not int or number < 0 or not isinstance(body["data"], str) or len(body["data"]) > 4 * ((D.CHUNK + 2) // 3):
        P.fail(422, "invalid_chunk", "Invalid chunk shape.")
    try:
        raw = base64.b64decode(body["data"], validate=True)
    except Exception:
        P.fail(422, "invalid_chunk", "Invalid chunk encoding.")
    if len(raw) != min(D.CHUNK, record["size"] - number * D.CHUNK) or not raw or hashlib.sha256(raw).hexdigest() != checksum:
        P.fail(422, "chunk_integrity_failed", "The chunk size or checksum did not match; no content was stored.")
    if number < len(record["chunks"]):
        if record["chunks"][number] == checksum and D.read_chunk(record, number) == raw:
            return True
        P.fail(409, "chunk_changed", "A different chunk already occupies this position.")
    if number != len(record["chunks"]) or record.get("pending_chunk") is not None:
        P.fail(409, "chunk_uncertain", "A previous chunk write is incomplete or out of order. It was not repeated.")
    record["pending_chunk"] = {"index": number, "sha256": checksum}
    D.save(record)
    D.write_chunk(record, number, raw, checksum)
    record["chunks"].append(checksum)
    record["bytes"] += len(raw)
    record["pending_chunk"] = None
    D.save(record)
    return False


def stage(transfer_id, body, owner, request):
    with D.LOCK:
        record = _owned(transfer_id, owner, "outgoing")
        _check(record, request)
        if record["state"] != "staging":
            P.fail(409, "transfer_state", "This file is already sealed for its offer.")
        _chunk(record, body)
        return public(record)


def _whole_hash(record):
    if record["bytes"] != record["size"] or record.get("pending_chunk") is not None:
        P.fail(409, "transfer_incomplete", "The complete file has not been received.")
    result = hashlib.sha256()
    for number in range(len(record["chunks"])):
        _check(record)
        result.update(D.read_chunk(record, number))
    _check(record)
    return result.hexdigest()


def _wire(record):
    return {"protocol": PROTOCOL, "id": record["id"], "offer_sha256": record["offer_sha256"]}


def _remote(record, action, body, request):
    def check():
        with D.LOCK:
            _check(record, request)
    reply = P.request(record["peer_id"], "POST", "/agent/peer/files/" + action, json_body=body,
                      grant="messages", expected_revision=record["peer_revision"], check=check)
    try:
        value = reply.json()
        if (reply.status_code != 200 or not isinstance(value, dict) or value.get("ok") is not True
                or any(value.get(key) != val for key, val in _wire(record).items())):
            raise ValueError()
        return value
    except Exception:
        P.fail(502, "transfer_acknowledgment_uncertain", "No matching transfer acknowledgment arrived. Progress is uncertain; check status explicitly before continuing.")


def _attempt(transfer_id, owner, request, action, prepare, commit):
    with D.LOCK:
        record = _owned(transfer_id, owner, "outgoing")
        _check(record, request)
        if record.get("busy") or transfer_id in _ACTIVE:
            P.fail(409, "transfer_busy", "An operation is already in progress. Check status after it finishes.")
        body = prepare(record)
        record["busy"] = action
        D.save(record)
        _ACTIVE.add(transfer_id)
    try:
        value = _remote(record, action, body, request)
        with D.LOCK:
            latest = _owned(transfer_id, owner, "outgoing")
            _check(latest, request)
            commit(latest, value)
            latest["busy"] = None
            latest["uncertain_operation"] = None
            D.save(latest)
            return public(latest)
    except Exception:
        with D.LOCK:
            latest = _owned(transfer_id, owner, "outgoing")
            latest["busy"] = None
            if latest["state"] not in TERMINAL:
                latest["uncertain_operation"] = action
                latest["state"] = "uncertain"
            D.save(latest)
        raise
    finally:
        with D.LOCK:
            _ACTIVE.discard(transfer_id)


def offer(transfer_id, owner, request):
    def prepare(r):
        if r["state"] not in {"staging", "offered", "uncertain"}:
            P.fail(409, "transfer_state", "This transfer is no longer waiting for an offer.")
        if "offer" not in r:
            r["sha256"] = _whole_hash(r)
            r["offer"] = {"protocol": PROTOCOL, "id": r["id"], "from_id": S.load_node_config().node_id,
                          "to_id": r["peer_id"], "filename": r["filename"], "size": r["size"],
                          "sha256": r["sha256"], "chunk_bytes": D.CHUNK, "expires_at": r["expires_at"]}
            r["offer_sha256"] = P.digest(r["offer"])
        return r["offer"]
    def commit(r, v):
        if v.get("state") not in {"offered", "accepted", "received", "declined", "cancelled", "expired"}:
            P.fail(502, "invalid_transfer_ack", "The offer response was invalid.")
        if type(v.get("received_bytes")) is not int or not 0 <= v["received_bytes"] <= r["size"]:
            P.fail(502, "invalid_transfer_ack", "The offer progress receipt was invalid.")
        if v["state"] == "received" and (v["received_bytes"] != r["size"] or v.get("verified_sha256") != r["sha256"]):
            P.fail(502, "invalid_transfer_ack", "The final receipt did not match this offered file.")
        r["state"] = "offered"
    return _attempt(transfer_id, owner, request, "offer", prepare, commit)


def peer_status(transfer_id, owner, request):
    def prepare(r):
        if "offer_sha256" not in r:
            P.fail(409, "transfer_state", "Offer this file first.")
        return _wire(r)
    def commit(r, v):
        count = v.get("received_bytes")
        if (type(count) is not int or not 0 <= count <= r["size"]
                or (count != r["size"] and count % D.CHUNK)):
            P.fail(502, "invalid_transfer_ack", "The peer's progress was invalid.")
        number = (count + D.CHUNK - 1) // D.CHUNK
        if v.get("last_chunk_sha256") != (r["chunks"][number - 1] if number else None):
            P.fail(502, "invalid_transfer_ack", "The peer's chunk receipt did not match.")
        state = v.get("state")
        if state not in {"offered", "accepted", "received", "declined", "cancelled", "expired"}:
            P.fail(502, "invalid_transfer_ack", "The peer state was invalid.")
        if state == "received" and (count != r["size"] or v.get("verified_sha256") != r["sha256"]):
            P.fail(502, "invalid_transfer_ack", "The final file receipt did not match.")
        r["acknowledged_bytes"] = count
        r["state"] = "delivered" if state == "received" else state
    return _attempt(transfer_id, owner, request, "status", prepare, commit)


def send_next(transfer_id, owner, request):
    def prepare(r):
        if r["state"] != "accepted":
            P.fail(409, "receiver_consent_required", "Check the receiver's explicit acceptance before sending content.")
        count = r.get("acknowledged_bytes", 0)
        if count >= r["size"]:
            P.fail(409, "transfer_complete_required", "All chunks are acknowledged. Request final verification.")
        number = count // D.CHUNK
        return dict(_wire(r), index=number, sha256=r["chunks"][number], data=base64.b64encode(D.read_chunk(r, number)).decode("ascii"))
    def commit(r, v):
        before = r.get("acknowledged_bytes", 0)
        number = before // D.CHUNK
        after = min(r["size"], before + D.CHUNK)
        if v.get("state") != "accepted" or type(v.get("received_bytes")) is not int or v["received_bytes"] != after or v.get("last_chunk_sha256") != r["chunks"][number]:
            P.fail(502, "invalid_transfer_ack", "The chunk acknowledgment did not match. No retry was sent.")
        r["acknowledged_bytes"] = after
    return _attempt(transfer_id, owner, request, "chunk", prepare, commit)


def complete(transfer_id, owner, request):
    def prepare(r):
        if r["state"] != "accepted" or r.get("acknowledged_bytes", 0) != r["size"]:
            P.fail(409, "transfer_incomplete", "Wait for acceptance and every chunk acknowledgment before final verification.")
        return _wire(r)
    def commit(r, v):
        if v.get("state") != "received" or v.get("verified_sha256") != r["sha256"] or type(v.get("received_bytes")) is not int or v["received_bytes"] != r["size"]:
            P.fail(502, "invalid_transfer_ack", "The receiver did not confirm the complete file checksum.")
        r["state"] = "delivered"
    return _attempt(transfer_id, owner, request, "complete", prepare, commit)


def review(transfer_id, owner, request):
    with D.LOCK:
        r = _owned(transfer_id, owner, "incoming")
        if r["state"] not in {"offered", "accepted"} or time.time() > r["expires_at"] or _peer(r["peer_id"])[2] != r["peer_revision"]:
            P.fail(409, "transfer_review_unavailable", "This offer expired, stopped or its peer trust changed.")
        A.operation_access(request, owner)()
        token = secrets.token_hex(24)
        for key in list(_REVIEWS):
            if _REVIEWS[key]["expires"] < time.time():
                del _REVIEWS[key]
        if len(_REVIEWS) >= 128:
            P.fail(429, "review_capacity", "Too many transfer reviews are open.")
        _REVIEWS[token] = {"id": r["id"], "owner": owner, "credential": P._credential(request), "offer": r["offer_sha256"], "expires": time.time()+300}
        return dict(public(r), review_id=token, review_expires_at=time.time()+300,
                    consent_label="Receive into TLI Inbox (encrypted on host)",
                    download_note="After checksum verification, use Download to choose a browser download location. Existing files are not overwritten by TLI.")


def accept(transfer_id, body, owner, request):
    _exact(body, {"review_id"})
    if not isinstance(body["review_id"], str) or not re.fullmatch(r"[a-f0-9]{48}", body["review_id"]):
        P.fail(409, "transfer_review_required", "A current exact transfer review is required.")
    with D.LOCK:
        r = _owned(transfer_id, owner, "incoming")
        item = _REVIEWS.get(body["review_id"])
        if (not item or item["id"] != r["id"] or item["owner"] != owner or item["credential"] != P._credential(request)
                or item["offer"] != r["offer_sha256"] or item["expires"] < time.time()):
            P.fail(409, "transfer_review_required", "Review this exact file in the current session before accepting it.")
        if r["state"] not in {"offered", "accepted"} or time.time() > r["expires_at"] or _peer(r["peer_id"])[2] != r["peer_revision"]:
            P.fail(409, "transfer_review_unavailable", "The offer or peer changed. No content was accepted.")
        _bind(r, owner, request)
        r["state"] = "accepted"
        r["consented_at"] = time.time()
        D.save(r)
        del _REVIEWS[body["review_id"]]
        return public(r)


def resume(transfer_id, owner, request):
    with D.LOCK:
        r = _owned(transfer_id, owner, "outgoing")
        if transfer_id in _ACTIVE:
            P.fail(409, "transfer_busy", "The current request is still in progress. Resume cannot replace its session or start competing work.")
        if r["state"] in TERMINAL or r["expires_at"] < time.time() or _peer(r["peer_id"])[2] != r["peer_revision"]:
            P.fail(409, "transfer_stopped", "This transfer cannot resume. Its data remains available for explicit discard.")
        _bind(r, owner, request)
        # A restart during a request is uncertain. Reconcile status before bytes.
        if r.get("busy"):
            r["state"] = "uncertain"
            r["uncertain_operation"] = r["busy"]
            r["busy"] = None
        D.save(r)
        return public(r)


def stop(transfer_id, owner, request, *, decline=False, discard=False):
    check = A.operation_access(request, owner)
    with D.LOCK:
        check()
        r = _owned(transfer_id, owner)
        if decline and (r["direction"] != "incoming" or r["state"] != "offered"):
            P.fail(409, "transfer_state", "Only a pending incoming offer can be declined.")
        if r["state"] in {"received", "delivered"} and not discard:
            P.fail(409, "transfer_finished", "This transfer is already verified. Use Discard to remove its local retained content.")
        r["state"] = "declined" if decline else "cancelled"
        D.save(r)
        _BINDINGS.pop(r["id"], None)
        if discard:
            D.discard(r, check)
            check()
            D.forget_expired(r)
        return public(r)


def receive_offer(body, access):
    _exact(body, {"protocol", "id", "from_id", "to_id", "filename", "size", "sha256", "chunk_bytes", "expires_at"})
    D.identifier(body["id"]); D.filename(body["filename"]); _hash(body["sha256"])
    if (body["protocol"] != PROTOCOL or body["from_id"] != access["device_id"]
            or body["to_id"] != S.load_node_config().node_id or body["chunk_bytes"] != D.CHUNK
            or type(body["size"]) is not int or not 0 <= body["size"] <= D.MAX_FILE
            or type(body["expires_at"]) not in (int, float) or not 0 < body["expires_at"] < 2**53
            or not math.isfinite(body["expires_at"])
            or not 0 < body["expires_at"] - time.time() <= TTL + 60):
        P.fail(422, "invalid_offer", "This offer's identity, size or review period is invalid.")
    with D.LOCK:
        P.revalidate(access)
        owner, card, revision = _peer(access["device_id"])
        checksum = P.digest(body)
        if body["id"] in D.index()["records"]:
            r = D.load(body["id"])
            if r.get("offer_sha256") != checksum or r["direction"] != "incoming" or r["peer_revision"] != revision or r["owner"] != owner:
                P.fail(409, "transfer_changed", "This transfer identifier already belongs to a different offer or review.")
            return _receipt(r)
        _admit(owner, incoming=True)
        r = {"id": body["id"], "owner": owner, "direction": "incoming", "peer_id": access["device_id"],
             "peer_name": card["name"], "peer_revision": revision, "filename": body["filename"], "size": body["size"],
             "sha256": body["sha256"], "offer": body, "offer_sha256": checksum, "state": "offered", "bytes": 0,
             "chunks": [], "pending_chunk": None, "created_at": time.time(), "expires_at": body["expires_at"]}
        D.create(r)
        return _receipt(r)


def _receipt(r):
    state = r["state"]
    if state not in TERMINAL and time.time() > r["expires_at"]:
        state = "expired"
    # If consent no longer exists, do not advertise usable acceptance.
    if state == "accepted":
        try:
            _check(r)
        except HTTPException:
            state = "offered"
    return dict(_wire(r), ok=True, state=state, received_bytes=r["bytes"],
                last_chunk_sha256=r["chunks"][-1] if r["chunks"] else None,
                verified_sha256=r["sha256"] if r["state"] == "received" else None)


def receive(action, body, access):
    keys = {"protocol", "id", "offer_sha256"}
    if action == "chunk":
        keys |= {"index", "data", "sha256"}
    _exact(body, keys)
    with D.LOCK:
        P.revalidate(access)
        r = D.load(body["id"])
        if (r["direction"] != "incoming" or r["peer_id"] != access["device_id"]
                or r["peer_revision"] != access["revision"] or any(body.get(k) != v for k, v in _wire(r).items())):
            P.fail(403, "transfer_identity_mismatch", "This transfer belongs to another peer, offer or trust revision.")
        if action == "status":
            return _receipt(r)
        if action == "cancel":
            if r["state"] != "received":
                r["state"] = "cancelled"
                D.save(r)
            return _receipt(r)
        if action == "complete" and r["state"] == "received":
            return _receipt(r)
        try:
            _check(r)
        except HTTPException as error:
            if error.status_code == 401:
                P.fail(409, "receiver_consent_required", "The receiving owner's session expired or was locked. Renew consent for this file in that owner's Inbox; peer trust does not need to be replaced.")
            raise
        if r["state"] != "accepted":
            P.fail(409, "receiver_consent_required", "The receiving owner has not accepted this file. No content was stored.")
        if action == "chunk":
            _chunk(r, {key: body[key] for key in ("index", "data", "sha256")})
        elif action == "complete":
            if _whole_hash(r) != r["sha256"]:
                r["state"] = "cancelled"
                D.save(r)
                P.fail(409, "file_integrity_failed", "The complete file checksum did not match. It was not published to the Inbox.")
            _check(r)
            r["state"] = "received"
            r["verified_at"] = time.time()
            D.save(r)
        else:
            P.fail(404, "transfer_operation_unavailable", "Unknown transfer operation.")
        return _receipt(r)


def download(transfer_id, owner, request):
    with D.LOCK:
        r = _owned(transfer_id, owner, "incoming")
        if r["state"] != "received":
            P.fail(409, "transfer_not_verified", "Only a complete checksum-verified Inbox file can be downloaded.")
        check = A.operation_access(request, owner)
        filename = r["filename"]
    def chunks():
        for number in range(len(r["chunks"])):
            with D.LOCK:
                check()
                if _owned(transfer_id, owner)["state"] != "received":
                    P.fail(409, "transfer_discarded", "The Inbox file was discarded during download.")
                content = D.read_chunk(r, number)
            yield content
    return filename, r["size"], chunks()
