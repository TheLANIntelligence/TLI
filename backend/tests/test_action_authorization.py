"""Browser admission and revocation around saved routines; no real devices."""
import copy
import json
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import companion_auth
import tli_state as S
from routers import actions_engine as A

LOCAL = "http://localhost:8000"
REMOTE = "https://tli.test:8000"
PRIVATE = "Synthetic private evening routine"
ROUTES = ("list", "definition", "update", "approve", "review", "preview", "run", "capabilities")


@pytest.fixture
def surface(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "pin.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(A, "_INFLIGHT", set())
    calls = []
    devices = [{"id": "lamp", "name": "Desk", "ip": "192.0.2.1", "relay": 1}]
    env = SimpleNamespace(root=tmp_path, calls=calls, devices=devices, effect=None)

    def execute(**kwargs):
        calls.append(kwargs)
        return env.effect() if env.effect else {"ok": True}

    monkeypatch.setattr(A, "_CTX", {**A._CTX, "data_dir": tmp_path,
        "shelly_registry_path": tmp_path / "registry.json", "home_power_runtime": None,
        "shelly_driver": SimpleNamespace(turn_on=execute)})
    monkeypatch.setattr(A, "_read_shelly_registry", lambda: copy.deepcopy(devices))
    monkeypatch.setattr("intelligence.devices.with_context", lambda rows: rows)
    env.action = {"id": "fixture", "name": PRIVATE, "enabled": True, "steps": [
        {"type": "shelly.switch", "device": "Desk", "value": "on"}]}
    A._save_json(tmp_path / "actions.json", {"actions": [env.action], "triggers": [], "future": {"keep": True}})
    env.app = FastAPI()
    env.app.include_router(A.router)
    assert not env.app.dependency_overrides
    return env


def cookie():
    S.save_pin_config("a" * 64, "b" * 64)
    return S.create_session_token("alice")


def arguments(env, route):
    draft = {"name": PRIVATE, "steps": env.action["steps"], "request_id": "save-one"}
    revision = A._fingerprint(env.action)
    targets = A._fingerprint(A._target_review(env.action["steps"], [env.devices[0]] * len(env.action["steps"])))
    return {
        "list": ("GET", "/actions/list", None),
        "definition": ("GET", "/actions/fixture/definition", None),
        "update": ("PATCH", "/actions/fixture", {"name": "Edited private routine", "expected_revision": revision, "request_id": "edit-one"}),
        "approve": ("POST", "/actions/approve", draft),
        "review": ("GET", "/actions/fixture/review", None),
        "preview": ("POST", "/actions/preview", draft),
        "run": ("POST", "/actions/run/fixture", {"request_id": "run-one", "expected_revision": revision, "expected_targets": targets}),
        "capabilities": ("GET", "/actions/capabilities", None),
    }[route]


def request(env, route, *, headers=None, origin=REMOTE, peer="192.0.2.8"):
    method, path, body = arguments(env, route)
    with TestClient(env.app, base_url=origin, client=(peer, 40000)) as api:
        return api.request(method, path, json=body, headers=headers or {})


def authorized(token):
    return {"Origin": REMOTE, "Cookie": "tli_session=" + token}


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("mode,status", [
    ("anonymous", 401), ("revoked", 401), ("pin_off_revoked", 401),
    ("open_lan", 403), ("loopback_dns", 403), ("remote_http", 403),
    ("foreign_origin", 403), ("same_site", 403), ("proxy", 403),
    ("companion", 403), ("peer", 403),
])
def test_denied_before_private_store_or_device_access(surface, monkeypatch, route, mode, status):
    before = (surface.root / "actions.json").read_bytes()
    headers = authorized(cookie())
    origin, peer = REMOTE, "192.0.2.8"
    if mode == "anonymous":
        headers.pop("Cookie")
    elif mode in ("revoked", "pin_off_revoked"):
        S._active_sessions.clear()
        if mode == "pin_off_revoked":
            S.clear_pin_config()
            origin, peer = LOCAL, "127.0.0.1"
            headers["Origin"] = LOCAL
    elif mode in ("open_lan", "loopback_dns"):
        S.clear_pin_config()
        headers.pop("Cookie")
        if mode == "loopback_dns":
            peer = "127.0.0.1"
    elif mode == "remote_http":
        origin = headers["Origin"] = "http://tli.test:8000"
    elif mode == "foreign_origin":
        headers["Origin"] = "https://foreign.test"
    elif mode == "same_site":
        headers["Sec-Fetch-Site"] = "same-site"
    elif mode == "proxy":
        headers["Forwarded"] = "for=127.0.0.1"
    elif mode == "companion":
        invitation, _ = companion_auth.create_pairing("alice", REMOTE, "f" * 64)
        pair = companion_auth.redeem_pairing(invitation, REMOTE, "f" * 64, "Synthetic phone", "ios")
        headers["Authorization"] = "Bearer " + pair["credential"]
    elif mode == "peer":
        headers["X-TLI-Peer-Id"] = "synthetic-peer"

    def forbidden(*args, **kwargs):
        pytest.fail("Denied routine request reached a private store")

    for name in ("_paths", "_read_shelly_registry", "_ensure_initialized"):
        monkeypatch.setattr(A, name, forbidden)
    response = request(surface, route, headers=headers, origin=origin, peer=peer)
    assert response.status_code == status, response.text
    assert PRIVATE not in response.text
    assert (surface.root / "actions.json").read_bytes() == before
    assert not (surface.root / "actions_receipts.jsonl").exists()
    assert not surface.calls and not A._INFLIGHT


@pytest.mark.parametrize("route", ("approve", "update", "preview", "run"))
def test_mutations_require_same_origin_header(surface, route):
    response = request(surface, route, headers={"Cookie": "tli_session=" + cookie()})
    assert response.status_code == 403
    assert not surface.calls and not (surface.root / "actions_receipts.jsonl").exists()


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("mode", ("open_local", "pin_local", "pin_https"))
def test_authorized_browser_preserves_supported_contract(surface, route, mode):
    origin = REMOTE if mode == "pin_https" else LOCAL
    headers = {"Origin": origin}
    if mode != "open_local":
        headers["Cookie"] = "tli_session=" + cookie()
    before = (surface.root / "actions.json").read_bytes()
    response = request(surface, route, headers=headers, origin=origin,
                       peer="192.0.2.8" if mode == "pin_https" else "127.0.0.1")
    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "no-store"
    assert len(surface.calls) == (1 if route == "run" else 0)
    assert not A._INFLIGHT
    if route not in ("approve", "update"):
        assert (surface.root / "actions.json").read_bytes() == before
    assert json.loads((surface.root / "actions.json").read_bytes())["future"] == {"keep": True}


@pytest.mark.parametrize("route", ("list", "definition", "update", "approve", "review", "run"))
@pytest.mark.parametrize("error", (False, True))
def test_revocation_during_store_read_hides_data_errors_and_prevents_effects(surface, monkeypatch, route, error):
    headers = authorized(cookie())
    original = A._load_json
    before = (surface.root / "actions.json").read_bytes()

    def read(*args, **kwargs):
        value = original(*args, **kwargs)
        S._active_sessions.clear()
        if error:
            raise HTTPException(503, PRIVATE)
        return value

    monkeypatch.setattr(A, "_load_json", read)
    response = request(surface, route, headers=headers)
    assert response.status_code == 401 and PRIVATE not in response.text
    assert not surface.calls and not (surface.root / "actions_receipts.jsonl").exists()
    assert (surface.root / "actions.json").read_bytes() == before


@pytest.mark.parametrize("route", ("approve", "update", "run"))
def test_revocation_while_waiting_for_lock_prevents_mutation(surface, monkeypatch, route):
    headers = authorized(cookie())
    before = (surface.root / "actions.json").read_bytes()

    @contextmanager
    def lock():
        S._active_sessions.clear()
        yield

    monkeypatch.setattr(A, "_STORE_LOCK", lock())
    response = request(surface, route, headers=headers)
    assert response.status_code == 401 and not surface.calls and not A._INFLIGHT
    assert (surface.root / "actions.json").read_bytes() == before


@pytest.mark.parametrize("route", ("approve", "update"))
def test_revocation_during_staging_preserves_original_store(surface, monkeypatch, route):
    headers = authorized(cookie())
    before = (surface.root / "actions.json").read_bytes()
    original = Path.write_text

    def write(path, *args, **kwargs):
        result = original(path, *args, **kwargs)
        if path == surface.root / "actions.tmp":
            S._active_sessions.clear()
        return result

    monkeypatch.setattr(Path, "write_text", write)
    response = request(surface, route, headers=headers)
    assert response.status_code == 401 and not surface.calls
    assert (surface.root / "actions.json").read_bytes() == before
    assert not (surface.root / "actions_receipts.jsonl").exists()


@pytest.mark.parametrize("route", ("approve", "update"))
def test_completed_save_survives_late_revocation_without_disclosure(surface, monkeypatch, route):
    headers = authorized(cookie())
    before = (surface.root / "actions.json").read_bytes()
    original = Path.replace

    def replace(path, *args, **kwargs):
        result = original(path, *args, **kwargs)
        if path == surface.root / "actions.tmp":
            S._active_sessions.clear()
        return result

    monkeypatch.setattr(Path, "replace", replace)
    response = request(surface, route, headers=headers)
    assert response.status_code == 401 and PRIVATE not in response.text and not surface.calls
    assert (surface.root / "actions.json").read_bytes() != before
    assert len(A._read_request_receipts()) == 1


@pytest.mark.parametrize("route", ("review", "preview", "run", "capabilities"))
@pytest.mark.parametrize("error", (False, True))
def test_revocation_during_target_read_stops_before_next_lookup(surface, monkeypatch, route, error):
    headers = authorized(cookie())
    reads = []

    def registry():
        reads.append(True)
        S._active_sessions.clear()
        if error:
            raise HTTPException(503, PRIVATE)
        return copy.deepcopy(surface.devices)

    monkeypatch.setattr(A, "_read_shelly_registry", registry)
    response = request(surface, route, headers=headers)
    assert response.status_code == 401 and PRIVATE not in response.text
    assert len(reads) == 1 and not surface.calls
    assert not (surface.root / "actions_receipts.jsonl").exists()


@pytest.mark.parametrize("completed", (False, True))
def test_revocation_during_request_history_never_replays_or_discloses(surface, monkeypatch, completed):
    headers = authorized(cookie())
    if completed:
        assert request(surface, "run", headers=headers).json()["ok"]
    before = (surface.root / "actions_receipts.jsonl").read_bytes() if completed else None
    original = A._read_request_receipts

    def read():
        value = original()
        S._active_sessions.clear()
        return value

    monkeypatch.setattr(A, "_read_request_receipts", read)
    response = request(surface, "run", headers=headers)
    assert response.status_code == 401 and PRIVATE not in response.text
    assert len(surface.calls) == int(completed) and not A._INFLIGHT
    if completed:
        assert (surface.root / "actions_receipts.jsonl").read_bytes() == before
    else:
        assert not (surface.root / "actions_receipts.jsonl").exists()


@pytest.mark.parametrize("driver_error", (False, True))
def test_revocation_after_first_effect_preserves_outcome_skips_rest_and_denies_response(surface, driver_error):
    headers = authorized(cookie())
    surface.action["steps"] *= 2
    A._save_json(surface.root / "actions.json", {"actions": [surface.action], "triggers": []})

    def effect():
        S._active_sessions.clear()
        if driver_error:
            raise RuntimeError(PRIVATE)
        return {"ok": True}

    surface.effect = effect
    response = request(surface, "run", headers=headers)
    assert response.status_code == 401 and PRIVATE not in response.text
    assert len(surface.calls) == 1 and not A._INFLIGHT
    rows = A._read_request_receipts()
    assert [row["kind"] for row in rows] == ["action_started", "action_run"]
    assert rows[-1]["results"][0]["ok"] is not driver_error
    assert rows[-1]["results"][1]["skipped"]
    assert rows[-1]["ok"] is False
    # A new valid browser can inspect a recorded duplicate; no device is replayed.
    result = request(surface, "run", headers=authorized(cookie()))
    assert result.status_code == 200 and result.json()["duplicate"]
    assert len(surface.calls) == 1


@pytest.mark.parametrize("kind", ("action_started", "action_run"))
def test_revocation_during_receipt_persistence_keeps_evidence_without_late_disclosure(surface, monkeypatch, kind):
    headers = authorized(cookie())
    original = A._append_receipt

    def append(row, **kwargs):
        original(row, **kwargs)
        if row["kind"] == kind:
            S._active_sessions.clear()

    monkeypatch.setattr(A, "_append_receipt", append)
    response = request(surface, "run", headers=headers)
    assert response.status_code == 401 and PRIVATE not in response.text and not A._INFLIGHT
    assert len(surface.calls) == (1 if kind == "action_run" else 0)
    rows = A._read_request_receipts()
    assert rows[-1]["kind"] == kind


def test_revoked_while_waiting_to_reserve_run_does_not_consume_request_id(surface, monkeypatch):
    headers = authorized(cookie())
    acquisitions = []

    @contextmanager
    def acquire():
        acquisitions.append(True)
        if len(acquisitions) == 2:
            S._active_sessions.clear()
        yield

    class Lock:
        def __enter__(self):
            self.context = acquire()
            return self.context.__enter__()

        def __exit__(self, *args):
            return self.context.__exit__(*args)

    monkeypatch.setattr(A, "_STORE_LOCK", Lock())
    response = request(surface, "run", headers=headers)
    assert response.status_code == 401 and not surface.calls and not A._INFLIGHT
    assert not (surface.root / "actions_receipts.jsonl").exists()
