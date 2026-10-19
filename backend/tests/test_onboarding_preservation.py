"""Onboarding controls use real browser authority and temporary marker files."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

import onboarding_store as store
import tli_state as S
from routers import system_routes as routes


@pytest.fixture
def host(tmp_path, monkeypatch):
    root = tmp_path / "data"
    root.mkdir()
    started, completed = root / "onboarding_started.json", root / "onboarding_complete.json"
    monkeypatch.setattr(S, "DATA_DIR", str(root))
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", root / "tli_pin.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "now_iso", lambda: "2026-10-16T12:00:00Z")
    monkeypatch.setattr(store, "_SEEN", set())
    monkeypatch.setattr(store, "_UNCERTAIN", set())
    monkeypatch.setattr(routes, "_ONBOARDING_STARTED_FILE", started)
    monkeypatch.setattr(routes, "_ONBOARDING_COMPLETE_FILE", completed)
    app = FastAPI()
    app.include_router(routes.router)
    f = SimpleNamespace(root=root, started=started, completed=completed, args=(started, completed),
                        app=app, error=HTTPException(401, "Session ended"), fail=False)
    def check():
        if f.fail:
            f.fail = False
            raise f.error
    f.check = check
    clients = []
    def browser(mode="pin-local", target=None):
        pin = mode not in {"open-local", "off-lan", "off-stale", "off-cookie"}
        if pin:
            S.save_pin_config("a" * 64, "b" * 64)
        token = S.create_session_token("owner")
        f.token = token
        local = mode not in {"pin-https", "off-lan", "remote-http"}
        origin = "http://localhost:8000" if local else ("http" if mode == "remote-http" else "https") + "://192.0.2.3:8443"
        client = TestClient(target or app, base_url=origin, client=("127.0.0.1" if local else "192.0.2.4", 1234),
                            headers={"Origin": origin}, raise_server_exceptions=False)
        if mode not in {"anonymous", "open-local", "off-lan"}:
            client.headers["Cookie"] = "tli_session=" + token
        if mode in {"revoked", "off-stale"}: S.revoke_session_token(token)
        if mode == "expired": S._active_sessions[token]["expiry"] = 0
        if mode == "foreign": client.headers["Origin"] = "https://foreign.invalid"
        if mode == "same-site": client.headers["Sec-Fetch-Site"] = "same-site"
        if mode == "missing-origin": del client.headers["Origin"]
        if mode == "proxy": client.headers["Forwarded"] = "for=127.0.0.1"
        if mode == "peer": client.headers["X-TLI-Peer-Id"] = "synthetic-peer"
        if mode == "bearer": client.headers["Authorization"] = "Bearer synthetic-companion"
        if mode == "security-damage": S.PIN_CONFIG_FILE.write_bytes(b'{"PRIVATE security":bad')
        clients.append(client)
        return client
    f.browser = browser
    yield f
    for client in clients:
        client.close()


def contents(root):
    return {p.name: p.read_bytes() for p in root.iterdir() if p.is_file()}


def assert_error(call, status=503):
    with pytest.raises(HTTPException) as error:
        call()
    assert error.value.status_code == status
    return error.value


@pytest.mark.parametrize("action", ["start", "complete"])
@pytest.mark.parametrize("mode,status", [("anonymous", 401), ("revoked", 401), ("expired", 401),
    ("off-stale", 401), ("off-lan", 403), ("remote-http", 403), ("foreign", 403),
    ("same-site", 403), ("missing-origin", 403), ("proxy", 403), ("peer", 403),
    ("bearer", 403), ("security-damage", 503)])
def test_denied_before_marker_service(host, monkeypatch, action, mode, status):
    denied = Mock(side_effect=AssertionError("Denied request reached progress store"))
    monkeypatch.setattr(store, action, denied)
    response = host.browser(mode).post("/system/onboarding/" + action)
    assert response.status_code == status, response.text
    assert response.headers["cache-control"] == "no-store"
    assert "PRIVATE" not in response.text
    denied.assert_not_called()
    assert not host.started.exists() and not host.completed.exists()


@pytest.mark.parametrize("action", ["start", "complete"])
@pytest.mark.parametrize("mode", ["pin-local", "pin-https", "open-local"])
def test_valid_browser_success_contract(host, action, mode):
    response = host.browser(mode).post("/system/onboarding/" + action)
    assert response.status_code == 200, response.text
    expected = {"ok": True}
    if action == "start":
        expected.update(complete=mode != "open-local", started=mode == "open-local")
    assert response.json() == expected
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("pin", [False, True])
def test_public_status_minimal_and_read_only(host, monkeypatch, pin):
    if pin: S.save_pin_config("a" * 64, "b" * 64)
    before = contents(host.root)
    monkeypatch.setattr(store, "_stage", Mock(side_effect=AssertionError("Read staged a file")))
    with TestClient(host.app, base_url="http://192.0.2.5", client=("192.0.2.6", 1234)) as client:
        response = client.get("/system/onboarding/status")
    assert response.status_code == 200 and response.json() == {"complete": pin, "started": False}
    assert response.headers["cache-control"] == "no-store"
    assert contents(host.root) == before


@pytest.mark.parametrize("complete_marker", [{}, {"completed_at": "old", "future": {"private": [None, True, 2]}}])
def test_completed_is_idempotent_and_preserves_exact_bytes(host, monkeypatch, complete_marker):
    host.completed.write_text(json.dumps(complete_marker, separators=(",", ":")), encoding="utf-8")
    host.started.write_bytes(b'{"started_at":"older","future":"PRIVATE"}')
    before = contents(host.root)
    blocked = Mock(side_effect=AssertionError("Existing marker rewritten"))
    monkeypatch.setattr(store, "_publish", blocked)
    assert store.start(*host.args) == {"ok": True, "complete": True, "started": False}
    assert store.complete(*host.args) == {"ok": True}
    assert contents(host.root) == before
    blocked.assert_not_called()


def test_started_unknown_fields_and_timestamp_survive_completion(host):
    raw = b'{"started_at":"original","future":{"v":42}}'
    host.started.write_bytes(raw)
    assert store.start(*host.args)["started"] is True
    assert store.complete(*host.args) == {"ok": True}
    assert host.started.read_bytes() == raw
    assert json.loads(host.completed.read_bytes()) == {"completed_at": "2026-10-16T12:00:00Z"}
    assert store.state(*host.args) == {"complete": True, "started": False}


BAD = [b"{bad", b"[]", b"null", b'{"completed_at":false,"started_at":false}',
       b'{"completed_at":"a","completed_at":"b","started_at":"a"}',
       b'{"completed_at":"a","started_at":"a","future":{"x":1,"x":2}}',
       b'{"completed_at":"a","started_at":"a","future":NaN}',
       b'{"completed_at":"a","started_at":"a","future":1e999}',
       b'{"completed_at":"a","started_at":"a","future":"\\ud800"}',
       b"\xff", b" " * (store.MAX_BYTES + 1)]


@pytest.mark.parametrize("marker", ["started", "completed"])
@pytest.mark.parametrize("raw", BAD, ids=["syntax", "list", "null", "timestamp", "duplicate", "nested-duplicate",
    "nan", "overflow", "surrogate", "utf8", "oversize"])
def test_damaged_markers_preserved_and_all_operations_refuse(host, marker, raw):
    getattr(host, marker).write_bytes(raw)
    before = contents(host.root)
    for action in (store.state, store.start, store.complete):
        assert_error(lambda: action(*host.args))
    assert contents(host.root) == before


def test_completed_does_not_hide_damaged_started_marker(host):
    host.completed.write_bytes(b"{}")
    host.started.write_bytes(b"{broken")
    assert_error(lambda: store.state(*host.args))
    assert_error(lambda: store.complete(*host.args))
    assert host.started.read_bytes() == b"{broken" and host.completed.read_bytes() == b"{}"


@pytest.mark.parametrize("marker", ["started", "completed"])
def test_seen_marker_disappearance_never_becomes_fresh(host, marker):
    path = getattr(host, marker)
    path.write_text(json.dumps({"started_at" if marker == "started" else "completed_at": "old"}))
    store.state(*host.args)
    path.unlink()
    for action in (store.state, store.start, store.complete):
        assert_error(lambda: action(*host.args))
    assert contents(host.root) == {}


@pytest.mark.parametrize("kind", ["directory", "hardlink", "symlink", "case-alias"])
def test_unsafe_marker_paths_are_rejected(host, kind):
    original = host.root / "original.json"
    original.write_bytes(b"{}")
    if kind == "directory": host.completed.mkdir()
    elif kind == "hardlink": os.link(original, host.completed)
    elif kind == "case-alias": host.completed.with_name("ONBOARDING_COMPLETE.JSON").write_bytes(b"{}")
    else:
        try: host.completed.symlink_to(original)
        except OSError: pytest.skip("Host cannot create fixture symlinks")
    assert_error(lambda: store.state(*host.args))
    assert_error(lambda: store.complete(*host.args))
    assert original.read_bytes() == b"{}"


@pytest.mark.parametrize("where", ["target", "parent"])
@pytest.mark.parametrize("invalid", ["inode", "reparse"])
def test_unknown_or_reparse_identity_is_rejected(host, monkeypatch, where, invalid):
    host.completed.write_bytes(b"{}")
    target = host.completed if where == "target" else host.root
    original = Path.lstat
    def lstat(path, *args, **kwargs):
        result = original(path, *args, **kwargs)
        if path == target:
            attributes = {name: getattr(result, name) for name in dir(result) if name.startswith("st_")}
            attributes.update({"st_ino": 0} if invalid == "inode" else {"st_file_attributes": 0x400})
            return SimpleNamespace(**attributes)
        return result
    monkeypatch.setattr(Path, "lstat", lstat)
    assert_error(lambda: store.state(*host.args))


@pytest.mark.parametrize("action", ["start", "complete"])
@pytest.mark.parametrize("phase", ["lock", "pin-read", "marker-read", "fsync", "final-read"])
@pytest.mark.parametrize("error_kind", ["401", "503", "missing", "os-error"])
def test_one_shot_authority_failure_stops_without_commit(host, monkeypatch, action, phase, error_kind):
    host.error = {"401": HTTPException(401, "Lost session"), "503": HTTPException(503, "Security unavailable"),
                  "missing": FileNotFoundError("authority"), "os-error": OSError("authority")}[error_kind]
    if phase == "lock":
        class Lock:
            def __enter__(self): host.fail = True
            def __exit__(self, *args): pass
        monkeypatch.setattr(store, "LOCK", Lock())
    elif phase == "pin-read":
        original = S.load_pin_config
        def load():
            result = original(); host.fail = True; return result
        monkeypatch.setattr(S, "load_pin_config", load)
    elif phase in {"marker-read", "final-read"}:
        original = store._snapshot
        calls = []
        def snapshot(*args):
            result = original(*args); calls.append(1)
            if len(calls) == (1 if phase == "marker-read" else 3): host.fail = True
            return result
        monkeypatch.setattr(store, "_snapshot", snapshot)
    else:
        original = store.os.fsync
        def fsync(fd): original(fd); host.fail = True
        monkeypatch.setattr(store.os, "fsync", fsync)
    with pytest.raises(type(host.error)) as raised:
        getattr(store, action)(*host.args, check=host.check)
    assert raised.value is host.error
    assert contents(host.root) == {} and not store._UNCERTAIN


@pytest.mark.parametrize("action", ["start", "complete"])
def test_prepublication_storage_failure_is_clean_and_retryable(host, monkeypatch, action):
    original = store.os.fsync
    monkeypatch.setattr(store.os, "fsync", Mock(side_effect=OSError("No storage")))
    assert_error(lambda: getattr(store, action)(*host.args))
    assert contents(host.root) == {} and not store._UNCERTAIN
    assert store.state(*host.args) == {"complete": False, "started": False}
    monkeypatch.setattr(store.os, "fsync", original)
    assert getattr(store, action)(*host.args)["ok"]


@pytest.mark.parametrize("action", ["start", "complete"])
@pytest.mark.parametrize("arrival", ["same", "other", "damage"])
def test_marker_arrival_during_staging_is_never_overwritten(host, monkeypatch, action, arrival):
    target = host.started if action == "start" else host.completed
    if arrival == "other": target = host.completed if action == "start" else host.started
    raw = b"{broken" if arrival == "damage" else json.dumps({"started_at" if target == host.started else "completed_at": "external", "keep": 42}).encode()
    original = store.os.fsync
    def fsync(fd): original(fd); target.write_bytes(raw)
    monkeypatch.setattr(store.os, "fsync", fsync)
    assert_error(lambda: getattr(store, action)(*host.args), 503 if arrival == "damage" else 409)
    assert contents(host.root) == {target.name: raw} and not store._UNCERTAIN


@pytest.mark.parametrize("action", ["start", "complete"])
@pytest.mark.parametrize("landed", [False, True])
def test_ambiguous_publication_retains_evidence_and_blocks_all_retry(host, monkeypatch, action, landed):
    original = store._publish
    def publish(staged, target):
        if landed: original(staged, target)
        raise OSError("Publication could not be confirmed")
    monkeypatch.setattr(store, "_publish", publish)
    assert_error(lambda: getattr(store, action)(*host.args))
    target = host.started if action == "start" else host.completed
    retained = contents(host.root)
    assert target.exists() is landed
    if not landed:
        assert len(retained) == 1
        assert next(iter(retained)).startswith(".tli-" + target.name + "-")
        assert json.loads(next(iter(retained.values())))
    for callback in (store.state, store.start, store.complete):
        assert_error(lambda: callback(*host.args))
    assert contents(host.root) == retained


@pytest.mark.parametrize("action", ["start", "complete"])
def test_arrival_at_exclusive_publication_is_not_overwritten(host, monkeypatch, action):
    original = store._publish
    external = b'{"completed_at":"outside","started_at":"outside","keep":true}'
    def publish(staged, target):
        target.write_bytes(external)
        original(staged, target)
    monkeypatch.setattr(store, "_publish", publish)
    assert_error(lambda: getattr(store, action)(*host.args))
    target = host.started if action == "start" else host.completed
    assert target.read_bytes() == external
    assert store._UNCERTAIN


@pytest.mark.parametrize("action", ["start", "complete"])
@pytest.mark.parametrize("status", [401, 503])
def test_confirmed_publication_survives_late_authority_failure(host, monkeypatch, action, status):
    host.error = HTTPException(status, "Access ended")
    original = store._publish
    def publish(staged, target): original(staged, target); host.fail = True
    monkeypatch.setattr(store, "_publish", publish)
    with pytest.raises(HTTPException) as raised:
        getattr(store, action)(*host.args, check=host.check)
    assert raised.value is host.error
    assert not store._UNCERTAIN
    assert store.state(*host.args) == {"complete": action == "complete", "started": action == "start"}
    target = host.started if action == "start" else host.completed
    assert contents(host.root) == {target.name: target.read_bytes()}
    before = target.read_bytes()
    assert getattr(store, action)(*host.args)["ok"] and target.read_bytes() == before


@pytest.mark.parametrize("cleanup_fails", [False, True])
def test_posix_exclusive_link_publication_and_cleanup(host, monkeypatch, cleanup_fails):
    monkeypatch.setattr(store, "WINDOWS", False)
    original = Path.unlink
    def unlink(path, *args, **kwargs):
        if cleanup_fails and path.name.startswith(".tli-"): raise OSError("Cleanup unavailable")
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, "unlink", unlink)
    if cleanup_fails:
        assert_error(lambda: store.complete(*host.args))
        assert store._UNCERTAIN and host.completed.stat().st_nlink == 2
        retained = contents(host.root)
        assert len(retained) == 2
        assert_error(lambda: store.state(*host.args))
        assert_error(lambda: store.complete(*host.args))
        assert contents(host.root) == retained
    else:
        assert store.complete(*host.args) == {"ok": True}
        assert host.completed.stat().st_nlink == 1
        assert store.state(*host.args) == {"complete": True, "started": False}


def test_stage_same_inode_corruption_is_detected(host, monkeypatch):
    original = store.os.fsync
    def fsync(fd):
        original(fd)
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, b"broken")
    monkeypatch.setattr(store.os, "fsync", fsync)
    assert_error(lambda: store.complete(*host.args))
    assert contents(host.root) == {} and not store._UNCERTAIN


@pytest.mark.parametrize("denied", [False, True])
def test_prepublication_cleanup_failure_latches_without_masking_original_error(host, monkeypatch, denied):
    original = store.os.fsync
    def fsync(fd):
        original(fd)
        if denied: host.fail = True
        else: raise OSError("Staging failed")
    monkeypatch.setattr(store.os, "fsync", fsync)
    original_unlink = Path.unlink
    def unlink(path, *args, **kwargs):
        if path.name.startswith(".tli-"): raise OSError("Staging cleanup failed")
        return original_unlink(path, *args, **kwargs)
    monkeypatch.setattr(Path, "unlink", unlink)
    error = assert_error(lambda: store.complete(*host.args, check=host.check), 401 if denied else 503)
    if denied: assert error is host.error
    retained = contents(host.root)
    assert len(retained) == 1 and next(iter(retained)).startswith(".tli-onboarding_complete.json-")
    assert not host.completed.exists() and store._UNCERTAIN
    for action in (store.state, store.start, store.complete): assert_error(lambda: action(*host.args))
    assert contents(host.root) == retained


def test_marked_missing_error_is_never_interpreted_as_absence(host, monkeypatch):
    error = FileNotFoundError("Captured authority failure")
    error.onboarding_authority_failure = True
    original = Path.lstat
    calls = []
    def lstat(path, *args, **kwargs):
        if path == host.completed:
            calls.append(path)
            raise error
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, "lstat", lstat)
    with pytest.raises(FileNotFoundError) as raised:
        store.complete(*host.args, check=host.check)
    assert raised.value is error and calls == [host.completed]
    assert contents(host.root) == {}


def test_concurrent_start_and_complete_keep_both_committed_markers(host):
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda fn: fn(*host.args), [store.start, store.complete]))
    assert all(r["ok"] for r in results)
    assert store.state(*host.args) == {"complete": True, "started": False}
    assert host.completed.exists()
    assert all(not name.startswith(".tli-") for name in contents(host.root))


@pytest.mark.parametrize("action", ["start", "complete"])
@pytest.mark.parametrize("phase", ["fsync", "published"])
@pytest.mark.parametrize("revocation", ["cookie", "pin-cycle"])
def test_http_mid_operation_denial_preserves_known_outcome(host, monkeypatch, action, phase, revocation):
    client = host.browser("off-cookie" if revocation == "cookie" else "open-local")
    def revoke():
        if revocation == "cookie": S.revoke_session_token(host.token)
        else:
            # The final mode is identical; only the captured session epoch differs.
            S.revoke_all_sessions()
    if phase == "fsync":
        original = store.os.fsync
        def fsync(fd): original(fd); revoke()
        monkeypatch.setattr(store.os, "fsync", fsync)
    else:
        original = store._publish
        def publish(staged, target): original(staged, target); revoke()
        monkeypatch.setattr(store, "_publish", publish)
    response = client.post("/system/onboarding/" + action)
    assert response.status_code == 401 and response.headers["cache-control"] == "no-store"
    target = host.started if action == "start" else host.completed
    assert target.exists() is (phase == "published")
    assert not store._UNCERTAIN
    assert all(not name.startswith(".tli-") for name in contents(host.root))


@pytest.mark.parametrize("action", ["start", "complete"])
def test_effective_main_routes_reject_foreign_origin_before_store(host, monkeypatch, app, action):
    blocked = Mock(side_effect=AssertionError("Foreign request reached store"))
    monkeypatch.setattr(store, action, blocked)
    response = host.browser("foreign", target=app).post("/system/onboarding/" + action)
    assert response.status_code == 403 and response.headers["cache-control"] == "no-store"
    blocked.assert_not_called()
