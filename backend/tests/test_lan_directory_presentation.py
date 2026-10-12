"""Saved discovery names and local message readiness, without live LAN access."""
import copy

import pytest

import tli_state as S
from routers import mesh_routes as mesh
from tests.test_peer_trust import peers


def test_saved_pre_setup_hostname_is_projected_without_new_beacon_or_trust(peers, monkeypatch):
    directory = {
        "old-install": {"display_name": "DESKTOP-OLD", "ip": "192.168.2.20", "status": "pending",
                        "discovery": {"name": "Dell laptop", "verified": False}},
        "current-install": {"display_name": "DESKTOP-OLD", "ip": "192.168.2.20", "status": "pending",
                            "discovery": {"name": "Dell laptop", "verified": False}},
    }
    S.save_mesh_directory(directory)
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    monkeypatch.setattr(mesh, "_ensure_host_in_mesh_directory", lambda: None)
    listed = mesh.get_mesh_directory(_session="owner").model_dump()["devices"]
    chat = mesh.get_lan_peers(_session="owner")["peers"]
    assert len(listed) == len(chat) == 2
    assert {row["device_id"] for row in listed} == set(directory)
    assert {row["id"] for row in chat} == set(directory)
    assert all(row["display_name"] == "Dell laptop" for row in listed)
    assert all(row["name"] == "Dell laptop" for row in chat)
    for row in listed + chat:
        assert row["status"] == "pending"
        assert row["messaging"]["available"] is False
        assert row["messaging"]["code"] == "peer_pending"
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before


@pytest.mark.parametrize("status", ["allowed", "pending", "blocked"])
def test_discovered_rename_does_not_replace_reviewed_name(peers, status):
    directory = S.load_mesh_directory()
    directory["peer-b"].update(status=status, discovery={"name": "Unreviewed rename"})
    S.save_mesh_directory(directory)
    row = mesh.get_lan_peers(_session="owner")["peers"][0]
    assert row["name"] == peers.b["name"]
    assert row["discovered_name"] == "Unreviewed rename"
    assert row["messaging"]["available"] is (status == "allowed")


def test_self_directory_name_follows_config_and_other_identities_are_preserved(peers):
    directory = S.load_mesh_directory()
    other = copy.deepcopy(directory["peer-b"])
    directory["local-a"] = {"display_name": "PRE-SETUP-HOSTNAME", "ip": "192.168.2.10",
                            "status": "allowed", "notes": "Keep this"}
    S.save_mesh_directory(directory)
    mesh._ensure_host_in_mesh_directory()
    saved = S.load_mesh_directory()
    assert saved["local-a"]["display_name"] == peers.cfg.node_name
    assert saved["local-a"]["notes"] == "Keep this"
    assert saved["peer-b"] == other


@pytest.mark.parametrize("discovery", [None, [], {"name": " "}, {"name": []}, {"name": "x" * 129}])
def test_invalid_discovery_name_keeps_saved_label(discovery):
    assert mesh._peer_display_name("peer", {"display_name": "Saved", "status": "pending",
                                           "discovery": discovery}) == "Saved"


def test_visible_computer_cards_offer_requests_only_for_unreviewed_pending_peers(peers, monkeypatch):
    from routers import system_routes
    directory = S.load_mesh_directory()
    directory['peer-b']['status'] = 'pending'  # Retains an earlier reviewed card.
    directory['fresh'] = {'display_name': 'OLD-HOSTNAME', 'status': 'pending', 'ip': '192.168.2.30',
                          'discovery': {'name': 'Dell laptop'}}
    directory['blocked'] = {'display_name': 'Blocked computer', 'status': 'blocked', 'ip': '192.168.2.40'}
    S.save_mesh_directory(directory)
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    monkeypatch.setattr(system_routes, 'agent_health', lambda: {'node_name': 'Local'})
    result = mesh.mesh_health(_session='owner')
    nodes = {row['peer_id']: row for row in result['nodes'] if not row['is_self']}
    assert nodes['fresh']['node_name'] == 'Dell laptop'
    assert nodes['fresh']['pairing_available'] is True
    assert nodes['blocked']['pairing_available'] is False
    assert nodes['peer-b']['pairing_available'] is False
    assert all(row['connection_state'] == 'review_required' for row in nodes.values())
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before
