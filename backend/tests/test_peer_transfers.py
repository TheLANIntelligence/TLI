"""Synthetic file bytes, isolated encrypted stores and signed ASGI only."""
import base64
import hashlib
import json
import time

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

import peer_transfer_store as D
import peer_transfers as T
import peer_trust as P
import tli_state as S
from routers.peer_transfer_routes import router
from tests.test_peer_trust import peers, browser, signed


@pytest.fixture()
def transfer(peers, monkeypatch):
    data = peers.root / "data"
    data.mkdir()
    monkeypatch.setattr(S, "DATA_DIR", str(data))
    monkeypatch.setattr(S, "MESH_DATA_DIR", data / "mesh")
    T._BINDINGS.clear(); T._REVIEWS.clear(); T._ACTIVE.clear()
    return peers


def offer(data=b"Synthetic private file", **changes):
    body = {"protocol": T.PROTOCOL, "id": "ab"*16, "from_id": "peer-b", "to_id": "local-a",
            "filename": "synthetic.txt", "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "chunk_bytes": D.CHUNK, "expires_at": time.time()+1200}
    body.update(changes)
    return body


def access():
    return {"device_id": "peer-b", "revision": P.trusted("peer-b", "messages")[2], "grant": "messages"}


def wire(body):
    return {"protocol": T.PROTOCOL, "id": body["id"], "offer_sha256": P.digest(body)}


def part(body, data, index=0):
    return dict(wire(body), index=index, sha256=hashlib.sha256(data).hexdigest(), data=base64.b64encode(data).decode())


def accepted(body):
    T.receive_offer(body, access())
    review = T.review(body["id"], "owner", browser())
    T.accept(body["id"], {"review_id": review["review_id"]}, "owner", browser())


def outgoing(data):
    r = T.create({"request_id": "cd"*16, "peer_id": "peer-b", "filename": "selected.bin", "size": len(data)}, "owner", browser())
    for index, offset in enumerate(range(0, len(data), D.CHUNK)):
        raw = data[offset:offset+D.CHUNK]
        T.stage(r["id"], {"index": index, "sha256": hashlib.sha256(raw).hexdigest(), "data": base64.b64encode(raw).decode()}, "owner", browser())
    return r


def test_list_never_creates_data_or_keys(transfer):
    before = S.NODE_CONFIG_PATH.read_bytes()
    assert T.listing("owner")["transfers"] == []
    assert not D.root().exists()
    assert not (D.root().parents[1] / "chat_key.bin").exists()
    assert S.NODE_CONFIG_PATH.read_bytes() == before


def test_consent_then_integrity_then_download_only(transfer):
    data = b"Private synthetic" * 5000
    body = offer(data)
    T.receive_offer(body, access())
    with pytest.raises(HTTPException):
        T.receive("chunk", part(body, data[:D.CHUNK]), access())
    assert not list(D.root().glob("*.blob"))
    with pytest.raises(HTTPException): T.download(body["id"], "owner", browser())
    accepted(body)
    for i, offset in enumerate(range(0, len(data), D.CHUNK)):
        payload = part(body, data[offset:offset+D.CHUNK], i)
        first = T.receive("chunk", payload, access())
        before = {p.name: p.read_bytes() for p in D.root().iterdir()}
        assert T.receive("chunk", payload, access()) == first
        assert {p.name: p.read_bytes() for p in D.root().iterdir()} == before
    assert T.receive("complete", wire(body), access())["verified_sha256"] == body["sha256"]
    name, size, chunks = T.download(body["id"], "owner", browser())
    assert name == body["filename"] and size == len(data) and b"".join(chunks) == data
    assert all(data[:20] not in path.read_bytes() for path in D.root().iterdir())


@pytest.mark.parametrize("operation", ["list", "get", "review", "accept", "download", "cancel", "discard"])
def test_foreign_account_cannot_read_or_mutate(transfer, monkeypatch, operation):
    body = offer(); accepted(body)
    review = T.review(body["id"], "owner", browser())
    monkeypatch.setattr(S, "validate_session_token", lambda token: token in {"browser-token", "foreign-token"})
    monkeypatch.setattr(S, "get_session_user_id", lambda token: "owner" if token == "browser-token" else "foreign")
    other = Request({"type": "http", "headers": [(b"cookie", b"tli_session=foreign-token")]})
    if operation == "list":
        assert T.listing("foreign")["transfers"] == []
        return
    before = {p.name: p.read_bytes() for p in D.root().iterdir()}
    with pytest.raises(HTTPException) as error:
        if operation == "accept": T.accept(body["id"], {"review_id": review["review_id"]}, "foreign", browser())
        elif operation in {"cancel", "discard"}: T.stop(body["id"], "foreign", other, discard=operation == "discard")
        elif operation == "get": T.get(body["id"], "foreign")
        else: getattr(T, operation)(body["id"], "foreign", browser())
    assert error.value.status_code == 404
    assert before == {p.name: p.read_bytes() for p in D.root().iterdir()}


@pytest.mark.parametrize("field,value", [("owner", "foreign"), ("destination", "C:/secret"), ("from_id", "spoof"), ("to_id", "wrong"), ("filename", "../escape"), ("filename", "CON.txt"), ("filename", "x:stream"), ("size", True), ("size", D.MAX_FILE+1), ("expires_at", float("nan")), ("expires_at", 0)])
def test_offer_rejects_paths_accounts_wrong_identity_and_bounds(transfer, field, value):
    with pytest.raises(HTTPException): T.receive_offer(offer(**{field: value}), access())
    assert not D.root().exists()


@pytest.mark.parametrize("change", ["lock", "trust", "restart", "expired", "declined", "cancelled"])
def test_consent_invalidation_prevents_next_chunk(transfer, monkeypatch, change):
    body = offer()
    if change == "declined":
        T.receive_offer(body, access()); T.stop(body["id"], "owner", browser(), decline=True)
    else:
        accepted(body)
    if change == "lock": monkeypatch.setattr(S, "validate_session_token", lambda _: False)
    if change == "trust":
        directory = S.load_mesh_directory(); directory["peer-b"]["status"] = "blocked"; S.save_mesh_directory(directory)
    if change == "restart": T._BINDINGS.clear()
    if change == "expired":
        r = D.load(body["id"]); r["expires_at"] = time.time()-1; D.save(r)
    if change == "cancelled": T.stop(body["id"], "owner", browser())
    with pytest.raises(HTTPException): T.receive("chunk", part(body, b"Synthetic private file"), access())
    assert not list(D.root().glob("*.blob"))


def test_bad_hash_never_publishes_and_existing_filename_is_independent(transfer):
    data = b"bad"; body = offer(data, sha256="00"*32)
    accepted(body); T.receive("chunk", part(body, data), access())
    with pytest.raises(HTTPException): T.receive("complete", wire(body), access())
    with pytest.raises(HTTPException): T.download(body["id"], "owner", browser())
    other = offer(b"good", id="cc"*16)
    accepted(other); T.receive("chunk", part(other, b"good"), access())
    T.receive("complete", wire(other), access())
    assert b"".join(T.download(other["id"], "owner", browser())[2]) == b"good"


def test_incomplete_chunk_journal_refuses_replay(transfer, monkeypatch):
    body = offer(); accepted(body)
    def fail_write(*args): raise OSError("synthetic crash before durable write")
    with monkeypatch.context() as m:
        m.setattr(D, "write_chunk", fail_write)
        with pytest.raises(OSError): T.receive("chunk", part(body, b"Synthetic private file"), access())
    with pytest.raises(HTTPException) as error: T.receive("chunk", part(body, b"Synthetic private file"), access())
    assert error.value.detail["code"] == "chunk_uncertain"
    assert not list(D.root().glob("*.blob"))


def test_missing_key_index_and_ciphertext_fail_closed(transfer):
    body = offer(); accepted(body)
    key = D.root().parents[1] / "chat_key.bin"
    original = key.read_bytes(); key.unlink()
    with pytest.raises(HTTPException): T.listing("owner")
    with pytest.raises(HTTPException): S.get_chat_key()
    assert not key.exists()
    key.write_bytes(original)
    index = D.root()/"index.jsonl"; index.unlink()
    with pytest.raises(HTTPException): T.listing("owner")
    assert not index.exists()


def test_pending_capacity_and_retained_bytes_are_not_reset(transfer):
    for number in range(4): T.receive_offer(offer(id=f"{number:032x}"), access())
    with pytest.raises(HTTPException) as error: T.receive_offer(offer(id="ff"*16), access())
    assert error.value.status_code == 429
    first = "00"*16
    reserved = sum(x["reserved"] for x in D.index()["records"].values())
    T.stop(first, "owner", browser())
    assert sum(x["reserved"] for x in D.index()["records"].values()) == reserved
    T.stop(first, "owner", browser(), discard=True)
    assert sum(x["reserved"] for x in D.index()["records"].values()) < reserved


def test_signed_asgi_offer_and_owner_review_contract(transfer):
    app = FastAPI(); app.include_router(router)
    client = TestClient(app, base_url="https://192.168.2.10:8443")
    body = offer(); raw, headers = signed(transfer, "/agent/peer/files/offer", body)
    reply = client.post("/agent/peer/files/offer", content=raw, headers=headers)
    assert reply.status_code == 200 and reply.json()["state"] == "offered"
    assert client.get("/mesh/files").status_code == 401
    client.cookies.set("tli_session", "browser-token")
    result = client.get("/mesh/files").json()
    assert result["transfers"][0]["filename"] == body["filename"]
    result = client.post(f"/mesh/files/{body['id']}/review", json={}).json()
    assert result["consent_label"] == "Receive into TLI Inbox (encrypted on host)"
    assert client.post(f"/mesh/files/{body['id']}/accept", json={"review_id": result["review_id"]}).status_code == 200


@pytest.mark.parametrize("path", ["/mesh/files/"+"aa"*16+"/stage", "/agent/peer/files/offer", "/agent/peer/files/chunk"])
def test_local_chunk_body_bound_before_decode(transfer, path):
    app = FastAPI(); app.include_router(router)
    client = TestClient(app)
    reply = client.post(path, content=b"x"*(P.MAX_BODY+1))
    assert reply.status_code == 413
    assert not D.root().exists()


@pytest.mark.parametrize("invalid", [{"ok": False}, [], None, {"ok": True}])
def test_outgoing_invalid_ack_pauses_without_replay(transfer, monkeypatch, invalid):
    r = outgoing(b"selected synthetic")
    calls = []
    def request(*args, **kwargs):
        kwargs["check"](); calls.append(kwargs["json_body"])
        return P.Response(200, json.dumps(invalid).encode())
    monkeypatch.setattr(P, "request", request)
    with pytest.raises(HTTPException): T.offer(r["id"], "owner", browser())
    assert len(calls) == 1 and "data" not in calls[0]
    assert T.get(r["id"], "owner")["state"] == "uncertain"
    with pytest.raises(HTTPException): T.send_next(r["id"], "owner", browser())
    assert len(calls) == 1


def test_sender_only_sends_after_exact_acceptance_and_reconciles_lost_ack(transfer, monkeypatch):
    data = b"selected synthetic"
    r = outgoing(data); remote = {"state": "offered", "received_bytes": 0, "last_chunk_sha256": None, "verified_sha256": None}; calls = []
    def request(peer, method, path, **kwargs):
        kwargs["check"](); payload = kwargs["json_body"]; calls.append(path)
        record = D.load(r["id"])
        if path.endswith("/chunk"):
            remote.update(received_bytes=len(data), last_chunk_sha256=hashlib.sha256(data).hexdigest())
            raise HTTPException(504, "synthetic lost acknowledgment")
        if path.endswith("/complete"):
            remote.update(state="received", verified_sha256=hashlib.sha256(data).hexdigest())
        return P.Response(200, P.canonical(dict(T._wire(record), ok=True, **remote)))
    monkeypatch.setattr(P, "request", request)
    T.offer(r["id"], "owner", browser())
    with pytest.raises(HTTPException): T.send_next(r["id"], "owner", browser())
    remote["state"] = "accepted"
    T.peer_status(r["id"], "owner", browser())
    with pytest.raises(HTTPException): T.send_next(r["id"], "owner", browser())
    assert T.get(r["id"], "owner")["acknowledged_bytes"] == 0
    T.peer_status(r["id"], "owner", browser())
    assert T.get(r["id"], "owner")["acknowledged_bytes"] == len(data)
    assert T.complete(r["id"], "owner", browser())["state"] == "delivered"
    assert sum(path.endswith("/chunk") for path in calls) == 1


def test_resume_cannot_replace_session_of_live_attempt(transfer, monkeypatch):
    r = outgoing(b"x"); calls = []
    def request(*args, **kwargs):
        before = D.load(r["id"])
        with pytest.raises(HTTPException) as error: T.resume(r["id"], "owner", browser())
        assert error.value.detail["code"] == "transfer_busy"
        assert D.load(r["id"])["credential"] == before["credential"]
        calls.append(1)
        return P.Response(200, P.canonical(dict(T._wire(before), ok=True, state="offered", received_bytes=0)))
    monkeypatch.setattr(P, "request", request)
    assert T.offer(r["id"], "owner", browser())["state"] == "offered"
    assert calls == [1] and not T._ACTIVE


def test_cancel_rechecks_credential_after_waiting_for_store_lock(transfer, monkeypatch):
    body = offer(); accepted(body)
    valid = {"value": True}
    monkeypatch.setattr(S, "validate_session_token", lambda _: valid["value"])
    class Lock:
        def __enter__(self): valid["value"] = False
        def __exit__(self, *args): pass
    monkeypatch.setattr(D, "LOCK", Lock())
    with pytest.raises(HTTPException) as error: T.stop(body["id"], "owner", browser(), discard=True)
    assert error.value.status_code == 401 and D.load(body["id"])["state"] == "accepted"


def test_marker_survives_normal_config_save(transfer):
    T.receive_offer(offer(), access())
    cfg = S.load_node_config(); cfg.node_name = "Changed local name"
    S.save_node_config(cfg)
    assert json.loads(S.NODE_CONFIG_PATH.read_text())["peer_transfers_established"] is True


def test_unknown_receipt_bool_is_not_a_one_byte_completed_file(transfer, monkeypatch):
    r = outgoing(b"x")
    def request(*args, **kwargs):
        record = D.load(r["id"])
        return P.Response(200, P.canonical(dict(T._wire(record), ok=True, state="received", received_bytes=True, verified_sha256=record["sha256"])))
    monkeypatch.setattr(P, "request", request)
    with pytest.raises(HTTPException): T.offer(r["id"], "owner", browser())
    assert T.get(r["id"], "owner")["state"] == "uncertain"


@pytest.mark.parametrize("value", [[], {}, None, True, "invalid"])
def test_malformed_review_identifier_is_a_controlled_conflict(transfer, value):
    body = offer(); T.receive_offer(body, access())
    with pytest.raises(HTTPException) as error: T.accept(body["id"], {"review_id": value}, "owner", browser())
    assert error.value.status_code == 409


@pytest.mark.parametrize("change", [{"expires_at": 10**400}, {"filename": "bad\ud800name"}])
def test_malformed_metadata_does_not_escape_validation(transfer, change):
    with pytest.raises(HTTPException) as error: T.receive_offer(offer(**change), access())
    assert error.value.status_code == 422


def test_failed_metadata_replace_cleans_only_own_temp_and_preserves_index(transfer, monkeypatch):
    body = offer(); T.receive_offer(body, access())
    before = {p.name: p.read_bytes() for p in D.root().iterdir()}
    monkeypatch.setattr(D.os, "replace", lambda *_: (_ for _ in ()).throw(OSError("synthetic disk full")))
    for _ in range(5):
        with pytest.raises(HTTPException): D.save(D.load(body["id"]))
    assert before == {p.name: p.read_bytes() for p in D.root().iterdir()}
    assert not list(D.root().glob("*.tmp"))


def test_orphan_temporary_blocks_unbounded_retry_growth(transfer):
    body = offer(); T.receive_offer(body, access())
    orphan = D.root()/"synthetic-failed-write.tmp"; orphan.write_bytes(b"uncertain metadata")
    before = {p.name: p.read_bytes() for p in D.root().iterdir()}
    for _ in range(3):
        with pytest.raises(HTTPException): T.listing("owner")
    assert before == {p.name: p.read_bytes() for p in D.root().iterdir()}


def test_transfer_metadata_and_errors_are_no_store(transfer):
    app = FastAPI(); app.include_router(router)
    client = TestClient(app)
    assert client.get("/mesh/files").headers["cache-control"] == "no-store"
    client.cookies.set("tli_session", "browser-token")
    assert client.get("/mesh/files").headers["cache-control"] == "no-store"
    assert client.post("/mesh/files/outgoing", json=[]).headers["cache-control"] == "no-store"


def test_actual_public_envelopes_for_browser_fixture(transfer):
    """Optional explicit artifact output contains synthetic public data only."""
    import os
    from pathlib import Path
    body = offer(b"abc")
    T.receive_offer(body, access())
    pending = T.get(body["id"], "owner")
    review = T.review(body["id"], "owner", browser())
    accepted_row = T.accept(body["id"], {"review_id": review["review_id"]}, "owner", browser())
    T.receive("chunk", part(body, b"abc"), access())
    T.receive("complete", wire(body), access())
    received = T.get(body["id"], "owner")
    prepared = outgoing(b"abc")
    prepared = T.get(prepared["id"], "owner")
    result = {"synthetic": True, "capabilities": T.capabilities(), "incoming": pending, "review": review,
              "accepted": accepted_row, "received": received, "prepared": prepared}
    target = os.environ.get("TLI_PEER_TRANSFER_FIXTURE_OUT")
    if target:
        repo = Path(__file__).resolve().parents[1]
        result["sources"] = {str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest() for p in
            [repo/"peer_transfers.py", repo/"peer_transfer_store.py", repo/"peer_transfer_paths.py", repo/"routers/peer_transfer_routes.py", repo/"peer_trust.py"]}
        path = Path(target); path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(result, indent=2), encoding="utf-8")


