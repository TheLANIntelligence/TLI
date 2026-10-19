"""Hub/relay browser authority does not inherit open-LAN or device access."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

import browser_authority as authority
import tli_state as S


@pytest.fixture
def controls(monkeypatch):
    monkeypatch.setattr(S, "_active_sessions", {})
    pin = {"enabled": True}
    monkeypatch.setattr(S, "load_pin_config", lambda: pin.copy())
    token = S.create_session_token("owner-one")
    effect = Mock(return_value={"ok": True})
    app = FastAPI()

    @app.api_route("/control", methods=["GET", "POST"])
    def control(check=Depends(authority.browser_control_access)):
        check()
        return effect()

    return SimpleNamespace(app=app, pin=pin, token=token, effect=effect)


@pytest.mark.parametrize("base,peer,pin,cookie", [
    ("http://localhost:8000", "127.0.0.1", False, False),
    ("http://127.0.0.1:8000", "127.0.0.1", False, False),
    ("http://[::1]:8000", "::1", False, False),
    ("https://localhost:8443", "::1", True, True),
    ("http://localhost:8000", "127.0.0.1", True, True),
    ("https://tli.example.test:8443", "192.0.2.4", True, True),
])
def test_direct_browser_access_retains_local_and_secure_pin_use(controls, base, peer, pin, cookie):
    controls.pin["enabled"] = pin
    # This Starlette TestClient version splits IPv6 URL netloc incorrectly.
    # Supply the real IPv6 authority in Host while preserving an IPv6 peer.
    transport_base = "http://localhost:8000" if "[::1]" in base else base
    host_headers = {"Host": "[::1]:8000"} if "[::1]" in base else {}
    with TestClient(controls.app, base_url=transport_base, client=(peer, 12345), headers=host_headers) as client:
        if cookie:
            client.cookies.set("tli_session", controls.token)
        response = client.post("/control", headers={"Origin": base})
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "no-store"
        assert client.get("/control").status_code == 200  # GET fetch may omit Origin.
    assert controls.effect.call_count == 2


@pytest.mark.parametrize("case", [
    "anonymous-pin", "expired", "revoked", "stale-open-local", "open-lan",
    "open-lan-cookie", "insecure-lan-cookie", "rebound-host", "forwarded",
    "x-forwarded", "bearer-with-cookie", "peer-with-cookie", "cross-origin",
    "null-origin", "duplicate-origin", "missing-origin", "cross-site",
    "same-site", "duplicate-host",
])
def test_denial_precedes_effects(controls, case):
    base, peer = "http://localhost:8000", "127.0.0.1"
    headers = [("Origin", base)]
    cookie = controls.token
    if case == "anonymous-pin":
        cookie = None
    if case in ("revoked", "stale-open-local"):
        S._active_sessions.clear()
    if case == "expired":
        S._active_sessions[cookie]["expiry"] = 0
    if case in ("stale-open-local", "open-lan", "open-lan-cookie", "rebound-host"):
        controls.pin["enabled"] = False
    if case in ("open-lan", "open-lan-cookie", "insecure-lan-cookie"):
        peer = "192.0.2.4"
    if case == "open-lan":
        cookie = None
    if case == "rebound-host":
        base = "http://attacker.example.test:8000"
        headers = [("Origin", base)]
        cookie = None
    if case == "forwarded":
        headers.append(("Forwarded", "for=127.0.0.1"))
    if case == "x-forwarded":
        headers.append(("X-Forwarded-Host", "localhost:8000"))
    if case == "bearer-with-cookie":
        headers.append(("Authorization", "Bearer tlic_fixture"))
    if case == "peer-with-cookie":
        headers.append(("X-TLI-Peer-Signature", "fixture"))
    if case in ("cross-origin", "null-origin"):
        headers = [("Origin", "null" if case == "null-origin" else "http://elsewhere.example.test")]
    if case == "duplicate-origin":
        headers.append(("Origin", base))
    if case == "missing-origin":
        headers = []
    if case in ("cross-site", "same-site"):
        headers.append(("Sec-Fetch-Site", case))
    if case == "duplicate-host":
        headers.extend([("Host", "localhost:8000"), ("Host", "localhost:8000")])

    with TestClient(controls.app, base_url=base, client=(peer, 12345)) as client:
        if cookie:
            client.cookies.set("tli_session", cookie)
        response = client.post("/control", headers=headers)
    assert response.status_code in (401, 403), response.text
    controls.effect.assert_not_called()


@pytest.mark.parametrize("change", ["revoke", "owner", "pin-off", "pin-on"])
def test_check_binds_original_access_across_work(controls, change):
    base = "http://localhost:8000"
    app = FastAPI()
    controls.pin["enabled"] = change != "pin-on"

    @app.post("/control")
    def control(check=Depends(authority.browser_control_access)):
        if change == "revoke":
            S._active_sessions.clear()
        elif change == "owner":
            S._active_sessions[controls.token]["user_id"] = "owner-two"
        else:
            controls.pin["enabled"] = not controls.pin["enabled"]
        check()
        return controls.effect()

    with TestClient(app, base_url=base, client=("127.0.0.1", 12345)) as client:
        if change != "pin-on":
            client.cookies.set("tli_session", controls.token)
        response = client.post("/control", headers={"Origin": base})
    assert response.status_code == 401
    controls.effect.assert_not_called()


def test_cookie_revoked_during_access_capture_cannot_become_open_local(controls, monkeypatch):
    controls.pin["enabled"] = False
    # Reproduce revocation between first cookie validation and shared capture.
    original = authority.operation_access

    def revoke_before_capture(request, owner):
        S._active_sessions.clear()
        return original(request, owner)

    # The local owner is exactly the case where shared open-local fallback works.
    S._active_sessions[controls.token]["user_id"] = "local"
    monkeypatch.setattr(authority, "operation_access", revoke_before_capture)
    with TestClient(controls.app, base_url="http://localhost:8000", client=("127.0.0.1", 12345)) as client:
        client.cookies.set("tli_session", controls.token)
        response = client.post("/control", headers={"Origin": "http://localhost:8000"})
    assert response.status_code == 401
    controls.effect.assert_not_called()


@pytest.mark.parametrize("phase", ["admission", "bound-check", "work"])
def test_pin_off_access_cannot_survive_global_revocation(controls, monkeypatch, phase):
    controls.pin["enabled"] = False
    original = authority.operation_access

    def cycle_pin():
        controls.pin["enabled"] = True
        S.revoke_all_sessions()
        controls.pin["enabled"] = False
        S.revoke_all_sessions()

    def capture(request, owner):
        if phase == "admission":
            cycle_pin()
        captured = original(request, owner)
        def check():
            captured()
            if phase == "bound-check":
                cycle_pin()
        return check

    monkeypatch.setattr(authority, "operation_access", capture)
    app = FastAPI()
    @app.post("/control")
    def control(check=Depends(authority.browser_control_access)):
        if phase == "work":
            cycle_pin()
        check()
        return controls.effect()

    with TestClient(app, base_url="http://localhost:8000", client=("127.0.0.1", 12345)) as client:
        response = client.post("/control", headers={"Origin": "http://localhost:8000"})
    assert response.status_code == 401
    controls.effect.assert_not_called()
