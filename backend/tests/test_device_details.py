"""Synthetic registry relationships, old overlays and owner-only report views."""
import copy
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import tli_state as S
from intelligence import device_details as V, devices, diagnostics as D
from intelligence.store import write_private
from routers import home_power
from routers.intelligence_routes import router
from routers.system_routes import require_session


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(node_id="host-a", node_name="Study", role="standalone"))
    monkeypatch.setattr(S, "load_shelly_registry", lambda: [
        {"id": "power-0", "name": "Study", "ip": "192.0.2.10", "relay": 0},
        {"id": "power-1", "name": "Study", "ip": "192.0.2.10", "relay": 1}])
    monkeypatch.setattr(S, "load_mesh_directory", lambda: {"peer-a": {"node_name": "Study", "ip": "192.0.2.20"}})
    monkeypatch.setattr(home_power, "get_runtime", lambda: None)
    monkeypatch.setattr(D, "run", lambda *a, **kw: pytest.fail("A details page cannot run diagnostics"))
    monkeypatch.setattr(devices, "refresh_printers", lambda: pytest.fail("A details page cannot discover printers"))


def overlay():
    return Path(S.DATA_DIR) / "intelligence" / "device_context.json"


def persist(value):
    overlay().parent.mkdir(parents=True, exist_ok=True)
    overlay().write_text(json.dumps(value), encoding="utf-8")


def edge(target, relation="depends_on", note=""):
    return {"target_id": target, "relationship": relation, "note": note}


def save(ident="node-host-a", rows=None, importance="important", revision=None):
    return V.save_relationships("alice", ident, revision or devices.context_revision(ident), importance, rows or [])


def report(ident="report-a", host="host-a", target=None, **extra):
    return {"id": ident, "kind": "system", "created_at": "2026-09-01T10:00:00Z",
            "host": {"id": host, "name": "Study"}, "target": target,
            "checks": [{"id": "cpu", "status": "pass"}, {"id": "disk", "status": "unavailable"}],
            "scope": "Old synthetic host readings", "verified_fix": None, **extra}


def test_opening_details_and_rooms_is_read_only_unknown_is_not_offline():
    before = sorted(Path(S.DATA_DIR).rglob("*"))
    value = V.details("alice", "node-host-a")
    assert value["ok"] and not value["actions_performed"]
    assert value["observed"]["status"] == "unknown"
    assert value["timeline"]["items"] == [] and value["timeline"]["status"] == "available"
    assert value["device"]["importance"] == "normal"
    assert not overlay().exists()
    rooms = V.rooms()
    assert [room["name"] for room in rooms["rooms"]] == [None]
    assert len(rooms["rooms"][0]["devices"]) == 4
    assert not list(Path(S.DATA_DIR).rglob("*.json"))


def test_duplicate_names_multiple_relays_and_missing_targets_are_distinct(monkeypatch):
    inventory = devices.inventory()["devices"]
    relay0, relay1 = [item for item in inventory if item["kind"] == "smart_device"]
    value = save(rows=[edge(relay0["id"], "powered_by")])
    assert value["relationships"][0]["target"]["relay"] == 0
    assert relay1["id"] != relay0["id"]
    assert V.details("alice", relay0["id"])["depended_on_by"][0]["source_id"] == "node-host-a"
    monkeypatch.setattr(S, "load_shelly_registry", lambda: [{"id": "replacement", "name": "Study", "ip": "192.0.2.10", "relay": 0}])
    value = V.details("alice", "node-host-a")
    assert value["relationships"][0]["availability"] == "missing"
    assert value["relationships"][0]["target"] is None
    save(rows=[edge(relay0["id"], "powered_by")])  # Retain the unchanged pointer.
    with pytest.raises(HTTPException) as error:
        save(rows=[edge(relay0["id"], "powered_by", "Changed missing device")])
    assert error.value.status_code == 409
    save(rows=[])
    assert not V.details("alice", "node-host-a")["relationships"]


def test_cycles_self_duplicate_unknown_rejected_without_writes():
    save(rows=[edge("node-peer-a")])
    original = overlay().read_bytes()
    for ident, rows in [("node-peer-a", [edge("node-host-a")]), ("node-host-a", [edge("node-host-a")]),
                        ("node-host-a", [edge("node-peer-a"), edge("node-peer-a")]),
                        ("node-host-a", [edge("node-nonexistent")])]:
        with pytest.raises(HTTPException):
            save(ident, rows)
        assert overlay().read_bytes() == original
    # Physical connections may be described in both directions without implying dependency.
    save("node-peer-a", [edge("node-host-a", "connected_to")])


def test_concurrent_graph_updates_cannot_create_cycle():
    def run(ident, target):
        try:
            return save(ident, [edge(target)])["ok"]
        except HTTPException as error:
            return error.status_code
    with ThreadPoolExecutor(2) as pool:
        left = pool.submit(run, "node-host-a", "node-peer-a")
        right = pool.submit(run, "node-peer-a", "node-host-a")
    assert sorted([left.result(), right.result()], key=str) == sorted([True, 422], key=str)


