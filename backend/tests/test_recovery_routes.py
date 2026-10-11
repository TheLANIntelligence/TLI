"""Recovery HTTP boundaries; temporary persistence and synthetic uploads only."""
import asyncio
import json
from pathlib import Path
import threading

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

import tli_state as S
from intelligence import backups, recovery
from routers import backup_routes
from routers.system_routes import require_session


PASSWORD = "Synthetic recovery password"
PREFIX = "/api/intelligence/backups/recovery/"


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setattr(backups, "_recent_requests", backups.OrderedDict())
    app = FastAPI()
    app.include_router(backup_routes.router)
    monkeypatch.setattr(S, '_active_sessions', {})
    token = S.create_session_token('fixture-owner')
    with TestClient(app, base_url="https://fixture.invalid", cookies={'tli_session':token}) as client:
        yield client


def upload(api, phase="review", *, request_id="recovery-request-00001", extra=None, headers=None):
    fields = {"password": PASSWORD, "request_id": request_id, "destination": "J:/synthetic/new-copy"}
    if phase == "create":
        fields["review_token"] = "synthetic-review-token"
    fields.update(extra or {})
    return api.post(PREFIX + phase, data=fields, files={"file": ("sample.tlibackup", b"synthetic encrypted archive")}, headers=headers)


@pytest.mark.parametrize("phase", ["review", "create"])
def test_route_passes_owner_upload_and_explicit_review_to_one_worker(api, monkeypatch, phase):
    calls = []
    result = {"ok": True, "activated": False, "scope": "separate-data-copy"}
    function = "review_archive" if phase == "review" else "create_copy"
    def service(*args, authorize):
        authorize()
        calls.append(args)
        return result
    monkeypatch.setattr(recovery, function, service)
    response = upload(api, phase)
    assert response.status_code == 200
    assert response.json() == result
    assert response.headers["cache-control"] == "no-store"
    assert calls == [(b"synthetic encrypted archive", PASSWORD, "fixture-owner", "J:/synthetic/new-copy", *(["synthetic-review-token"] if phase == "create" else []))]
    assert upload(api, phase).status_code == 409
    assert len(calls) == 1


@pytest.mark.parametrize("phase", ["review", "create"])
def test_authentication_and_secure_password_transport_precede_workers(monkeypatch, phase):
    app = FastAPI()
    app.include_router(backup_routes.router)
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(recovery, "review_archive", lambda *a: pytest.fail("No unauthenticated work"))
    monkeypatch.setattr(recovery, "create_copy", lambda *a: pytest.fail("No unauthenticated work"))
    with TestClient(app, base_url="https://fixture.invalid") as api:
        assert upload(api, phase).status_code == 401
    app.dependency_overrides[require_session] = lambda: "fixture-owner"
    with TestClient(app, base_url="http://fixture.invalid", client=("192.0.2.8", 5000)) as api:
        assert upload(api, phase).status_code == 400


@pytest.mark.parametrize("phase", ["review", "create"])
@pytest.mark.parametrize("headers", [{"Origin": "https://unrelated.invalid"}, {"Sec-Fetch-Site": "cross-site"}])
def test_cross_site_recovery_is_rejected_before_password_or_filesystem_work(api, monkeypatch, phase, headers):
    monkeypatch.setattr(recovery, "review_archive", lambda *a: pytest.fail("No cross-site work"))
    monkeypatch.setattr(recovery, "create_copy", lambda *a: pytest.fail("No cross-site work"))
    assert upload(api, phase, headers=headers).status_code == 403


@pytest.mark.parametrize("phase", ["review", "create"])
def test_missing_duplicate_unexpected_or_file_valued_fields_are_rejected(api, monkeypatch, phase):
    monkeypatch.setattr(recovery, "review_archive", lambda *a: pytest.fail("Invalid fields"))
    monkeypatch.setattr(recovery, "create_copy", lambda *a: pytest.fail("Invalid fields"))
    fields = [("password", (None, PASSWORD)), ("request_id", (None, "recovery-fields-00001")), ("destination", (None, "J:/synthetic/new-copy")), ("file", ("sample", b"encrypted"))]
    if phase == "create":
        fields.append(("review_token", (None, "synthetic-token")))
    for invalid in (fields[1:], fields + [("destination", (None, "changed"))], fields + [("extra", (None, "unexpected"))], [(key, ("file", b"bytes") if key == "destination" else value) for key, value in fields]):
        assert api.post(PREFIX + phase, files=invalid).status_code == 422


def test_upload_size_limit_prevents_worker_and_navigation_has_no_mutation(api, monkeypatch):
    calls = []
    monkeypatch.setattr(recovery, "review_archive", lambda *a: calls.append(a))
    monkeypatch.setattr(recovery, "create_copy", lambda *a: calls.append(a))
    monkeypatch.setattr(backup_routes, "MAX_VERIFY_BODY", 80)
    assert upload(api).status_code == 413
    assert api.get(PREFIX + "review").status_code == 405
    assert api.get(PREFIX + "create").status_code == 405
    assert api.post("/api/intelligence/backups/restore").status_code == 404
    assert not calls


def test_service_failure_is_not_relabelled_success_and_no_secret_is_returned(api, monkeypatch):
    def failed(*args, **kwargs):
        raise OSError(PASSWORD)
    monkeypatch.setattr(recovery, "create_copy", failed)
    response = upload(api, "create")
    assert response.status_code == 503
    assert PASSWORD not in response.text
    assert "could not confirm" in response.text
    assert "no automatic retry" in response.text
    assert upload(api, "create").status_code == 409


