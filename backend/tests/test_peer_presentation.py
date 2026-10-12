"""A folded discovery roster must not merge authority or erase identities."""
import copy

import pytest

import peer_presentation as presentation
import tli_state as S
from routers import mesh_routes as mesh
from tests.test_peer_trust import peers


def pending(*, ip="192.168.2.20", port=8000, observed="2026-10-12T02:27:00Z", seen=None, name="TheLegatoDell"):
    return {"status": "pending", "display_name": name, "ip": ip, "tli_port": port,
            "last_seen": seen or observed, "discovery": {"observed_at": observed, "name": name}}


def test_three_old_installations_project_one_current_listener_without_mutation():
    entries = {
        "first": pending(observed="2026-10-11T23:42:00Z"),
        "second": pending(observed="2026-10-12T02:16:00Z"),
        "current": pending(),
    }
    before = copy.deepcopy(entries)
    assert presentation.previous_discoveries(entries) == {"first": "current", "second": "current"}
    assert entries == before


@pytest.mark.parametrize("status,trust", [("blocked", None), ("allowed", None), ("pending", {"card": "saved"}),
                                          ("pending", {}), ("pending", []), ("pending", "damaged")])
def test_reviewed_blocked_and_malformed_saved_trust_are_never_folded(status, trust):
    protected = pending(observed="2026-10-11T23:42:00Z")
    protected["status"] = status
    if trust is not None:
        protected["peer_trust"] = trust
    assert presentation.previous_discoveries({"protected": protected, "latest": pending()}) == {}


def test_endpoint_grouping_never_uses_names_or_combines_listener_ports():
    entries = {"older": pending(observed="2026-10-11T23:42:00Z", name="Windows default"),
               "latest": pending(name="Owner's new name"),
               "other-port": pending(port=8443), "other-ip": pending(ip="192.168.2.21")}
    assert presentation.previous_discoveries(entries) == {"older": "latest"}


@pytest.mark.parametrize("ip,port", [("example.test", 8000), ("192.168.2.020", 8000), ("", 8000),
                                     ("192.168.2.20", True), ("192.168.2.20", 0), ("192.168.2.20", 65536),
                                     ("192.168.2.20", "8000/anything")])
def test_nonliteral_or_invalid_endpoint_is_not_folded(ip, port):
    assert presentation.previous_discoveries({"a": pending(ip=ip, port=port), "b": pending(ip=ip, port=port)}) == {}


def test_last_seen_fallback_equal_times_and_invalid_times_are_deterministic():
    entries = {"a": pending(observed=None, seen="2026-10-12T01:00:00Z"),
               "b": pending(observed="not a timestamp", seen="2026-10-12T02:00:00Z")}
    assert presentation.previous_discoveries(entries) == {"a": "b"}
    entries = {"a": pending(), "b": pending()}
    assert presentation.previous_discoveries(entries) == {"a": "b"}
    assert presentation.previous_discoveries(dict(reversed(list(entries.items())))) == {"a": "b"}
    entries = {"a": pending(observed=[], seen="invalid"), "b": pending(observed={}, seen="2026-10-12T02:00:00")}
    assert presentation.previous_discoveries(entries) == {"a": "b"}
    entries["a"]["last_seen"] = "2026-10-12T02:00:00Z"
    assert presentation.previous_discoveries(entries) == {"b": "a"}


def test_discovery_time_precedes_secondary_last_seen_and_timezone_offsets_compare_as_instants():
    entries = {"a": pending(observed="2026-10-11T22:27:00-04:00", seen="2026-10-12T02:28:00Z"),
               "b": pending(observed="2026-10-12T02:26:00Z", seen="2026-10-12T03:00:00Z")}
    assert presentation.previous_discoveries(entries) == {"b": "a"}
    entries["b"]["discovery"]["observed_at"] = "2026-10-12T02:27:00Z"
    assert presentation.previous_discoveries(entries) == {"a": "b"}


def test_self_identity_is_never_involved_in_discovery_folding():
    assert presentation.previous_discoveries({"self": pending(), "peer": pending()}, self_id="self") == {}


