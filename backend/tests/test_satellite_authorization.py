"""Isolated real-route authority and token lifecycle tests; no phone/network/QR."""
from concurrent.futures import ThreadPoolExecutor
import copy
import json
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

import satellite_store as store
import tli_state as S
from routers import satellite_routes as sat


ENTRY = {"node_id": "sat_0123456789", "secret": "a" * 40, "name": "Old phone",
         "platform": "android", "last_seen": "2026-01-01T00:00:00Z", "battery_level": 42,
         "custom": {"retain": [1, "vendor"]}}
PRIVATE = [("POST", "/mesh/satellite/generate-token"), ("GET", "/mesh/satellite/list"),
           ("DELETE", "/mesh/satellite/" + ENTRY["node_id"])]


@pytest.fixture
def phones(monkeypatch, tmp_path):
    monkeypatch.setattr(S, "DATA_DIR", tmp_path)
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(store, "_SEEN", set())
    monkeypatch.setattr(sat, "_join_tokens", {})
    pin = {"enabled": False}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(pin))
    logs, qr = Mock(), Mock(return_value="data:image/svg+xml;base64,c3ludGhldGlj")
    monkeypatch.setattr(S, "log_debug", logs)
    monkeypatch.setattr(sat, "_make_qr_data_uri", qr)
    clock = [1000.0]
    monkeypatch.setattr(sat, "_now", lambda: clock[0])
    app = FastAPI(); app.include_router(sat.router)
    clients = []
    def client(*, remote=False, secure=False, enabled=None, authenticated=False):
        if enabled is not None:
            pin["enabled"] = enabled
        origin = ("https" if secure else "http") + "://" + ("192.0.2.8:8443" if remote else "localhost:8000")
        value = TestClient(app, base_url=origin, client=("192.0.2.9" if remote else "127.0.0.1", 1234),
                           headers={"Origin": origin, "Sec-Fetch-Site": "same-origin"})
        token = S.create_session_token("owner") if authenticated else None
        if token:
            value.headers["Cookie"] = "tli_session=" + token
        clients.append(value)
        return value, token
    registry = tmp_path / "satellite_registry.json"
    registry.write_text(json.dumps([ENTRY]), encoding="utf-8")
    yield SimpleNamespace(client=client, path=registry, pin=pin, clock=clock, qr=qr, logs=logs,
                          read=lambda: json.loads(registry.read_text(encoding="utf-8")))
    for value in clients:
        value.close()


def issue(client):
    result = client.post("/mesh/satellite/generate-token")
    assert result.status_code == 200, result.text
    return result.json()["token"]


def redeem(client, token):
    return client.post("/mesh/satellite/register", json={"token": token, "name": "New phone", "platform": "ios"})


@pytest.mark.parametrize("method,path,mode", [(method, path, mode) for method, path in PRIVATE
    for mode in ["pin-anonymous", "pin-off-lan", "cross-origin", "missing-origin", "proxy", "peer", "bearer", "stale-cookie", "remote-http"]
    if not (method == "GET" and mode == "missing-origin")])
def test_private_routes_deny_before_registry_or_token_work(phones, monkeypatch, method, path, mode):
    remote = mode in {"pin-off-lan", "remote-http"}
    client, token = phones.client(remote=remote, secure=remote and mode != "remote-http",
                                  enabled=mode != "pin-off-lan", authenticated=mode not in {"pin-anonymous", "pin-off-lan"})
    if mode == "missing-origin":
        del client.headers["Origin"]
    if mode == "cross-origin": client.headers["Origin"] = "https://elsewhere.invalid"
    if mode == "proxy": client.headers["X-Forwarded-For"] = "127.0.0.1"
    if mode == "peer": client.headers["X-TLI-Peer-Identity"] = "synthetic"
    if mode == "bearer": client.headers["Authorization"] = "Bearer synthetic"
    if mode == "stale-cookie": S.revoke_session_token(token)
    read = Mock(side_effect=AssertionError("No private read before authority"))
    monkeypatch.setattr(sat, "_load_reg", read)
    result = client.request(method, path)
    assert result.status_code == (401 if mode in {"pin-anonymous", "stale-cookie"} else 403), result.text
    assert result.headers["cache-control"] == "no-store"
    read.assert_not_called(); phones.qr.assert_not_called()
    assert not sat._join_tokens


