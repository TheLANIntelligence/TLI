"""Real relay-route authority with synthetic listener/settings boundaries only."""
from __future__ import annotations

import copy
import time
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import tli_state as S
from routers import relay_routes as relay


LOCAL = "http://localhost:8000"
REMOTE = "https://tli.test:8000"
OPERATIONS = ("status", "start", "stop")


@pytest.fixture(autouse=True)
def isolated_authority(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "tli_pin.json")
    monkeypatch.setattr(S, "_active_sessions", {})


@pytest.fixture
def boundaries(monkeypatch):
    """Every relay, settings and log call is recorded without touching a host."""
    state = {
        "calls": [], "running": False, "start_ok": True, "port": 9000,
        "settings": {"enabled": False, "port": 9000, "retained": "setting"},
        "hooks": {}, "saved": [],
    }

    def record(name, *args):
        state["calls"].append((name, *copy.deepcopy(args)))
        hook = state["hooks"].get(name)
        if hook:
            hook()

    def is_running():
        record("is_running")
        return state["running"]

    def start(*, port):
        record("start", port)
        if state["start_ok"]:
            state.update(running=True, port=port)
        return state["start_ok"]

    def stop():
        record("stop")
        state["running"] = False

    def load():
        record("load")
        return copy.deepcopy(state["settings"])

    def save(value):
        record("save", value)
        state["saved"].append(copy.deepcopy(value))
        state["settings"] = copy.deepcopy(value)

    def value(name, result):
        def read():
            record(name)
            return result
        return read

    def url(port=None):
        record("url", port)
        return f"ws://synthetic-relay:{port or state['port']}"

    def log(*args, **kwargs):
        record("log", args, kwargs)

    monkeypatch.setattr(relay._relay, "is_running", is_running)
    monkeypatch.setattr(relay._relay, "start", start)
    monkeypatch.setattr(relay._relay, "stop", stop)
    monkeypatch.setattr(relay._relay, "relay_port", value("port", 9000))
    monkeypatch.setattr(relay._relay, "room_count", value("rooms", 2))
    monkeypatch.setattr(relay._relay, "peer_count", value("peers", 3))
    monkeypatch.setattr(relay._relay, "local_ws_url", url)
    monkeypatch.setattr(relay, "_load_settings", load)
    monkeypatch.setattr(S, "log_debug", log)
    return state


@contextmanager
def browser(origin=LOCAL, client_host="127.0.0.1"):
    app = FastAPI()
    app.include_router(relay.router)
    assert not app.dependency_overrides
    with TestClient(app, base_url=origin, client=(client_host, 41000)) as client:
        yield client


def send(client, operation, *, headers=None, mutation_origin=True, port=9000):
    supplied = dict(headers or {})
    if operation == "status":
        return client.get("/relay/status", headers=supplied)
    if mutation_origin:
        supplied.setdefault("Origin", str(client.base_url).rstrip("/"))
    return client.post("/relay/" + operation, headers=supplied,
                       json={"port": port} if operation == "start" else {})


def enable_pin():
    S.save_pin_config("a" * 64, "b" * 64)
    return S.create_session_token("owner")


def cookie(token):
    return {"Cookie": "tli_session=" + token}


def names(boundaries):
    return [call[0] for call in boundaries["calls"]]


@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize("origin,client_host,pin,session", [
    (LOCAL, "127.0.0.1", True, None),
    (LOCAL, "127.0.0.1", True, "expired"),
    (LOCAL, "127.0.0.1", False, "revoked"),
    (LOCAL, "192.168.1.9", False, None),
    ("http://attacker.test:8000", "127.0.0.1", False, None),
    ("https://attacker.test:8000", "127.0.0.1", False, None),
    (REMOTE, "192.168.1.9", False, None),
    (REMOTE, "192.168.1.9", True, None),
    ("http://tli.test:8000", "192.168.1.9", True, "valid"),
])
def test_denied_authority_never_reads_settings_or_touches_listener(
    boundaries, operation, origin, client_host, pin, session,
):
    token = enable_pin() if pin else S.create_session_token("owner")
    if session == "expired":
        S._active_sessions[token]["expiry"] = time.time() - 1
    elif session == "revoked":
        S.revoke_session_token(token)
    with browser(origin, client_host) as client:
        response = send(client, operation, headers=cookie(token) if session else {})
    assert response.status_code in (401, 403), response.text
    assert boundaries["calls"] == []
    assert boundaries["saved"] == []


@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize("extra", [
    {"Authorization": "Bearer synthetic-token"},
    {"Authorization": "Basic synthetic-token"},
    {"X-TLI-Peer-Id": "synthetic-peer"},
    {"X-TLI-Peer-Signature": "a" * 128},
    {"Forwarded": "for=127.0.0.1;proto=https"},
    {"X-Forwarded-For": "127.0.0.1"},
    {"X-Forwarded-Proto": "https"},
    {"Sec-Fetch-Site": "cross-site"},
    {"Sec-Fetch-Site": "same-site"},
    {"Origin": "https://unrelated.test"},
])
def test_device_proxy_and_cross_origin_headers_cannot_borrow_cookie_authority(
    boundaries, operation, extra,
):
    token = enable_pin()
    with browser(REMOTE, "192.168.1.9") as client:
        response = send(client, operation, headers={**cookie(token), **extra})
    assert response.status_code == 403, response.text
    assert boundaries["calls"] == []