@pytest.mark.parametrize("status,trust", [("allowed", {"card": "reviewed", "grants": ["messages"]}),
                                          ("blocked", None), ("pending", {"card": "reviewed"})])
def test_current_computer_remains_anchor_after_review_or_block_and_newer_identity_stays_visible(status, trust):
    current = pending()
    current.update(status=status)
    if trust is not None:
        current["peer_trust"] = trust
    entries = {"older": pending(observed="2026-10-11T23:42:00Z"), "current": current}
    assert presentation.previous_discoveries(entries) == {"older": "current"}
    entries["replacement"] = pending(observed="2026-10-12T03:00:00Z")
    previous = presentation.previous_discoveries(entries)
    assert previous == {"older": "replacement"}
    assert "current" not in previous and "replacement" not in previous


def test_health_roster_folds_hints_but_lan_and_directory_preserve_original_ids(peers, monkeypatch):
    from routers import system_routes
    entries = {"older": pending(observed="2026-10-11T23:42:00Z"), "current": pending(),
               "other-port": pending(port=8443), "blocked": dict(pending(), status="blocked"),
               "reviewed": copy.deepcopy(S.load_mesh_directory()["peer-b"])}
    entries["reviewed"]["status"] = "pending"  # A previous grant still requires identity-specific display.
    entries["reviewed"]["ip"] = "192.168.2.20"
    entries["reviewed"]["tli_port"] = 8000
    entries["older"]["discovery"]["verified"] = True  # An unsigned hint cannot grant authority.
    entries["older"]["discovery"]["grants"] = ["messages"]
    S.save_mesh_directory(entries)
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    monkeypatch.setattr(system_routes, "agent_health", lambda: {"node_name": "Local"})
    monkeypatch.setattr(mesh, "_ensure_host_in_mesh_directory", lambda: None)
    health = mesh.mesh_health(_session="owner")
    normal = {row["peer_id"]: row for row in health["nodes"] if not row["is_self"]}
    assert set(normal) == {"current", "other-port", "blocked", "reviewed"}
    assert normal["current"]["last_seen"] == entries["current"]["last_seen"]
    assert normal["current"]["discovery_observed_at"] == entries["current"]["discovery"]["observed_at"]
    assert normal["current"]["connection_state"] == "review_required"
    assert normal["current"]["online"] is None
    assert len(health["previous_discoveries"]) == 1
    assert health["previous_discoveries"][0]["peer_id"] == "older"
    assert health["previous_discoveries"][0]["superseded_by"] == "current"
    assert health["previous_discoveries"][0]["pairing_available"] is False
    chat = {row["id"]: row for row in mesh.get_lan_peers(_session="owner")["peers"]}
    assert set(chat) == set(entries)
    assert chat["older"]["previous_discovery"] is True
    assert chat["older"]["superseded_by"] == "current"
    assert chat["older"]["messaging"]["available"] is False
    assert not chat["current"]["previous_discovery"] and chat["current"]["superseded_by"] is None
    directory = mesh.get_mesh_directory(_session="owner").model_dump()["devices"]
    assert {row["device_id"] for row in directory} == set(entries)
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before


@pytest.mark.parametrize("trust", [{}, [], "damaged"])
def test_health_disables_quick_pairing_for_malformed_saved_trust(peers, monkeypatch, trust):
    from routers import system_routes
    protected = pending(observed="2026-10-11T23:42:00Z")
    protected["peer_trust"] = trust
    S.save_mesh_directory({"protected": protected, "current": pending()})
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    monkeypatch.setattr(system_routes, "agent_health", lambda: {"node_name": "Local"})
    health = mesh.mesh_health(_session="owner")
    rows = {row["peer_id"]: row for row in health["nodes"] if not row["is_self"]}
    assert set(rows) == {"protected", "current"}
    assert rows["protected"]["pairing_available"] is False
    assert rows["current"]["pairing_available"] is True
    assert health["previous_discoveries"] == []
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before