@pytest.mark.parametrize("mode", ["open-local", "pin-local", "pin-https"])
def test_browser_management_and_phone_secret_contracts(phones, mode):
    desktop, _ = phones.client(enabled=mode != "open-local", authenticated=mode != "open-local",
                               remote=mode == "pin-https", secure=mode == "pin-https")
    token = issue(desktop)
    phone, _ = phones.client(remote=True, secure=True)
    result = redeem(phone, token)
    assert result.status_code == 200, result.text
    credential = result.json()
    assert result.headers["cache-control"] == "no-store"
    assert redeem(phone, token).status_code == 403
    assert phone.get("/mesh/satellite/list").status_code in {401, 403}
    assert phone.delete("/mesh/satellite/" + ENTRY["node_id"]).status_code in {401, 403}
    listing = desktop.get("/mesh/satellite/list").json()["satellites"]
    assert len(listing) == 2 and all("secret" not in row for row in listing)
    assert "custom" not in listing[0] and phones.read()[0]["custom"] == ENTRY["custom"]
    assert phone.post("/mesh/satellite/heartbeat", json={**credential, "battery_level": 70}).status_code == 200
    assert phone.post("/mesh/satellite/self-remove", json=credential).json() == {"ok": True, "removed": True}
    assert desktop.delete("/mesh/satellite/" + ENTRY["node_id"]).json() == {"ok": True, "removed": 1}
    assert phones.read() == []
    phones.logs.assert_not_called()


@pytest.mark.parametrize("endpoint", ["register", "heartbeat", "self-remove"])
@pytest.mark.parametrize("mode", ["http-lan", "cross-origin", "no-origin", "proxy", "peer", "bearer", "duplicate-origin"])
def test_phone_transport_denial_preserves_registry_and_pairing(phones, endpoint, mode):
    desktop, _ = phones.client()
    token = issue(desktop)
    phone, _ = phones.client(remote=True, secure=mode != "http-lan")
    if mode == "cross-origin": phone.headers["Origin"] = "https://elsewhere.invalid"
    if mode == "no-origin": del phone.headers["Origin"]
    if mode == "proxy": phone.headers["Forwarded"] = "for=127.0.0.1"
    if mode == "peer": phone.headers["X-TLI-Peer-Id"] = "synthetic"
    if mode == "bearer": phone.headers["Authorization"] = "Bearer synthetic"
    headers = [("Origin", "https://192.0.2.8:8443"), ("Origin", "https://192.0.2.8:8443")] if mode == "duplicate-origin" else None
    before = phones.path.read_bytes()
    result = phone.post("/mesh/satellite/" + endpoint, json={**ENTRY, "token": token}, headers=headers)
    assert result.status_code == 403, result.text
    assert result.headers["cache-control"] == "no-store"
    assert not isinstance(result.json()["detail"], dict)
    assert phones.path.read_bytes() == before and token in sat._join_tokens


@pytest.mark.parametrize("endpoint", ["heartbeat", "self-remove"])
def test_phone_secret_cannot_remove_another_phone_and_remains_valid_after_pin_change(phones, endpoint):
    phone, _ = phones.client(remote=True, secure=True)
    before = phones.path.read_bytes()
    wrong = phone.post("/mesh/satellite/" + endpoint, json={**ENTRY, "secret": "b" * 40})
    assert wrong.status_code == 403
    assert wrong.json()["detail"]["code"] == "satellite_credential_invalid"
    assert phones.path.read_bytes() == before
    phones.pin["enabled"] = True
    phone.headers["Cookie"] = "tli_session=expired-browser-cookie"
    assert phone.post("/mesh/satellite/" + endpoint, json=ENTRY).status_code == 200


@pytest.mark.parametrize("change", ["revoke", "pin-mode", "expire"])
def test_issuer_authority_and_expiry_bound_redemption(phones, change):
    desktop, session = phones.client(enabled=True, authenticated=True)
    token = issue(desktop)
    if change == "revoke": S.revoke_session_token(session)
    if change == "pin-mode": phones.pin["enabled"] = False
    if change == "expire": phones.clock[0] += sat._TOKEN_TTL
    phone, _ = phones.client(remote=True, secure=True)
    before = phones.path.read_bytes()
    result = redeem(phone, token)
    assert result.status_code == (403 if change == "expire" else 401)
    assert result.headers["cache-control"] == "no-store"
    assert phones.path.read_bytes() == before and token not in sat._join_tokens


