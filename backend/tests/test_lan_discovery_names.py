"""Discovery follows setup names without replacing reviewed identities."""
from __future__ import annotations

import copy
import json
from types import SimpleNamespace

import pytest

import lan_discovery as lan
import tli_state as S


@pytest.fixture
def directory(monkeypatch):
    records = {}
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(node_id="local", node_name="FOX"))
    monkeypatch.setattr(S, "load_mesh_directory", lambda: copy.deepcopy(records))
    def save(value):
        records.clear()
        records.update(copy.deepcopy(value))
    monkeypatch.setattr(S, "save_mesh_directory", save)
    monkeypatch.setattr(S, "log_debug", lambda *args, **kwargs: None)
    monkeypatch.setattr(lan, "_presence_broadcast_fn", None)
    return records


def test_setup_rename_refreshes_pending_discovered_computer(directory):
    lan._upsert_peer("dell", "DESKTOP-OLD", "192.168.4.135", 8000)
    directory["dell"]["labels"] = ["Office"]
    directory["dell"]["notes"] = "Laptop"

    lan._handle_beacon(json.dumps({"tli": 1, "id": "dell", "name": "TheLegatoDell", "port": 8000}).encode(), "192.168.4.135")

    peer = directory["dell"]
    assert peer["display_name"] == "TheLegatoDell"
    assert peer["discovery"]["name"] == "TheLegatoDell"
    assert peer["discovery"]["verified"] is False
    assert peer["status"] == "pending"
    assert peer["labels"] == ["Office"] and peer["notes"] == "Laptop"
    assert "peer_trust" not in peer


def test_already_stale_pending_name_recovers_on_next_observation(directory):
    directory["dell"] = {"display_name": "DESKTOP-OLD", "status": "pending",
                         "discovery": {"name": "TheLegatoDell"}}
    lan._upsert_peer("dell", "TheLegatoDell", "192.168.4.135", 8000)
    assert directory["dell"]["display_name"] == "TheLegatoDell"


@pytest.mark.parametrize("status", ["allowed", "blocked", "pending"])
def test_discovery_rename_preserves_reviewed_name_and_authority(directory, status):
    original = {"display_name": "Reviewed Dell", "status": status, "ip": "192.168.4.135",
                "tli_port": 8443, "peer_trust": {"grants": ["messages"], "revision": 7}}
    directory["dell"] = copy.deepcopy(original)
    lan._upsert_peer("dell", "Unsigned replacement", "192.168.4.136", 8000)
    saved = copy.deepcopy(directory["dell"])
    observation = saved.pop("discovery")
    assert saved == original
    assert observation["name"] == "Unsigned replacement" and observation["verified"] is False


def test_blocked_unreviewed_name_stays_identifiable(directory):
    directory["dell"] = {"display_name": "Blocked Dell", "status": "blocked"}
    lan._upsert_peer("dell", "Unsigned replacement", "192.168.4.135", 8000)
    assert directory["dell"]["display_name"] == "Blocked Dell"
    assert directory["dell"]["status"] == "blocked"


def test_same_address_does_not_merge_ids_or_inherit_trust(directory):
    old = {"display_name": "Previous Dell", "status": "blocked", "ip": "192.168.4.135",
           "tli_port": 8000, "peer_trust": {"grants": ["messages"], "revision": 7}}
    directory["old-dell-id"] = copy.deepcopy(old)
    lan._upsert_peer("new-dell-id", "TheLegatoDell", "192.168.4.135", 8000)
    assert directory["old-dell-id"] == old
    assert directory["new-dell-id"]["status"] == "pending"
    assert "peer_trust" not in directory["new-dell-id"]