def test_legacy_names_rooms_aliases_unknown_fields_preserved_and_revision_guards():
    persist({"node-host-a": {"name": "Desk", "room": "Study", "aliases": ["My PC"], "future": {"kept": True}}})
    original = overlay().read_bytes()
    old_revision = V.details("alice", "node-host-a")["device"]["context_revision"]
    assert overlay().read_bytes() == original
    save(rows=[edge("node-peer-a")], revision=old_revision)
    with pytest.raises(HTTPException) as error:
        devices.update("node-host-a", {"name": "Conflicting draft"}, old_revision)
    assert error.value.status_code == 409
    devices.update("node-host-a", {"name": "Old caller", "room": "Bedroom", "aliases": []})
    data = devices.metadata()["node-host-a"]
    assert data["relationships"] == [edge("node-peer-a")]
    assert data["importance"] == "important" and data["future"] == {"kept": True}
    assert V.rooms()["rooms"][0]["name"] == "Bedroom"


@pytest.mark.parametrize("raw", [b"{broken", b"[]", b'{"node-host-a":null}', b'{"node-host-a":{"aliases":5}}',
                                  b'{"node-host-a":{},"node-host-a":{}}', b'{"node-host-a":{"room":false}}',
                                  b'{"node-host-a":{"importance":[]}}', b' ' * (1024 * 1024 + 1)],
                         ids=["json", "list", "entry", "aliases", "duplicate", "room", "importance", "oversized"])
def test_corrupt_metadata_fails_closed_and_legacy_write_cannot_overwrite(raw):
    overlay().parent.mkdir(parents=True, exist_ok=True)
    overlay().write_bytes(raw)
    for action in [lambda: V.details("alice", "node-host-a"), lambda: save(),
                   lambda: devices.update("node-host-a", {"name": "Replacement"})]:
        with pytest.raises(HTTPException) as error:
            action()
        assert error.value.status_code == 503
        assert overlay().read_bytes() == raw


def test_bad_relationships_unavailable_not_empty():
    persist({"node-host-a": {"relationships": "bad"}})
    original = overlay().read_bytes()
    with pytest.raises(HTTPException) as error:
        V.details("alice", "node-host-a")
    assert error.value.status_code == 503
    with pytest.raises(HTTPException):
        save()
    assert overlay().read_bytes() == original


def test_timeline_is_owner_scoped_historical_and_missing_counts_unknown():
    write_private("alice", "diagnostics", [report(), report("wrong-host", host="peer-a"),
        report("device-check", target={"id": "node-peer-a", "name": "Study"}, kind="device"),
        report("user-fix", verified_fix={"source": "user_confirmation", "confirmed_at": "2026-09-02T10:00:00Z", "text": "Private confirmed fix"},
               checks=[{"status": "invented"}])])
    write_private("bob", "diagnostics", [report("bob-private")])
    before = {p: p.read_bytes() for p in Path(S.DATA_DIR).rglob("*.json")}
    rows = V.details("alice", "node-host-a")["timeline"]["items"]
    assert {r["id"] for r in rows} == {"report-a", "user-fix"}
    fix = next(r for r in rows if r["id"] == "user-fix")
    assert fix["user_confirmed_fix"] and fix["checks"]["unknown"] == 1
    assert "Private confirmed fix" not in json.dumps(rows)
    assert V.details("bob", "node-host-a")["timeline"]["items"][0]["id"] == "bob-private"
    assert {p: p.read_bytes() for p in before} == before


def test_failed_history_does_not_hide_registry_or_claim_empty(monkeypatch):
    def fail(*args):
        raise RuntimeError("Missing encryption key")
    monkeypatch.setattr(D, "history", fail)
    result = V.details("alice", "node-host-a")
    assert result["device"]["name"] == "Study"
    assert result["timeline"]["status"] == "unavailable" and result["timeline"]["total"] is None


def test_cached_observation_age_is_not_present_health(monkeypatch):
    when = datetime.now(timezone.utc) - timedelta(seconds=40)
    monkeypatch.setattr(S, "load_mesh_directory", lambda: {"peer-a": {"node_name": "Study", "last_seen": when.isoformat()}})
    value = V.details("alice", "node-peer-a")
    assert value["observed"]["status"] == "stale" and value["observed"]["age_seconds"] >= 40
    when = datetime.now(timezone.utc)
    assert V.details("alice", "node-peer-a")["observed"]["status"] == "reported"
    when = datetime.now(timezone.utc) + timedelta(days=1)
    assert V.details("alice", "node-peer-a")["observed"]["status"] == "unknown"


def test_routes_require_auth_validate_revisions_and_do_not_run_checks():
    app = FastAPI(); app.include_router(router)
    def denied():
        raise HTTPException(401, "Locked")
    app.dependency_overrides[require_session] = denied
    with TestClient(app) as api:
        assert api.get("/api/intelligence/rooms").status_code == 401
        assert api.get("/api/intelligence/devices/node-host-a/details").status_code == 401
        assert api.patch("/api/intelligence/devices/node-host-a/relationships", json={}).status_code == 401
        app.dependency_overrides[require_session] = lambda: "alice"
        result = api.get("/api/intelligence/devices/node-host-a/details")
        assert result.headers["cache-control"] == "no-store"
        revision = result.json()["device"]["context_revision"]
        body = {"importance": "critical", "relationships": [edge("node-peer-a")], "expected_revision": revision}
        result = api.patch("/api/intelligence/devices/node-host-a/relationships", json=body)
        assert result.status_code == 200 and result.json()["device"]["importance"] == "critical"
        assert api.patch("/api/intelligence/devices/node-host-a/relationships", json=body).status_code == 409
        assert api.patch("/api/intelligence/devices/node-host-a/relationships", json={**body, "expected_revision": "bad"}).status_code == 422
        assert api.get("/api/intelligence/devices/missing/details").status_code == 404
