"""Real browser/Companion checks against synthetic credentials and temporary state."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request as StarletteRequest

import companion_auth
import private_client_authority as authority
import tli_state as S


ORIGIN = "https://tli.example.test:8443"
LOCAL = "http://localhost:8000"


@pytest.fixture
def access(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "pin.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "_session_revocation_epoch", object())
    S.save_pin_config("a" * 64, "b" * 64)
    token = S.create_session_token("alice")
    invitation, _ = companion_auth.create_pairing("alice", ORIGIN, "synthetic")
    paired = companion_auth.redeem_pairing(invitation, ORIGIN, "synthetic", "Test phone", "test")
    env = SimpleNamespace(token=token, paired=paired, work=Mock(return_value={"private": "saved text"}), captured=None)
    app = FastAPI()

    @app.api_route("/read", methods=["GET", "POST"])
    def read(access_pair=Depends(authority.private_client_access)):
        owner, check = access_pair
        env.captured = access_pair
        value = authority.checked_call(check, env.work)
        return authority.checked_json(check, {"owner": owner, **value})

    clients = []

    def connect(mode="browser", *, headers=None, origin=None, peer=None):
        base = origin or (LOCAL if mode == "local" else ORIGIN)
        request_headers = dict(headers or {})
        if mode == "browser":
            request_headers.setdefault("Cookie", "tli_session=" + token)
            request_headers.setdefault("Origin", base)
        elif mode == "native":
            request_headers.setdefault("Authorization", "Bearer " + paired["credential"])
        elif mode == "local":
            request_headers.setdefault("Origin", base)
        client = TestClient(app, base_url=base, client=(peer or ("127.0.0.1" if base == LOCAL else "192.0.2.10"), 1234), headers=request_headers)
        clients.append(client)
        return client

    env.app, env.connect = app, connect
    yield env
    for client in clients:
        client.close()


@pytest.mark.parametrize("mode,pin", [("browser", True), ("browser", False), ("local", False), ("native", True), ("native", False)])
def test_supported_client_keeps_its_original_owner(access, mode, pin):
    if not pin:
        S.PIN_CONFIG_FILE.write_text('{"enabled":false}')
    client = access.connect(mode, origin=LOCAL if mode == "browser" and not pin else None)
    response = client.get("/read")
    assert response.status_code == 200, response.text
    assert response.json() == {"owner": "local" if mode == "local" else "alice", "private": "saved text"}
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("case,status", [
    ("anonymous", 401), ("pin-off-lan", 403), ("pin-off-rebound", 403),
    ("stale-cookie", 401), ("insecure-browser", 403), ("browser-cross-origin", 403),
    ("native-http", 403), ("native-cookie", 403), ("native-origin", 403),
    ("native-fetch", 403), ("native-forwarded", 403), ("native-x-forwarded", 403),
    ("native-peer", 403), ("empty-authorization", 401), ("bad-bearer", 401),
    ("host-start", 401), ("revoked-native", 401), ("duplicate-authorization", 401),
    ("duplicate-host", 403), ("bad-host-port", 403), ("bad-host-high-port", 403), ("bad-host-path", 403),
])
def test_denial_precedes_private_work(access, case, status):
    mode, origin, peer = "native", ORIGIN, "192.0.2.10"
    headers = {}
    if case in {"anonymous", "pin-off-lan", "pin-off-rebound"}:
        mode = "anonymous"
        if case != "anonymous":
            S.PIN_CONFIG_FILE.write_text('{"enabled":false}')
        if case == "pin-off-rebound":
            origin, peer = "http://rebound.example.test", "127.0.0.1"
    elif case == "stale-cookie":
        mode, origin, peer = "browser", LOCAL, "127.0.0.1"
        S.PIN_CONFIG_FILE.write_text('{"enabled":false}')
        S._active_sessions.clear()
    elif case == "insecure-browser":
        mode, origin = "browser", "http://tli.example.test"
    elif case == "browser-cross-origin":
        mode, headers = "browser", {"Origin": "https://other.example.test"}
    elif case == "native-http":
        origin = "http://tli.example.test"
    elif case == "native-cookie":
        headers["Cookie"] = "tli_session=" + access.token
    elif case == "native-origin":
        headers["Origin"] = ORIGIN
    elif case == "native-fetch":
        headers["Sec-Fetch-Mode"] = "cors"
    elif case == "native-forwarded":
        headers["Forwarded"] = "for=127.0.0.1"
    elif case == "native-x-forwarded":
        headers["X-Forwarded-Host"] = "localhost"
    elif case == "native-peer":
        headers["X-TLI-Peer-Signature"] = "fixture"
    elif case == "empty-authorization":
        headers["Authorization"] = ""
    elif case == "bad-bearer":
        headers["Authorization"] = "Basic tlic_invalid"
    elif case == "host-start":
        headers["Authorization"] = "Bearer tlih_invalid"
    elif case == "revoked-native":
        companion_auth.revoke_device("alice", access.paired["device_id"])
        S.PIN_CONFIG_FILE.write_text('{"enabled":false}')  # An invalid explicit credential never downgrades.
    elif case == "bad-host-port":
        headers["Host"] = "tli.example.test:0"
    elif case == "bad-host-high-port":
        headers["Host"] = "tli.example.test:99999"
    elif case == "bad-host-path":
        headers["Host"] = "tli.example.test/private"
    client = access.connect(mode, headers=headers, origin=origin, peer=peer)
    duplicates = None
    if case == "duplicate-authorization":
        duplicates = [("Authorization", "Bearer " + access.paired["credential"])] * 2
    elif case == "duplicate-host":
        duplicates = [("Host", "tli.example.test:8443")] * 2
    response = client.get("/read", headers=duplicates)
    assert response.status_code == status, response.text
    assert response.headers["cache-control"] == "no-store"
    assert "saved text" not in response.text and access.paired["credential"] not in response.text
    access.work.assert_not_called()


def test_native_missing_host_is_denied(access):
    request = StarletteRequest({"type": "http", "scheme": "https", "path": "/read", "root_path": "",
        "query_string": b"", "server": ("tli.example.test", 443), "client": ("192.0.2.10", 1234),
        "headers": [(b"authorization", ("Bearer " + access.paired["credential"]).encode())]})
    with pytest.raises(HTTPException) as error:
        authority.private_client_access(request, authority.Response())
    assert error.value.status_code == 403


@pytest.mark.parametrize("mode", ["browser", "native"])
@pytest.mark.parametrize("kind,status", [("revoked", 401), ("owner", 401), ("unavailable", 503)])
def test_authority_failure_is_sticky_after_original_state_returns(access, mode, kind, status):
    client = access.connect(mode)
    assert client.get("/read").status_code == 200
    _, check = access.captured
    if mode == "native":
        path = companion_auth._path()
        before = path.read_bytes()
        if kind == "unavailable":
            path.write_bytes(b"damaged credential state")
        else:
            value = companion_auth._read()
            value["devices"][access.paired["device_id"]]["revoked_at" if kind == "revoked" else "owner_id"] = "changed"
            companion_auth._write(value)
        restore = lambda: path.write_bytes(before)
    elif kind == "unavailable":
        before = S.PIN_CONFIG_FILE.read_bytes()
        S.PIN_CONFIG_FILE.write_bytes(b"damaged PIN state")
        restore = lambda: S.PIN_CONFIG_FILE.write_bytes(before)
    else:
        before = dict(S._active_sessions[access.token])
        if kind == "revoked":
            S._active_sessions.pop(access.token)
        else:
            S._active_sessions[access.token]["user_id"] = "bob"
        restore = lambda: S._active_sessions.update({access.token: before})
    with pytest.raises(HTTPException) as first:
        check()
    assert first.value.status_code == status
    assert first.value.private_client_authority_failure is True
    restore()
    with pytest.raises(HTTPException) as second:
        check()
    assert second.value.status_code == status
    # A new deliberate request can use repaired/reconfirmed state.
    assert client.get("/read").status_code == 200


def test_open_local_pin_cycle_revokes_even_after_mode_returns(access):
    S.PIN_CONFIG_FILE.write_text('{"enabled":false}')
    assert access.connect("local").get("/read").status_code == 200
    _, check = access.captured
    S.save_pin_config("c" * 64, "d" * 64)
    S.revoke_all_sessions()
    S.PIN_CONFIG_FILE.write_text('{"enabled":false}')
    S.revoke_all_sessions()
    with pytest.raises(HTTPException) as error:
        check()
    assert error.value.status_code == 401


def test_native_access_survives_unrelated_browser_lock(access):
    assert access.connect("native").get("/read").status_code == 200
    owner, check = access.captured
    S.revoke_session_token(access.token)
    S.revoke_all_sessions()
    check()
    assert owner == "alice"


@pytest.mark.parametrize("mode", ["browser", "native"])
def test_security_damage_at_admission_is_unavailable_without_private_detail(access, mode):
    path = S.PIN_CONFIG_FILE if mode == "browser" else companion_auth._path()
    path.write_bytes(b"private-state-sentinel")
    response = access.connect(mode).get("/read")
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    assert "private-state-sentinel" not in response.text
    access.work.assert_not_called()


@pytest.mark.parametrize("mode", ["browser", "native"])
@pytest.mark.parametrize("failure", [False, True])
def test_revocation_during_read_blocks_success_and_error_disclosure(access, mode, failure):
    def read():
        if mode == "browser":
            S.revoke_session_token(access.token)
        else:
            companion_auth.revoke_device("alice", access.paired["device_id"])
        if failure:
            raise HTTPException(404, "private-error-sentinel")
        return {"private": "private-result-sentinel"}
    access.work.side_effect = read
    response = access.connect(mode).get("/read")
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"
    assert "sentinel" not in response.text


def test_denied_check_prevents_operation(access):
    assert access.connect().get("/read").status_code == 200
    _, check = access.captured
    S.revoke_session_token(access.token)
    operation = Mock()
    with pytest.raises(HTTPException):
        authority.checked_call(check, operation)
    operation.assert_not_called()


def test_unknown_work_error_is_redacted_and_known_error_keeps_contract(access):
    client = access.connect()
    access.work.side_effect = RuntimeError("private-path-sentinel")
    response = client.get("/read")
    assert response.status_code == 503 and "sentinel" not in response.text
    assert response.headers["cache-control"] == "no-store"
    access.work.side_effect = HTTPException(404, "Saved item not found.")
    response = client.get("/read")
    assert response.status_code == 404 and response.json()["detail"] == "Saved item not found."
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("failure", [False, True])
def test_json_encoding_rechecks_authority_even_when_encoding_fails(access, monkeypatch, failure):
    original = authority.JSONResponse

    def encode(*args, **kwargs):
        result = original(*args, **kwargs)
        S.revoke_session_token(access.token)
        if failure:
            raise ValueError("private-encoding-sentinel")
        return result

    monkeypatch.setattr(authority, "JSONResponse", encode)
    response = access.connect().get("/read")
    assert response.status_code == 401
    assert "saved text" not in response.text and "sentinel" not in response.text
    assert response.headers["cache-control"] == "no-store"


def test_checked_json_supports_list_and_status(access):
    assert access.connect().get("/read").status_code == 200
    _, check = access.captured
    response = authority.checked_json(check, ["saved"], status_code=202)
    assert response.status_code == 202 and response.body == b'["saved"]'
    assert response.headers["cache-control"] == "no-store"


def test_native_additional_check_failure_is_sticky_and_redacted(access):
    request = StarletteRequest({"type": "http", "scheme": "https", "path": "/read", "root_path": "",
        "query_string": b"", "server": ("tli.example.test", 443), "client": ("192.0.2.10", 1234),
        "headers": [(b"host", b"tli.example.test"), (b"authorization", ("Bearer " + access.paired["credential"]).encode())]})
    additional = Mock()
    request.state.tli_run_check = additional
    _, check = authority.private_client_access(request, authority.Response())
    additional.side_effect = OSError("private-security-sentinel")
    with pytest.raises(HTTPException) as error:
        check()
    assert error.value.status_code == 503 and "sentinel" not in error.value.detail
    additional.side_effect = None
    with pytest.raises(HTTPException) as repeated:
        check()
    assert repeated.value.status_code == 503


@pytest.mark.parametrize("problem", [HTTPException(503, "PRIVATE security details"), OSError("PRIVATE security path")])
@pytest.mark.parametrize("phase", ["admission", "captured"])
def test_nested_open_local_pin_failure_stays_unavailable(access, monkeypatch, problem, phase):
    """The nested operation_access PIN read must not collapse damage to 401."""
    S.PIN_CONFIG_FILE.write_text('{"enabled":false}')
    before = S.PIN_CONFIG_FILE.read_bytes()
    client = access.connect("local")
    if phase == "captured":
        assert client.get("/read").status_code == 200
        _, captured = access.captured
        access.work.reset_mock()
    original = S.load_pin_config
    calls = []

    def transient_failure():
        calls.append(True)
        # The outer browser check succeeds; the subsequent PIN-off check in
        # companion_auth.operation_access encounters unavailable security.
        if len(calls) == 2:
            raise problem
        return original()

    monkeypatch.setattr(S, "load_pin_config", transient_failure)
    if phase == "admission":
        response = client.get("/read")
        assert response.status_code == 503
        assert "PRIVATE" not in response.text and "saved text" not in response.text
        assert response.headers["cache-control"] == "no-store"
    else:
        for _ in range(2):
            with pytest.raises(HTTPException) as denied:
                authority.checked_call(captured, access.work)
            assert denied.value.status_code == 503 and "PRIVATE" not in denied.value.detail
    assert len(calls) == 2
    access.work.assert_not_called()
    assert S.PIN_CONFIG_FILE.read_bytes() == before


@pytest.mark.parametrize("problem,status", [(HTTPException(401, "PRIVATE revoked"), 401),
    (HTTPException(403, "PRIVATE forbidden"), 403), (HTTPException(503, "PRIVATE unavailable"), 503),
    (OSError("PRIVATE security path"), 503)])
def test_shared_operation_check_retains_status_and_never_resumes(access, monkeypatch, problem, status):
    request = StarletteRequest({"type": "http", "scheme": "https", "path": "/read", "root_path": "",
        "query_string": b"", "server": ("tli.example.test", 443), "client": ("192.0.2.10", 1234),
        "headers": [(b"host", b"tli.example.test"), (b"authorization", ("Bearer " + access.paired["credential"]).encode())]})
    before = companion_auth._path().read_bytes()
    check = companion_auth.operation_access(request, "alice")
    real_owner = companion_auth.credential_owner
    attempts = []

    def transient_failure(credential):
        attempts.append(True)
        if len(attempts) == 1:
            raise problem
        return real_owner(credential)

    monkeypatch.setattr(companion_auth, "credential_owner", transient_failure)
    for _ in range(2):
        with pytest.raises(HTTPException) as denied:
            authority.checked_call(check, access.work)
        assert denied.value.status_code == status and "PRIVATE" not in denied.value.detail
        assert denied.value.headers["Cache-Control"] == "no-store"
    assert len(attempts) == 1
    access.work.assert_not_called()
    assert companion_auth._path().read_bytes() == before