@pytest.mark.parametrize("phase", ["before-redemption", "after-replacement", "during-qr"])
def test_pin_off_on_off_never_restores_old_invitation_authority(phones, monkeypatch, phase):
    desktop, _ = phones.client(enabled=False)
    before = phones.path.read_bytes()
    def cycle():
        phones.pin["enabled"] = True
        S.revoke_all_sessions()
        phones.pin["enabled"] = False
        S.revoke_all_sessions()
    if phase == "during-qr":
        monkeypatch.setattr(sat, "_make_qr_data_uri", lambda _: cycle())
        result = desktop.post("/mesh/satellite/generate-token")
        assert result.status_code == 401 and not sat._join_tokens
        assert phones.path.read_bytes() == before
        return
    token = issue(desktop)
    phone, _ = phones.client(remote=True, secure=True)
    if phase == "before-redemption": cycle()
    else:
        original = store.os.replace
        def replace(source, destination):
            original(source, destination); cycle()
        monkeypatch.setattr(store.os, "replace", replace)
    result = redeem(phone, token)
    assert result.status_code == 401 and "secret" not in result.json()
    assert token not in sat._join_tokens and redeem(phone, token).status_code == 403
    assert len(phones.read()) == (1 if phase == "before-redemption" else 2)
    if phase == "before-redemption": assert phones.path.read_bytes() == before


def test_generated_url_fragment_is_not_logged_and_token_pool_bounded(phones, monkeypatch):
    desktop, _ = phones.client()
    monkeypatch.setattr(sat, "_TOKEN_LIMIT", 2)
    response = desktop.post("/mesh/satellite/generate-token").json()
    assert response["url"] == "http://localhost:8000/#join=satellite&token=" + response["token"]
    assert len(response["token"]) == 64
    issue(desktop)
    assert desktop.post("/mesh/satellite/generate-token").status_code == 429
    phones.clock[0] += sat._TOKEN_TTL
    issue(desktop)
    phones.logs.assert_not_called()


def test_revoke_during_qr_generation_never_publishes_token(phones, monkeypatch):
    desktop, session = phones.client(enabled=True, authenticated=True)
    monkeypatch.setattr(sat, "_make_qr_data_uri", lambda _: S.revoke_session_token(session))
    assert desktop.post("/mesh/satellite/generate-token").status_code == 401
    assert not sat._join_tokens


@pytest.mark.parametrize("phase", ["read", "fsync"])
@pytest.mark.parametrize("change", ["revoke", "pin-mode", "expire"])
def test_issuer_loss_during_redemption_preserves_registry(phones, monkeypatch, phase, change):
    desktop, session = phones.client(enabled=True, authenticated=True)
    token = issue(desktop)
    phone, _ = phones.client(remote=True, secure=True)
    def stop():
        if change == "revoke": S.revoke_session_token(session)
        if change == "pin-mode": phones.pin["enabled"] = False
        if change == "expire": phones.clock[0] += sat._TOKEN_TTL
    if phase == "read":
        original = sat._load_reg
        def read(**kwargs):
            value = original(**kwargs); stop(); return value
        monkeypatch.setattr(sat, "_load_reg", read)
    else:
        original = store.os.fsync
        def fsync(fd):
            original(fd); stop()
        monkeypatch.setattr(store.os, "fsync", fsync)
    before = phones.path.read_bytes()
    result = redeem(phone, token)
    assert result.status_code == (403 if change == "expire" else 401), result.text
    assert phones.path.read_bytes() == before
    assert not list(phones.path.parent.glob(".tli-satellite-*.tmp"))


def test_two_concurrent_redemptions_enroll_exactly_once(phones):
    desktop, _ = phones.client()
    token = issue(desktop)
    first, _ = phones.client(remote=True, secure=True)
    second, _ = phones.client(remote=True, secure=True)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda client: redeem(client, token).status_code, [first, second]))
    assert sorted(results) == [200, 403]
    assert len(phones.read()) == 2


