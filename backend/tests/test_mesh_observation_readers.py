"""Checked cached peer observations; temporary stores and no network or devices."""
import copy
import json
import threading
import time

import pytest
from fastapi import HTTPException

import peer_connections as C
import peer_trust as P
import tli_state as S
from routers import mesh_routes as M, system_routes as R
from tests.test_peer_trust import peers


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    for name in ("_ROUTES", "_CHECKS", "_INFLIGHT"):
        monkeypatch.setattr(C, name, {})
    monkeypatch.setattr(C, "_NETWORK_CHANGED_AT", 0)
    monkeypatch.setattr(C, "LOCK", threading.RLock())
    for module, name in ((C, "schedule"), (C, "check"), (P, "request"),
                         (P, "_exchange"), (P, "health"), (P, "check_status")):
        monkeypatch.setattr(module, name, lambda *a, **k: pytest.fail("Observation initiated peer I/O"))


def okay():
    pass


def error_for(kind):
    return HTTPException(kind, "Synthetic denial") if isinstance(kind, int) else kind("Synthetic denial")


def deny_once(error):
    used = False
    def check():
        nonlocal used
        if not used:
            used = True
            raise error
    return check


READERS = {
    "directory": lambda check: S.load_mesh_directory(check=check),
    "trust": lambda check: P.trusted("peer-b", check=check),
    "messages": lambda check: P.message_readiness("peer-b", check=check),
    "public": lambda check: P.public_trust("peer-b", check=check),
    "discovery": lambda check: C.discovery("peer-b", check=check),
    "connection": lambda check: C.snapshot("peer-b", check=check),
    "roster": lambda check: M.get_lan_peers(check=check),
}


@pytest.mark.parametrize("reader", READERS)
@pytest.mark.parametrize("kind", [401, 403, 503, RuntimeError, FileNotFoundError])
def test_denied_reader_does_not_touch_saved_state(peers, monkeypatch, reader, kind):
    monkeypatch.setattr(S._security, "read_json", lambda *a, **k: pytest.fail("Denied read"))
    error = error_for(kind)
    with pytest.raises(type(error)) as caught:
        READERS[reader](deny_once(error))
    assert caught.value is error


@pytest.mark.parametrize("reader", ["messages", "public", "connection"])
@pytest.mark.parametrize("kind", [401, 403, 503, RuntimeError, FileNotFoundError])
def test_trust_error_fallback_never_swallows_one_time_browser_denial(peers, monkeypatch, reader, kind):
    original = P.trusted
    error = error_for(kind)
    def denied(*args, check=None, **kwargs):
        # Simulate losing authority inside the deeper checked trust reader,
        # then a subsequent check succeeds (e.g. a repaired security backend).
        return original(*args, check=deny_once(error), **kwargs)
    monkeypatch.setattr(P, "trusted", denied)
    with pytest.raises(type(error)) as caught:
        READERS[reader](okay)
    assert caught.value is error


@pytest.mark.parametrize("reader", ["trust", "messages", "public", "connection", "roster"])
def test_damaged_directory_stays_unavailable_and_is_preserved(peers, reader):
    raw = b'{"private saved content": broken'
    S.MESH_DIRECTORY_PATH.write_bytes(raw)
    with pytest.raises(S._security.SecurityStateUnavailable):
        READERS[reader](okay)
    assert S.MESH_DIRECTORY_PATH.read_bytes() == raw


@pytest.mark.parametrize("reader", ["messages", "public", "connection"])
def test_checked_unavailable_trust_is_not_a_review_required_card(peers, monkeypatch, reader):
    error = HTTPException(503, "Synthetic unavailable store")
    def unavailable(*a, **k):
        raise error
    monkeypatch.setattr(P, "trusted", unavailable)
    with pytest.raises(HTTPException) as caught:
        READERS[reader](okay)
    assert caught.value is error


@pytest.mark.parametrize("target", ["directory", "messages", "discovery", "connection"])
def test_recheck_after_lock_wait_precedes_private_read(peers, monkeypatch, target):
    armed = False
    class WaitedLock:
        def __enter__(self):
            nonlocal armed
            armed = True
        def __exit__(self, *args):
            pass
    error = HTTPException(403, "Revoked while waiting")
    def check():
        nonlocal armed
        if armed:
            armed = False
            raise error
    if target == "directory":
        monkeypatch.setattr(S, "MESH_DIRECTORY_LOCK", WaitedLock())
        monkeypatch.setattr(S._security, "read_json", lambda *a, **k: pytest.fail("Read after denied lock"))
    elif target == "messages":
        monkeypatch.setattr(P, "LOCK", WaitedLock())
        monkeypatch.setattr(P, "trusted", lambda *a, **k: pytest.fail("Trust after denied lock"))
    else:
        monkeypatch.setattr(C, "LOCK", WaitedLock())
        class NoRead(dict):
            def get(self, *a):
                pytest.fail("Cache read after denied lock")
        monkeypatch.setattr(C, "_ROUTES", NoRead())
        if target == "connection":
            monkeypatch.setattr(C, "discovery", lambda *a, **k: {"seen_recently": False})
            monkeypatch.setattr(C, "_CHECKS", NoRead())
    with pytest.raises(HTTPException) as caught:
        READERS[target](check)
    assert caught.value is error


@pytest.mark.parametrize("kind", [401, 403, 503, FileNotFoundError])
def test_missing_directory_rechecks_before_fallback_node_read(peers, monkeypatch, kind):
    calls = []
    armed = False
    error = error_for(kind)
    def read(path, *a, **k):
        nonlocal armed
        calls.append(path)
        armed = True
        raise FileNotFoundError(path)
    def check():
        nonlocal armed
        if armed:
            armed = False
            raise error
    monkeypatch.setattr(S._security, "read_json", read)
    with pytest.raises(type(error)) as caught:
        S.load_mesh_directory(check=check)
    assert caught.value is error
    assert calls == [S.MESH_DIRECTORY_PATH]