def test_locked_receiver_returns_consent_conflict_not_peer_auth_failure(transfer, monkeypatch):
    body = offer(); accepted(body)
    app = FastAPI(); app.include_router(router)
    client = TestClient(app, base_url="https://192.168.2.10:8443")
    monkeypatch.setattr(S, "validate_session_token", lambda _: False)
    raw, headers = signed(transfer, "/agent/peer/files/chunk", part(body, b"Synthetic private file"))
    response = client.post("/agent/peer/files/chunk", content=raw, headers=headers)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "receiver_consent_required"
    assert not list(D.root().glob("*.blob"))


def test_parent_replacement_cannot_redirect_exclusive_chunk_write(transfer, monkeypatch):
    body = offer(); accepted(body)
    parent = D.root(); moved = parent.with_name("moved-owned-store"); outside = transfer.root/"outside"
    outside.mkdir(); original = D.Directory.open; attempted = []
    def race(self, name, flags):
        if name.endswith(".blob"):
            attempted.append(True)
            parent.rename(moved)
            parent.symlink_to(outside, target_is_directory=True)
        return original(self, name, flags)
    monkeypatch.setattr(D.Directory, "open", race)
    try:
        T.receive("chunk", part(body, b"Synthetic private file"), access())
    except (HTTPException, OSError, ValueError):
        pass
    assert attempted and list(outside.iterdir()) == []


@pytest.mark.parametrize("peer_id", [[], {}, None, True, ""])
def test_malformed_outgoing_peer_fails_validation_before_storage(transfer, peer_id):
    with pytest.raises(HTTPException) as error:
        T.create({"request_id": "dd"*16, "peer_id": peer_id, "filename": "x", "size": 1}, "owner", browser())
    assert error.value.status_code == 422 and not D.root().exists()
