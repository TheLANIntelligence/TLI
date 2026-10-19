"""Receipt history uses real browser authority and temporary local stores."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import companion_auth as companion
import tli_state as S
from routers import actions_engine as actions
from routers import home_power


LOCAL = "http://localhost:8000"
REMOTE = "https://tli.test:8000"
PRIVATE = "Synthetic private scene outcome"
ROUTES = ("/actions/receipts", "/homepower/receipts")


@pytest.fixture
def surface(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "tli_pin.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(actions, "_CTX", {**actions._CTX, "data_dir": tmp_path})

    def no_hardware(*args, **kwargs):
        pytest.fail("Receipt reads must never dispatch a device command")

    runtime = home_power.HomePowerRuntime(
        tmp_path, SimpleNamespace(turn_on=no_hardware, turn_off=no_hardware, toggle=no_hardware),
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(home_power, "_RUNTIME", runtime)
    paths = {ROUTES[0]: tmp_path / "actions_receipts.jsonl", ROUTES[1]: runtime._receipts_path}
    rows = [{"id": index, "kind": "scene_run", "summary": PRIVATE, "ok": index != 1}
            for index in range(3)]
    raw = "".join(json.dumps(row) + "\n" for row in rows).encode()
    for path in paths.values():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    app = FastAPI()
    app.include_router(actions.router)
    app.include_router(home_power.home_power_router)
    assert not app.dependency_overrides
    return app, paths, runtime


def pin_cookie():
    S.save_pin_config("a" * 64, "b" * 64)
    return S.create_session_token("alice")


def request(app, route, *, origin=REMOTE, host="192.168.1.8", headers=None):
    with TestClient(app, base_url=origin, client=(host, 40000)) as client:
        return client.get(route, headers=headers or {})


def cookie_headers():
    return {"Cookie": "tli_session=" + pin_cookie()}


def forbid_store_access(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Denied receipt request reached its store")
    monkeypatch.setattr(actions, "_paths", forbidden)
    monkeypatch.setattr(home_power, "get_runtime", forbidden)


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("mode", ("pin_anonymous", "open_lan", "cross_origin", "same_site", "proxy", "peer"))
def test_denied_requests_do_not_resolve_or_read_receipt_stores(surface, monkeypatch, route, mode):
    app, paths, _ = surface
    before = {path: path.read_bytes() for path in paths.values()}
    headers = {} if mode == "open_lan" else cookie_headers()
    if mode == "pin_anonymous":
        headers.clear()
    elif mode == "cross_origin":
        headers["Origin"] = "https://other.test"
    elif mode == "same_site":
        headers["Sec-Fetch-Site"] = "same-site"
    elif mode == "proxy":
        headers["Forwarded"] = "for=127.0.0.1"
    elif mode == "peer":
        headers["X-TLI-Peer-Id"] = "synthetic-peer"
    forbid_store_access(monkeypatch)
    response = request(app, route, headers=headers)
    assert response.status_code == (401 if mode == "pin_anonymous" else 403)
    assert PRIVATE not in response.text
    assert all(path.read_bytes() == raw for path, raw in before.items())


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("with_cookie", (False, True))
def test_real_companion_credential_cannot_read_browser_receipts(surface, monkeypatch, route, with_cookie):
    app, _, _ = surface
    headers = cookie_headers() if with_cookie else {}
    invitation, _ = companion.create_pairing("alice", REMOTE, "f" * 64)
    paired = companion.redeem_pairing(invitation, REMOTE, "f" * 64, "Synthetic phone", "ios")
    headers["Authorization"] = "Bearer " + paired["credential"]
    forbid_store_access(monkeypatch)
    response = request(app, route, headers=headers)
    assert response.status_code == 403
    assert PRIVATE not in response.text


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("pin_enabled", (False, True))
def test_revoked_cookie_never_falls_back_to_open_local_receipt_access(surface, monkeypatch, route, pin_enabled):
    app, _, _ = surface
    token = pin_cookie() if pin_enabled else S.create_session_token("alice")
    S._active_sessions.clear()
    forbid_store_access(monkeypatch)
    response = request(app, route, origin=LOCAL, host="127.0.0.1", headers={"Cookie": "tli_session=" + token})
    assert response.status_code == 401
    assert PRIVATE not in response.text


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("mode", ("local_open", "local_pin", "remote_pin"))
def test_browser_receipt_contracts_preserve_history_and_limits(surface, route, mode):
    app, paths, _ = surface
    before = {path: path.read_bytes() for path in paths.values()}
    headers = {} if mode == "local_open" else cookie_headers()
    origin = REMOTE if mode == "remote_pin" else LOCAL
    response = request(app, route + "?limit=2", origin=origin,
                       host="192.168.1.8" if mode == "remote_pin" else "127.0.0.1", headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "no-store"
    key = "items" if route == ROUTES[0] else "receipts"
    assert [row["id"] for row in response.json()[key]] == ([1, 2] if key == "items" else [2, 1])
    assert PRIVATE in response.text
    assert all(path.read_bytes() == raw for path, raw in before.items())


@pytest.mark.parametrize("route", ROUTES)
def test_missing_receipt_store_remains_empty_without_creating_it(surface, route):
    app, paths, _ = surface
    paths[route].unlink()
    response = request(app, route, headers=cookie_headers())
    assert response.status_code == 200
    assert response.json() == {"items" if route == ROUTES[0] else "receipts": []}
    assert not paths[route].exists()


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("error", (False, True))
def test_revocation_during_file_read_hides_results_and_read_errors(surface, monkeypatch, route, error):
    app, paths, _ = surface
    headers = cookie_headers()
    original_open = Path.open

    class RevokingReader:
        def __init__(self, handle):
            self.handle = handle

        def __enter__(self):
            self.handle.__enter__()
            return self

        def __exit__(self, *args):
            return self.handle.__exit__(*args)

        def __getattr__(self, name):
            return getattr(self.handle, name)

        def revoke(self):
            S._active_sessions.clear()
            if error:
                raise OSError(PRIVATE)

        def __iter__(self):
            yield from self.handle
            self.revoke()

        def read(self, *args):
            result = self.handle.read(*args)
            self.revoke()
            return result

    def open_file(path, *args, **kwargs):
        handle = original_open(path, *args, **kwargs)
        return RevokingReader(handle) if path == paths[route] else handle

    monkeypatch.setattr(Path, "open", open_file)
    response = request(app, route, headers=headers)
    assert response.status_code == 401
    assert PRIVATE not in response.text


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("error", (False, True))
def test_revocation_during_missing_file_check_hides_metadata_and_errors(surface, monkeypatch, route, error):
    app, paths, _ = surface
    paths[route].unlink()
    headers = cookie_headers()
    original_exists = Path.exists

    def exists(path):
        if path == paths[route]:
            S._active_sessions.clear()
            if error:
                raise OSError(PRIVATE)
            return False
        return original_exists(path)

    monkeypatch.setattr(Path, "exists", exists)
    response = request(app, route, headers=headers)
    assert response.status_code == 401
    assert PRIVATE not in response.text


@pytest.mark.parametrize("raw", (b'{broken\n', b'[]\n', b'{"ok":true}\nnot-json\n'))
def test_corrupt_action_receipts_keep_503_and_original_bytes(surface, raw):
    app, paths, _ = surface
    path = paths[ROUTES[0]]
    path.write_bytes(raw)
    response = request(app, ROUTES[0], headers=cookie_headers())
    assert response.status_code == 503
    assert "Existing receipts were retained" in response.json()["detail"]
    assert path.read_bytes() == raw


@pytest.mark.parametrize("boundary", ("initialize", "path", "size"))
def test_action_receipt_error_rechecks_original_credential(surface, monkeypatch, boundary):
    app, paths, _ = surface
    headers = cookie_headers()

    def fail(*args, **kwargs):
        S._active_sessions.clear()
        raise OSError(PRIVATE)

    if boundary == "initialize":
        monkeypatch.setattr(actions, "_ensure_initialized", fail)
    elif boundary == "path":
        monkeypatch.setattr(actions, "_paths", fail)
    else:
        original_stat = Path.stat
        original_exists = Path.exists
        monkeypatch.setattr(Path, "exists", lambda path: True if path == paths[ROUTES[0]] else original_exists(path))
        def stat(path, *args, **kwargs):
            return fail() if path == paths[ROUTES[0]] else original_stat(path, *args, **kwargs)
        monkeypatch.setattr(Path, "stat", stat)
    response = request(app, ROUTES[0], headers=headers)
    assert response.status_code == 401
    assert PRIVATE not in response.text
