"""Real HTTP boundary with synthetic persistence and no running application."""
import asyncio
from collections import OrderedDict
import io
import json
import hashlib
from pathlib import Path
import threading
import time

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request
import pytest

import vault_backup as backup
import tli_state as S
from routers import vault_backup_routes as routes
from tests.test_vault_backups import vault, make, ARCHIVE_PASSWORD, NEW_PASSWORD


@pytest.fixture
def client(vault, monkeypatch):
    monkeypatch.setattr(routes, "_downloads", OrderedDict())
    monkeypatch.setattr(backup, "_requests", OrderedDict())
    monkeypatch.setattr(S, '_active_sessions', {})
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled':True})
    token = S.create_session_token('owner')
    class SessionOwner(list):
        def __setitem__(self, index, value):
            super().__setitem__(index, value)
            if value is None:
                S._active_sessions.pop(token, None)
            else:
                S._active_sessions[token] = {'expiry':time.time()+3600,'user_id':value}
    owner = SessionOwner(['owner'])
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app, base_url="https://testserver", raise_server_exceptions=False, cookies={'tli_session':token}) as http:
        yield http, owner
    for token in list(routes._downloads):
        routes._remove_download(token)


def fields(**extra):
    return {"password": ARCHIVE_PASSWORD, "request_id": "request_identifier_" + str(time.monotonic_ns()), **extra}


def test_check_then_create_stream_download_and_no_second_transfer(client):
    http, _ = client
    result = http.post("/vault/backups/check", json={"request_id": "explicit_check_12345"})
    assert result.status_code == 200 and result.json()["archive_created"] is False
    result = http.post("/vault/backups/create", json=fields())
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["downloaded"] is False and len(routes._downloads) == 1
    path = next(iter(routes._downloads.values()))["path"]
    downloaded = http.get(data["download_url"])
    assert downloaded.status_code == 200 and downloaded.content.startswith(backup.MAGIC)
    assert downloaded.headers["cache-control"] == "no-store"
    assert not path.exists() and not routes._downloads
    assert http.get(data["download_url"]).status_code == 404
    verified = http.post("/vault/backups/verify", data=fields(), files={"file": ("portable.tlivaultbackup", downloaded.content)})
    assert verified.status_code == 200 and verified.json()["restored"] is False


def test_owner_binding_range_refusal_explicit_discard_and_expiry(client):
    http, owner = client
    data = http.post("/vault/backups/create", json=fields()).json()
    owner[0] = "other"
    assert http.get(data["download_url"]).status_code == 404
    assert http.delete(data["download_url"]).status_code == 200
    assert len(routes._downloads) == 1
    owner[0] = "owner"
    assert http.get(data["download_url"], headers={"Range": "bytes=0-50"}).status_code == 416
    assert http.post("/vault/backups/create", json=fields()).status_code == 409
    assert http.delete(data["download_url"]).json() == {"ok": True, "discarded": True}
    assert not routes._downloads
    data = http.post("/vault/backups/create", json=fields()).json()
    token = data["download_url"].rsplit("/", 1)[1]
    path = routes._downloads[token]["path"]
    routes._downloads[token]["expires"] = 0
    assert http.get(data["download_url"]).status_code == 404 and not path.exists()


@pytest.mark.parametrize("endpoint", ["/create", "/check", "/verify", "/recovery/review", "/recovery/create"])
def test_cross_site_password_requests_rejected_before_work(client, monkeypatch, endpoint):
    http, _ = client
    monkeypatch.setattr(backup, "create_archive", lambda *a: pytest.fail("No cross-site source reads"))
    response = http.post("/vault/backups" + endpoint, json=fields(), headers={"Origin": "https://unrelated.invalid"})
    assert response.status_code == 403


def test_expired_session_after_archive_creation_cleans_ciphertext(client, monkeypatch, tmp_path):
    http, owner = client
    created = tmp_path / "synthetic.encrypted"
    def prepare(*args):
        created.write_bytes(b"ciphertext")
        owner[0] = None
        return created, {"archive_sha256": "a" * 64}
    monkeypatch.setattr(backup, "create_archive", prepare)
    response = http.post("/vault/backups/create", json=fields())
    assert response.status_code == 401 and not created.exists() and not routes._downloads


def test_real_http_review_recovery_and_duplicate_request(client, vault, tmp_path):
    http, _ = client
    raw, _ = make(vault)
    destination = str(tmp_path / "http-recovery")
    form = fields(destination=destination)
    reviewed = http.post("/vault/backups/recovery/review", data=form, files={"file": ("x.tlivaultbackup", raw)})
    assert reviewed.status_code == 200, reviewed.text
    assert not Path(destination).exists()
    attempted = fields(destination=destination, review_token=reviewed.json()["review_token"], new_vault_password=NEW_PASSWORD)
    recovered = http.post("/vault/backups/recovery/create", data=attempted, files={"file": ("x.tlivaultbackup", raw)})
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["created"] is True and recovered.json()["readback"]["checks"]["current_readers"] is True
    assert http.post("/vault/backups/recovery/create", data=attempted, files={"file": ("x", raw)}).status_code == 409