@pytest.mark.parametrize("phase", ["stage", "replace-before", "replace-after"])
def test_write_failure_preserves_original_or_known_commit_and_prevents_duplicate(phones, monkeypatch, phase):
    desktop, _ = phones.client()
    token = issue(desktop)
    phone, _ = phones.client(remote=True, secure=True)
    before = phones.path.read_bytes()
    original = store.os.replace
    def failure(*args):
        if phase == "replace-after": original(*args)
        raise OSError("synthetic interrupted write")
    with monkeypatch.context() as patch:
        patch.setattr(store.os, "fsync" if phase == "stage" else "replace", failure)
        result = redeem(phone, token)
    assert result.status_code == 503, result.text
    if phase == "replace-after":
        assert len(phones.read()) == 2
    else:
        assert phones.path.read_bytes() == before
    assert (token in sat._join_tokens) == (phase == "stage")
    assert redeem(phone, token).status_code == (200 if phase == "stage" else 403)
    assert len(phones.read()) == (1 if phase == "replace-before" else 2)


@pytest.mark.parametrize("change", ["revoke", "pin-mode", "expire"])
def test_completed_registration_retained_but_secret_withheld_on_late_authority_loss(phones, monkeypatch, change):
    desktop, session = phones.client(enabled=True, authenticated=True)
    token = issue(desktop)
    phone, _ = phones.client(remote=True, secure=True)
    original = store.os.replace
    def replace(source, destination):
        original(source, destination)
        if change == "revoke": S.revoke_session_token(session)
        if change == "pin-mode": phones.pin["enabled"] = False
        if change == "expire": phones.clock[0] += sat._TOKEN_TTL
    monkeypatch.setattr(store.os, "replace", replace)
    result = redeem(phone, token)
    assert result.status_code == (403 if change == "expire" else 401)
    assert len(phones.read()) == 2 and "secret" not in result.json()
    assert token not in sat._join_tokens and redeem(phone, token).status_code == 403
    assert len(phones.read()) == 2


@pytest.mark.parametrize("method,path", PRIVATE[1:])
def test_browser_revocation_during_registry_read_hides_private_output_and_preserves_data(phones, monkeypatch, method, path):
    desktop, session = phones.client(enabled=True, authenticated=True)
    before = phones.path.read_bytes()
    original = sat._load_reg
    def read(**kwargs):
        value = original(**kwargs); S.revoke_session_token(session); return value
    monkeypatch.setattr(sat, "_load_reg", read)
    result = desktop.request(method, path)
    assert result.status_code == 401 and ENTRY["name"] not in result.text
    assert result.headers["cache-control"] == "no-store"
    assert phones.path.read_bytes() == before


def test_desktop_removal_revoked_during_staging_does_not_commit(phones, monkeypatch):
    desktop, session = phones.client(enabled=True, authenticated=True)
    before = phones.path.read_bytes()
    original = store.os.fsync
    def fsync(fd):
        original(fd); S.revoke_session_token(session)
    monkeypatch.setattr(store.os, "fsync", fsync)
    assert desktop.delete("/mesh/satellite/" + ENTRY["node_id"]).status_code == 401
    assert phones.path.read_bytes() == before


def test_concurrent_heartbeats_preserve_other_phone_and_unknown_fields(phones):
    other = {**copy.deepcopy(ENTRY), "node_id": "sat_9876543210", "secret": "b" * 40}
    phones.path.write_text(json.dumps([ENTRY, other]), encoding="utf-8")
    first, _ = phones.client(remote=True, secure=True)
    second, _ = phones.client(remote=True, secure=True)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(client.post, "/mesh/satellite/heartbeat", json={**entry, "battery_level": level})
                   for client, entry, level in [(first, ENTRY, 10), (second, other, 90)]]
        assert [f.result().status_code for f in futures] == [200, 200]
    rows = phones.read()
    assert [row["battery_level"] for row in rows] == [10, 90]
    assert all(row["custom"] == ENTRY["custom"] for row in rows)


@pytest.mark.parametrize("endpoint", ["register", "heartbeat", "self-remove"])
def test_invalid_request_does_not_echo_or_cache_credentials(phones, endpoint):
    phone, _ = phones.client(remote=True, secure=True)
    result = phone.post("/mesh/satellite/" + endpoint,
                        json={"node_id": ENTRY["node_id"], "secret": "private credential!", "token": "private token!"})
    assert result.status_code == 422
    assert result.headers["cache-control"] == "no-store"
    assert "private credential" not in result.text and "private token" not in result.text