@pytest.mark.parametrize("operation", ("start", "stop"))
@pytest.mark.parametrize("origin", (None, "null", "http://localhost:8001", "http://127.0.0.1:8000"))
def test_mutations_require_exact_origin(boundaries, operation, origin):
    with browser() as client:
        response = send(client, operation, mutation_origin=False,
                        headers={"Origin": origin} if origin else {})
    assert response.status_code == 403
    assert boundaries["calls"] == []


@pytest.mark.parametrize("operation", OPERATIONS)
def test_duplicate_origin_is_rejected_before_read_or_write(boundaries, operation):
    with browser() as client:
        response = client.request("GET" if operation == "status" else "POST",
                                  "/relay/" + operation,
                                  headers=[("Origin", LOCAL), ("Origin", LOCAL)],
                                  json={"port": 9000} if operation == "start" else None)
    assert response.status_code == 403
    assert boundaries["calls"] == []


@pytest.mark.parametrize("origin,client_host,pin", [
    (LOCAL, "127.0.0.1", False),
    ("http://127.0.0.1:8000", "127.0.0.1", False),
    (LOCAL, "::1", False),
    (LOCAL, "127.0.0.1", True),
    (REMOTE, "192.168.1.9", True),
])
def test_allowed_browser_retirement_status_and_cleanup_preserve_settings(
    boundaries, origin, client_host, pin,
):
    token = enable_pin() if pin else None
    headers = cookie(token) if token else {}
    boundaries["settings"].update(enabled=True, port=9123)
    with browser(origin, client_host) as client:
        initial = send(client, "status", headers=headers)
        assert initial.status_code == 200, initial.text
        assert initial.json() == {"running": False, "enabled": False, "saved_enabled": True,
            "available": False, "retired": True, "reason": relay._relay.RETIRED_REASON,
            "port": 9123, "rooms": 0, "peers": 0, "ws_url": None}
        started = send(client, "start", headers=headers)
        assert started.status_code == 410 and "unavailable" in started.json()["detail"]
        boundaries["running"] = True
        status = send(client, "status", headers=headers)
        assert status.json()["running"] is True and status.json()["ws_url"] is None
        stopped = send(client, "stop", headers=headers)
        assert stopped.status_code == 200
        assert stopped.json() == {"ok": True, "running": False, "available": False}
    for response in (initial, started, status, stopped):
        assert response.headers["cache-control"] == "no-store"
    assert boundaries["settings"] == {"enabled": True, "port": 9123, "retained": "setting"}
    assert boundaries["saved"] == []
    assert "start" not in names(boundaries) and names(boundaries).count("stop") == 1
    assert "url" not in names(boundaries)


@pytest.mark.parametrize("payload", [None, "", "{", "[]", '{"port": -1}', '{"port":"invalid"}'])
def test_retired_start_never_parses_payload_or_observes_listener(boundaries, payload):
    with browser() as client:
        response = client.post("/relay/start", headers={"Origin": LOCAL,
                               "Content-Type": "application/json"}, content=payload)
    assert response.status_code == 410
    assert boundaries["calls"] == [] and boundaries["saved"] == []


def test_ipv6_loopback_host_can_read_retirement_without_pin(boundaries):
    headers = {"Host": "[::1]:8000", "Origin": "http://[::1]:8000"}
    with browser(LOCAL, "::1") as client:
        response = send(client, "start", headers=headers)
    assert response.status_code == 410
    assert boundaries["calls"] == []


@pytest.mark.parametrize("operation,boundary,expected", [
    ("status", "is_running", ["is_running"]),
    ("status", "load", ["is_running", "load"]),
    ("stop", "stop", ["stop"]),
])
def test_revocation_during_boundary_prevents_later_disclosure(
    boundaries, operation, boundary, expected,
):
    token = enable_pin()
    boundaries["hooks"][boundary] = lambda: S.revoke_session_token(token)
    with browser() as client:
        response = send(client, operation, headers=cookie(token))
    assert response.status_code == 401
    assert names(boundaries) == expected and boundaries["saved"] == []


@pytest.mark.parametrize("revoke", [False, True])
def test_stop_failure_never_claims_success_and_rechecks_access(boundaries, monkeypatch, revoke):
    token = enable_pin()
    def fail():
        if revoke:
            S.revoke_session_token(token)
        raise RuntimeError("synthetic private listener detail")
    monkeypatch.setattr(relay._relay, "stop", fail)
    with browser() as client:
        response = send(client, "stop", headers=cookie(token))
    assert response.status_code == (401 if revoke else 503)
    assert "synthetic private" not in response.text
    assert boundaries["saved"] == []


def test_still_running_listener_is_not_reported_as_stopped(boundaries, monkeypatch):
    boundaries["running"] = True
    monkeypatch.setattr(relay._relay, "stop", lambda: None)
    with browser() as client:
        response = send(client, "stop")
    assert response.status_code == 503
    assert boundaries["saved"] == []


def test_saved_autostart_cannot_read_settings_or_start_listener(boundaries):
    boundaries["settings"].update(enabled=True, port=9123)
    relay.autostart()
    assert boundaries["calls"] == [] and boundaries["saved"] == []