def test_cancelled_creation_owns_worker_and_removes_finished_archive(vault, monkeypatch, tmp_path):
    started, finish = threading.Event(), threading.Event()
    path = tmp_path / "cancelled.encrypted"
    monkeypatch.setattr(routes, "_downloads", OrderedDict())
    token = S.create_session_token('owner')
    def prepare(*args):
        started.set()
        finish.wait(5)
        path.write_bytes(b"ciphertext")
        return path, {"archive_sha256": "a" * 64}
    monkeypatch.setattr(backup, "create_archive", prepare)
    async def scenario():
        body = json.dumps(fields()).encode()
        sent = False
        async def receive():
            nonlocal sent
            if sent:
                return {"type": "http.disconnect"}
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        request = Request({"type": "http", "method": "POST", "scheme": "https", "server": ("testserver", 443),
                           "path": "/vault/backups/create", "query_string": b"", "headers": [(b'cookie',f'tli_session={token}'.encode())], "client": ("127.0.0.1", 1234)}, receive)
        task = asyncio.create_task(routes.create(request, "owner"))
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        with pytest.raises(HTTPException):
            with backup.operation():
                pass
        finish.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        with backup.operation():
            pass
    asyncio.run(scenario())
    assert not path.exists() and not routes._downloads


def test_failed_download_stream_releases_ciphertext(client, tmp_path):
    path = tmp_path / "stream-interrupted.encrypted"
    path.write_bytes(b"ciphertext" * 100)
    token = "stream-interrupted"
    routes._downloads[token] = {"path": path, "owner": "owner", "expires": time.monotonic() + 60, "sending": True,
                               "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    async def scenario():
        response = routes._Download(path, token=token)
        async def receive():
            return {"type": "http.disconnect"}
        async def send(message):
            if message["type"] == "http.response.body":
                raise RuntimeError("client disconnected")
        with pytest.raises(RuntimeError):
            await response({"type": "http", "method": "GET", "headers": [], "extensions": {}, "asgi": {"spec_version": "2.4"}}, receive, send)
    asyncio.run(scenario())
    assert not path.exists() and token not in routes._downloads


def test_multipart_duplicate_fields_and_limits_fail_without_decoding(client, monkeypatch):
    http, _ = client
    monkeypatch.setattr(backup, "scan_archive", lambda *args: pytest.fail("Invalid upload must not be decoded"))
    result = http.post("/vault/backups/verify", data=fields(), files=[("file", ("a", b"bad")), ("file", ("b", b"bad"))])
    assert result.status_code == 422
    monkeypatch.setattr(backup, "MAX_ARCHIVE", 1)
    result = http.post("/vault/backups/verify", data=fields(), files={"file": ("a", b"x" * 70000)})
    assert result.status_code == 413


def test_http_nonloopback_and_revoked_session_never_inspect_vault(client):
    http, owner = client
    assert http.post("http://testserver/vault/backups/check", json={"request_id": "non_loopback_check_123"}).status_code == 400
    owner[0] = None
    assert http.get("/vault/backups/capabilities").status_code == 401
    assert http.post("/vault/backups/check", json={"request_id": "revoked_session_check_123"}).status_code == 401


def test_prepared_receipt_can_be_resumed_only_by_its_unlocked_owner(client):
    import vault_security as security
    http, owner = client
    assert http.get("/vault/backups/prepared").json()["prepared"] is False
    created = http.post("/vault/backups/create", json=fields()).json()
    resumed = http.get("/vault/backups/prepared").json()
    assert resumed["prepared"] is True and resumed["download_url"] == created["download_url"]
    assert resumed["archive_sha256"] == created["archive_sha256"]
    assert "password" not in json.dumps(resumed)
    owner[0] = "another"
    assert http.get("/vault/backups/prepared").status_code == 403
    owner[0] = "owner"
    security.UNLOCKED_VAULTS.clear()
    assert http.get("/vault/backups/prepared").status_code == 403


def test_download_never_serves_replaced_plaintext_temp(client):
    http, _ = client
    created = http.post("/vault/backups/create", json=fields()).json()
    entry = next(iter(routes._downloads.values()))
    entry["path"].write_bytes(b"unrelated private plaintext")
    response = http.get(created["download_url"])
    assert response.status_code == 503 and b"unrelated private plaintext" not in response.content
    assert not routes._downloads