def test_held_worker_blocks_all_backup_operations_until_it_finishes(api, monkeypatch):
    entered, finish = threading.Event(), threading.Event()
    def worker(*args, **kwargs):
        entered.set()
        assert finish.wait(5)
        return {"ok": True, "activated": False}
    monkeypatch.setattr(recovery, "create_copy", worker)
    result = []
    thread = threading.Thread(target=lambda: result.append(upload(api, "create")))
    thread.start()
    try:
        assert entered.wait(5)
        assert upload(api, request_id="review-concurrent-00001").status_code == 409
        assert api.post("/api/intelligence/backups/create", json={"password": PASSWORD, "request_id": "backup-concurrent-00001"}).status_code == 409
    finally:
        finish.set()
        thread.join(5)
    assert result[0].status_code == 200


def test_cancelled_create_keeps_lease_while_filesystem_worker_continues(monkeypatch):
    monkeypatch.setattr(backups, "_recent_requests", backups.OrderedDict())
    entered, finish = threading.Event(), threading.Event()
    def worker(*args, **kwargs):
        entered.set()
        assert finish.wait(5)
        return {"ok": True, "activated": False}
    monkeypatch.setattr(recovery, "create_copy", worker)
    token = S.create_session_token('fixture-owner')
    fields = {"password": PASSWORD, "request_id": "cancel-recovery-00001", "destination": "J:/synthetic/new-copy", "review_token": "synthetic-review"}
    body = b"".join((f'--synthetic\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n').encode() for key, value in fields.items())
    body += b'--synthetic\r\nContent-Disposition: form-data; name="file"; filename="x.tlibackup"\r\nContent-Type: application/octet-stream\r\n\r\nencrypted\r\n--synthetic--\r\n'
    async def exercise():
        async def receive():
            return {"type": "http.request", "body": body, "more_body": False}
        request = Request({"type": "http", "scheme": "https", "server": ("fixture.invalid", 443), "client": ("192.0.2.1", 5000), "headers": [(b"content-type", b"multipart/form-data; boundary=synthetic"),(b'cookie',f'tli_session={token}'.encode())], "method": "POST", "path": PREFIX + "create", "query_string": b""}, receive)
        task = asyncio.create_task(backup_routes.create_recovery(request, "fixture-owner"))
        try:
            for _ in range(100):
                if entered.is_set():
                    break
                await asyncio.sleep(.01)
            assert entered.is_set()
            task.cancel()
            await asyncio.sleep(.05)
            assert not task.done()
            with pytest.raises(HTTPException) as busy:
                with backups.operation():
                    pytest.fail("Cancelled HTTP request cannot release filesystem lease")
            assert busy.value.status_code == 409
        finally:
            finish.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        with backups.operation():
            pass
    asyncio.run(exercise())


def test_archive_review_and_create_reopen_real_encrypted_stores_through_http(api, tmp_path, monkeypatch):
    active = tmp_path / "active" / "data"
    active.mkdir(parents=True)
    sentinel = active / "existing-store.json"
    sentinel.write_bytes(b"existing installation remains unchanged")
    monkeypatch.setattr(S, "DATA_DIR", str(active))
    stamp = "2026-09-07T00:00:00+00:00"
    source = {"owner_id": "archived-person", "conversation_owner_ids": ["archived-person"],
              "exported_at": stamp, "tli_version": "synthetic", "source_host": {"id": "fixture", "name": "Example computer"},
              "source_formats": dict.fromkeys(("notebook", "conversations", "diagnostics"), "encrypted")}
    values = {"account.json": source,
              "notebook.json": {"facts": [{"id": "n-1", "text": "Synthetic retained note", "deleted": False}], "last_updated": stamp},
              "conversations.json": {"c-1": {"id": "c-1", "user_id": "archived-person", "messages": [{"role": "user", "content": "Synthetic question"}]}},
              "diagnostics.json": [{"id": "d-1", "kind": "network", "created_at": stamp, "checks": []}]}
    counts = {"notebook": 1, "conversations": 1, "diagnostics": 1}
    blob = backups._encrypt(backups._pack(values, counts, stamp), PASSWORD)
    destination = tmp_path / "recovered-copy"
    fields = {"password": PASSWORD, "request_id": "http-real-review-00001", "destination": str(destination)}
    reviewed = api.post(PREFIX + "review", data=fields, files={"file": ("synthetic.tlibackup", blob)})
    assert reviewed.status_code == 200, reviewed.text
    assert not destination.exists()
    review = reviewed.json()
    assert review["owner_mapping"] == {"source_owner": "archived-person", "target_owner": "local"}
    fields.update(request_id="http-real-create-00001", review_token=review["review_token"])
    completed = api.post(PREFIX + "create", data=fields, files={"file": ("synthetic.tlibackup", blob)})
    assert completed.status_code == 200, completed.text
    receipt = completed.json()
    assert receipt["readback"]["reader"] == "current-application"
    assert receipt["readback"]["counts"] == counts and receipt["activated"] is False
    assert all(receipt["readback"]["checks"].values())
    assert receipt["destination"] == str(destination)
    assert json.loads((destination / "recovery-receipt.json").read_text()) == receipt
    assert json.loads((destination / "data" / "memory_local.json").read_text())["_tli_enc"] == 1
    assert "Synthetic retained note" not in (destination / "data" / "memory_local.json").read_text()
    assert sentinel.read_bytes() == b"existing installation remains unchanged"
    assert list(active.iterdir()) == [sentinel]