@pytest.mark.parametrize("saved", [{"peer_trust_established": True}, {"role": "member"}, {"host_device_id": "host"}])
def test_missing_required_directory_cannot_be_an_empty_roster(peers, saved):
    S.MESH_DIRECTORY_PATH.unlink()  # Test-owned file under tmp_path only.
    S.NODE_CONFIG_PATH.write_text(json.dumps(saved), encoding="utf-8")
    with pytest.raises(S._security.SecurityStateUnavailable):
        S.load_mesh_directory(check=okay)
    assert not S.MESH_DIRECTORY_PATH.exists()
    assert json.loads(S.NODE_CONFIG_PATH.read_text()) == saved


def test_absent_optional_directory_is_not_created(peers):
    S.MESH_DIRECTORY_PATH.unlink()
    before = S.NODE_CONFIG_PATH.read_bytes()
    assert S.load_mesh_directory(check=okay) == {}
    assert not S.MESH_DIRECTORY_PATH.exists()
    assert S.NODE_CONFIG_PATH.read_bytes() == before


def test_roster_reads_existing_identity_without_creating_it(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", tmp_path)
    monkeypatch.setattr(S, "NODE_CONFIG_PATH", tmp_path / "node.json")
    monkeypatch.setattr(S, "MESH_DIRECTORY_PATH", tmp_path / "mesh.json")
    monkeypatch.setattr(S, "load_node_config", lambda: pytest.fail("Read created node identity"))
    result = M.get_lan_peers(check=okay)
    assert result["self_id"] is None and result["peers"] == []
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("status", ["pending", "blocked"])
def test_peer_permission_failure_is_still_review_information(peers, status):
    directory = S.load_mesh_directory()
    directory["peer-b"]["status"] = status
    S.save_mesh_directory(directory)
    assert C.snapshot("peer-b", check=okay)["state"] == "review_required"
    assert P.public_trust("peer-b", check=okay)["trust_state"] == "review_required"
    assert P.message_readiness("peer-b", check=okay)["code"] == "peer_" + status


def cache_connection(peers):
    revision = P.trusted("peer-b")[2]
    C._CHECKS["peer-b"] = {"revision": revision, "expires": time.monotonic() + 100,
        "next": time.monotonic() + 50, "value": {"state": "connected", "online": True,
        "checked_at": "2026-10-15T00:00:00Z", "expires_at": "2026-10-15T00:01:30Z",
        "reason": None, "ready_grants": ["messages"], "capabilities": {"messages": {"state": "ready"}}}}


def test_cached_connection_is_detached_and_original_observation_time_survives(peers):
    cache_connection(peers)
    before = copy.deepcopy(C._CHECKS)
    value = C.snapshot("peer-b", check=okay)
    assert value["checked_at"] == "2026-10-15T00:00:00Z"
    value["capabilities"]["messages"]["state"] = "tampered"
    value["ready_grants"].append("observe")
    assert C._CHECKS == before


def test_snapshot_does_not_take_grants_from_stale_caller_entry(peers):
    old = S.load_mesh_directory()["peer-b"]
    current = copy.deepcopy(old)
    current["peer_trust"]["grants"] = ["observe"]
    S.save_mesh_directory({"peer-b": current})
    value = C.snapshot("peer-b", old, check=okay)
    assert value["capabilities"]["messages"]["state"] == "permission_required"
    assert value["capabilities"]["observe"]["state"] == "not_checked"
    assert value["online"] is None and value["ready_grants"] == []


def test_revised_trust_invalidates_cached_ready_grants(peers):
    cache_connection(peers)
    directory = S.load_mesh_directory()
    directory["peer-b"]["peer_trust"]["grants"] = ["observe"]
    S.save_mesh_directory(directory)
    value = C.snapshot("peer-b", check=okay)
    assert value["online"] is None and value["ready_grants"] == []
    assert value["checked_at"] is None and not value["fresh"]


def test_stale_cache_never_refreshes_time_or_claims_online(peers):
    cache_connection(peers)
    C._CHECKS["peer-b"]["expires"] = 0
    value = C.snapshot("peer-b", check=okay)
    assert value["checked_at"] == "2026-10-15T00:00:00Z"
    assert value["online"] is None and value["ready_grants"] == [] and not value["fresh"]


def test_checked_roster_does_not_write_or_probe_and_keeps_discovery_time(peers, monkeypatch):
    directory = S.load_mesh_directory()
    directory["peer-b"]["discovery"] = {"observed_at": "2026-10-15T00:00:00Z"}
    S.save_mesh_directory(directory)
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    node_before = S.NODE_CONFIG_PATH.read_bytes()
    monkeypatch.setattr(S, "save_mesh_directory", lambda *a: pytest.fail("List wrote directory"))
    monkeypatch.setattr(S, "load_node_config", lambda: pytest.fail("List initialized node"))
    monkeypatch.setattr(R, "agent_health", lambda **kw: {"ok": True, "node_id": "local-a", "ai_healthy": None})
    result = M.mesh_health(check=okay)
    peer = result["nodes"][1]
    assert peer["peer_id"] == "peer-b" and peer["online"] is None
    assert peer["discovery_observed_at"] == "2026-10-15T00:00:00Z"
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before
    assert S.NODE_CONFIG_PATH.read_bytes() == node_before
