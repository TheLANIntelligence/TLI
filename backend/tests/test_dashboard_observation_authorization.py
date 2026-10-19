"""Dashboard projections retain browser authority and native Today credentials."""
from collections import deque
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import activity_summary as activity
import companion_auth as companion
import event_bus as bus
import narrator_settings
import tli_state as S
from narrator_policy import NarratorPolicy
from routers import dashboard_presence as dp


LOCAL = "http://localhost:8000"
REMOTE = "https://tli.test:8000"
PRIVATE = "Synthetic private activity"
READS = ("/dashboard/state", "/dashboard/narrator/current", "/dashboard/narrator/settings",
         "/dashboard/activity-summary", "/dashboard/action/current", "/dashboard/command-center")
CURSOR = {"stream_id": "a" * 32, "sequence": 0}
ROUTES = [("GET", path, None) for path in READS] + [
    ("PUT", "/dashboard/narrator/settings", {"mode": "quiet"}),
    ("POST", "/dashboard/activity-summary/review", CURSOR),
]


@pytest.fixture
def surface(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "tli_pin.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(bus, "_events", deque(maxlen=bus.MAX_EVENTS))
    monkeypatch.setattr(bus, "_journal", None)
    monkeypatch.setattr(bus, "_subscribers", [])
    monkeypatch.setattr(bus, "_post_emit_hooks", [])
    monkeypatch.setattr(bus, "_loop", None)
    monkeypatch.setattr(bus, "_sequence", 0)
    monkeypatch.setattr(bus, "_stream_id", CURSOR["stream_id"])
    monkeypatch.setattr(dp, "_narrator_policy", NarratorPolicy())
    calls = []

    def tracked(name, result):
        def call(*args, **kwargs):
            calls.append(name)
            return result(*args, **kwargs) if callable(result) else result
        return call

    monkeypatch.setattr(dp, "_read_state", tracked("state", {
        "cpu_pct": 20, "ram_pct": 30, "disk_pct_by_drive": {"Synthetic-drive": 40},
        "device_count": 1, "last_event_ts": 100, "host": {"name": PRIVATE}}))
    monkeypatch.setattr(dp, "_refresh_narrator", tracked("refresh", None))
    monkeypatch.setattr(dp, "_get_narrator", tracked("narrator", {"type": "status", "text": PRIVATE}))
    monkeypatch.setattr(dp, "get_top_action", tracked("action", {
        "id": "synthetic-action", "title": PRIVATE, "context": "private context",
        "confirm_label": "Review", "dismiss_label": "Later", "score": 50}))
    monkeypatch.setattr(dp, "_build_command_center_snapshot", tracked("snapshot", lambda owner, **kwargs: {
        "ok": True, "narrator": {"text": PRIVATE}, "owner_for_test": owner}))
    monkeypatch.setattr(narrator_settings, "read", tracked("settings_read", narrator_settings.read))
    monkeypatch.setattr(narrator_settings, "save", tracked("settings_save", narrator_settings.save))
    monkeypatch.setattr(activity, "get_summary", tracked("summary", activity.get_summary))
    monkeypatch.setattr(activity, "mark_reviewed", tracked("review", activity.mark_reviewed))
    app = FastAPI()
    app.include_router(dp.router)
    assert not app.dependency_overrides
    return app, calls


def pin_cookie(owner="alice"):
    S.save_pin_config("a" * 64, "b" * 64)
    return S.create_session_token(owner)


def paired(owner="alice"):
    invitation, _ = companion.create_pairing(owner, REMOTE, "f" * 64)
    return companion.redeem_pairing(invitation, REMOTE, "f" * 64, "Synthetic phone", "ios")


def request(app, method, path, body=None, *, origin=REMOTE, host="192.168.1.8", headers=None):
    with TestClient(app, base_url=origin, client=(host, 40000)) as client:
        return client.request(method, path, json=body, headers=headers or {})


@pytest.mark.parametrize("method,path,body", ROUTES)
@pytest.mark.parametrize("mode", ("open_lan", "missing_cookie", "revoked_cookie", "cross_site", "proxy", "peer"))
def test_denied_browser_never_reads_private_projection(surface, mode, method, path, body):
    app, calls = surface
    headers = {"Origin": REMOTE}
    if mode != "open_lan":
        token = pin_cookie()
        if mode != "missing_cookie":
            headers["Cookie"] = "tli_session=" + token
        if mode == "revoked_cookie":
            S._active_sessions.clear()
        if mode == "cross_site":
            headers["Sec-Fetch-Site"] = "cross-site"
        if mode == "proxy":
            headers["X-Forwarded-For"] = "127.0.0.1"
        if mode == "peer":
            headers["X-TLI-Peer-Id"] = "synthetic-peer"
    response = request(app, method, path, body, headers=headers)
    assert response.status_code in (401, 403)
    assert calls == []
    assert PRIVATE not in response.text


@pytest.mark.parametrize("method,path,body", ROUTES)
@pytest.mark.parametrize("mode", ("local_open", "local_pin", "remote_pin"))
def test_browser_contracts_are_available_with_real_authority(surface, mode, method, path, body):
    app, calls = surface
    origin = REMOTE if mode == "remote_pin" else LOCAL
    headers = {"Origin": origin}
    if mode != "local_open":
        headers["Cookie"] = "tli_session=" + pin_cookie()
    response = request(app, method, path, body, origin=origin,
                       host="192.168.1.8" if mode == "remote_pin" else "127.0.0.1", headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "no-store"
    assert calls
    if path.endswith("command-center"):
        assert response.json()["owner_for_test"] == ("local" if mode == "local_open" else "alice")
    elif path.endswith("activity-summary"):
        assert {"events", "retained_events", "cursor", "coverage_note"} <= response.json().keys()
    elif path.endswith("activity-summary/review"):
        assert response.json()["cursor"] == CURSOR


@pytest.mark.parametrize("method,path,body", [row for row in ROUTES if "activity-summary" not in row[1]])
def test_real_companion_cannot_use_browser_projection_exception(surface, method, path, body):
    app, calls = surface
    device = paired()
    response = request(app, method, path, body, headers={"Authorization": "Bearer " + device["credential"]})
    assert response.status_code == 403
    assert calls == []


@pytest.mark.parametrize("pin_enabled", (False, True))
def test_native_today_preserves_raw_contract_and_owner_review(surface, pin_enabled):
    app, calls = surface
    if pin_enabled:
        pin_cookie()
    device = paired("phone-owner")
    headers = {"Authorization": "Bearer " + device["credential"]}
    bus.emit_event("device", "warn", PRIVATE, "Private synthetic detail", node="Synthetic room")
    response = request(app, "GET", "/dashboard/activity-summary", headers=headers)
    assert response.status_code == 200
    data = response.json()
    assert response.headers["Cache-Control"] == "no-store"
    assert data["events"][0]["title"] == PRIVATE
    assert data["retained_events"] == data["events"]
    assert "owner" not in data["events"][0]  # Host history has no invented ownership.
    reviewed = request(app, "POST", "/dashboard/activity-summary/review", data["cursor"], headers=headers)
    assert reviewed.status_code == 200
    assert reviewed.json()["cursor"] == data["cursor"]
    assert activity.get_summary("phone-owner")["total"] == 0
    assert activity.get_summary("another-owner")["total"] == 1


@pytest.mark.parametrize("method,path,body", [row for row in ROUTES if "activity-summary" in row[1]])
@pytest.mark.parametrize("mode", ("revoked", "malformed", "duplicate", "http", "origin", "same_site", "proxy", "peer"))
def test_native_credentials_never_fall_back_to_open_local(surface, mode, method, path, body):
    app, calls = surface
    device = paired()
    token = device["credential"]
    headers = {"Authorization": "Bearer " + token}
    origin = REMOTE
    if mode == "revoked":
        companion.revoke_device("alice", device["device_id"])
    elif mode == "malformed":
        headers["Authorization"] = "Bearer invalid"
    elif mode == "duplicate":
        headers = [("Authorization", "Bearer " + token), ("Authorization", "Bearer " + token)]
    elif mode == "http":
        origin = LOCAL
    elif mode == "origin":
        headers["Origin"] = "https://other.test"
    elif mode == "same_site":
        headers["Sec-Fetch-Site"] = "same-site"
    elif mode == "proxy":
        headers["Forwarded"] = "for=127.0.0.1"
    elif mode == "peer":
        headers["X-TLI-Peer-Id"] = "synthetic-peer"
    response = request(app, method, path, body, headers=headers, origin=origin, host="127.0.0.1")
    assert response.status_code in (401, 403)
    assert calls == []


@pytest.mark.parametrize("path,boundary", [
    ("/dashboard/state", "_read_state"), ("/dashboard/narrator/current", "_get_narrator"),
    ("/dashboard/narrator/settings", "_get_narrator"), ("/dashboard/action/current", "get_top_action"),
    ("/dashboard/command-center", "_build_command_center_snapshot"),
])
def test_browser_revoked_during_projection_does_not_disclose_result(surface, monkeypatch, path, boundary):
    app, _ = surface
    token = pin_cookie()
    original = getattr(dp, boundary)
    def revoke(*args, **kwargs):
        result = original(*args, **kwargs)
        S._active_sessions.clear()
        return result
    monkeypatch.setattr(dp, boundary, revoke)
    response = request(app, "GET", path, headers={"Cookie": "tli_session=" + token})
    assert response.status_code == 401
    assert PRIVATE not in response.text


@pytest.mark.parametrize("native", (False, True))
@pytest.mark.parametrize("phase", ("summary", "review_snapshot", "review_read", "review_write"))
def test_original_credential_rechecked_around_activity_work(surface, monkeypatch, native, phase):
    app, _ = surface
    if native:
        device = paired()
        headers = {"Authorization": "Bearer " + device["credential"]}
        revoke = lambda: companion.revoke_device("alice", device["device_id"])
    else:
        token = pin_cookie()
        headers = {"Cookie": "tli_session=" + token, "Origin": REMOTE}
        revoke = lambda: S._active_sessions.clear()
    bus.emit_event("device", "info", PRIVATE, "Private synthetic detail")
    cursor = bus.activity_snapshot()["cursor"]
    writes = []
    original_write = activity.write_private
    def write(*args, **kwargs):
        writes.append(args)
        result = original_write(*args, **kwargs)
        if phase == "review_write":
            revoke()
        return result
    monkeypatch.setattr(activity, "write_private", write)
    boundary = {"summary": "get_summary", "review_snapshot": "activity_snapshot", "review_read": "read_private"}.get(phase)
    if boundary:
        original = getattr(activity, boundary)
        def interrupted(*args, **kwargs):
            result = original(*args, **kwargs)
            revoke()
            return result
        monkeypatch.setattr(activity, boundary, interrupted)
    summary = phase == "summary"
    response = request(app, "GET" if summary else "POST",
                       "/dashboard/activity-summary" + ("" if summary else "/review"),
                       None if summary else cursor, headers=headers)
    assert response.status_code == 401
    assert PRIVATE not in response.text
    assert len(writes) == (1 if phase == "review_write" else 0)


def test_revoked_during_settings_read_does_not_change_policy(surface, monkeypatch):
    app, calls = surface
    token = pin_cookie()
    def read():
        S._active_sessions.clear()
        return {"mode": "quiet"}
    monkeypatch.setattr(narrator_settings, "read", read)
    response = request(app, "GET", "/dashboard/narrator/settings", headers={"Cookie": "tli_session=" + token})
    assert response.status_code == 401
    assert dp._narrator_policy.mode == "balanced"
    assert "refresh" not in calls


def test_revoked_during_settings_save_suppresses_narrator_and_policy_update(surface, monkeypatch):
    app, calls = surface
    token = pin_cookie()
    original = narrator_settings.save
    def save(mode, **kwargs):
        result = original(mode, **kwargs)
        S._active_sessions.clear()
        return result
    monkeypatch.setattr(narrator_settings, "save", save)
    response = request(app, "PUT", "/dashboard/narrator/settings", {"mode": "quiet"},
                       headers={"Cookie": "tli_session=" + token, "Origin": REMOTE})
    assert response.status_code == 401
    assert PRIVATE not in response.text
    assert dp._narrator_policy.mode == "balanced"
    assert "refresh" not in calls


@pytest.mark.parametrize("boundary", ("read", "fsync"))
def test_revoked_inside_settings_save_preserves_previous_bytes_and_cleans_temp(surface, monkeypatch, tmp_path, boundary):
    app, calls = surface
    narrator_settings.save("quiet")
    path = tmp_path / "narrator-settings.json"
    previous = path.read_bytes()
    token = pin_cookie()
    if boundary == "read":
        original = narrator_settings.read
        def read():
            result = original()
            S._active_sessions.clear()
            return result
        monkeypatch.setattr(narrator_settings, "read", read)
    else:
        original = narrator_settings.os.fsync
        def fsync(fd):
            original(fd)
            S._active_sessions.clear()
        monkeypatch.setattr(narrator_settings.os, "fsync", fsync)
    calls.clear()
    response = request(app, "PUT", "/dashboard/narrator/settings", {"mode": "detailed"},
                       headers={"Cookie": "tli_session=" + token, "Origin": REMOTE})
    assert response.status_code == 401
    assert path.read_bytes() == previous
    assert list(tmp_path.glob("narrator-settings.json.tmp-*")) == []
    assert dp._narrator_policy.mode == "balanced"
    assert "refresh" not in calls and "narrator" not in calls


@pytest.mark.parametrize("method,path,body", ROUTES)
def test_stale_browser_cookie_cannot_fall_back_to_loopback_when_pin_off(surface, method, path, body):
    app, calls = surface
    response = request(app, method, path, body, origin=LOCAL, host="127.0.0.1",
                       headers={"Cookie": "tli_session=revoked", "Origin": LOCAL})
    assert response.status_code == 401
    assert calls == []
