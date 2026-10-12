"""Own-node advertisements follow the running listener, not a stale default."""
from __future__ import annotations

import copy
import asyncio
import json
import os
from types import SimpleNamespace
from pathlib import Path

import pytest
from fastapi import BackgroundTasks

import lan_discovery
import node_identity
import startup_config
import tli_state as S
from routers import mesh_routes as mesh

_REAL_SAVE_NODE_CONFIG = S.save_node_config
_REAL_LOAD_NODE_CONFIG = S.load_node_config


@pytest.fixture()
def installation(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "BASE_DIR", str(tmp_path))
    monkeypatch.setattr(S, "SERVER_BIND_PORT", None)
    for name in ("TLI_HOST", "TLI_PORT", "TLI_LAN_MODE", "TLI_ENABLE_TLS"):
        monkeypatch.delenv(name, raising=False)
    startup_config.write({"host": "0.0.0.0", "port": 8443, "https": True}, tmp_path)
    cfg = S.NodeConfig(node_id="fixture-host", node_name="Fixture host", role="host", mesh_status="approved",
                       created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z")
    directory = {
        cfg.node_id: {"display_name": cfg.node_name, "ip": "192.0.2.10", "tli_port": 8000},
        "fixture-peer": {"display_name": "Fixture peer", "ip": "192.0.2.11", "tli_port": 9123},
    }
    monkeypatch.setattr(S, "load_node_config", lambda: cfg)
    monkeypatch.setattr(S, "save_node_config", lambda value: None)
    monkeypatch.setattr(S, "load_mesh_directory", lambda: directory)
    monkeypatch.setattr(S, "save_mesh_directory", lambda value: None)
    monkeypatch.setattr(S, "log_debug", lambda *a, **kw: None)
    monkeypatch.setattr(mesh.socket, "gethostname", lambda: "fixture-host")
    monkeypatch.setattr(mesh.socket, "gethostbyname", lambda name: "192.0.2.10")
    return tmp_path, cfg, directory


def test_saved_nondefault_port_in_beacon_without_environment_mutation(installation):
    env = dict(os.environ)
    assert S.server_port() == 8443
    assert json.loads(lan_discovery._make_beacon())["port"] == 8443
    assert dict(os.environ) == env


def test_saved_port_edit_does_not_change_running_advertisements(installation, monkeypatch):
    root, cfg, directory = installation
    monkeypatch.setattr(S, "SERVER_BIND_PORT", S.server_port())
    startup_config.write({"host": "0.0.0.0", "port": 9443, "https": True}, root)
    assert startup_config.resolve(root)["effective_next"]["port"] == 9443
    assert S.server_port() == 8443
    assert json.loads(lan_discovery._make_beacon())["port"] == 8443
    mesh._ensure_self_registered()
    assert directory[cfg.node_id]["tli_port"] == 8443
    assert "TLI_PORT" not in os.environ


def test_explicit_environment_port_applies_before_listener_is_known(installation, monkeypatch):
    monkeypatch.setenv("TLI_PORT", "9234")
    assert S.server_port() == 9234
    monkeypatch.setattr(S, "SERVER_BIND_PORT", 8443)
    assert S.server_port() == 8443


@pytest.mark.parametrize("refresh", [mesh._ensure_host_in_mesh_directory, mesh._ensure_self_registered])
def test_existing_self_directory_entry_refreshes_only_own_port(installation, refresh):
    _, cfg, directory = installation
    peer = copy.deepcopy(directory["fixture-peer"])
    refresh()
    assert directory[cfg.node_id]["tli_port"] == 8443
    assert directory["fixture-peer"] == peer


def test_first_self_registration_uses_saved_port(installation):
    _, cfg, directory = installation
    del directory[cfg.node_id]
    mesh._ensure_self_registered()
    assert directory[cfg.node_id]["tli_port"] == 8443


def test_become_host_uses_own_port_and_retains_peer_port(installation):
    _, cfg, directory = installation
    response = mesh.become_host()
    assert response["host_address"] == "192.0.2.10:8443"
    assert directory[cfg.node_id]["tli_port"] == 8443
    assert directory["fixture-peer"]["tli_port"] == 9123


def test_join_request_advertises_own_port_without_changing_host_target(installation, monkeypatch):
    calls = []
    def post(address, path, **kwargs):
        calls.append((address, path, kwargs))
        return SimpleNamespace(status_code=200)
    monkeypatch.setattr(mesh, "_node_post", post)
    mesh.start_join_request(mesh.MeshJoinStartRequest(host_address="192.0.2.11:9123"))
    assert len(calls) == 1
    assert calls[0][0] == "192.0.2.11:9123"
    assert calls[0][2]["json"]["tli_port"] == 8443


def test_presence_refreshes_existing_self_port(installation, monkeypatch):
    _, cfg, directory = installation
    monkeypatch.setattr(node_identity, "fingerprint", lambda: "fixture-fingerprint")
    def finish(_):
        raise StopIteration("one isolated iteration")
    monkeypatch.setattr(mesh, "_background_stop", SimpleNamespace(is_set=lambda:False,wait=finish))
    with pytest.raises(StopIteration):
        mesh._self_presence_loop()
    assert directory[cfg.node_id]["tli_port"] == 8443
    assert directory["fixture-peer"]["tli_port"] == 9123


def test_discovery_never_changes_firewall(installation,monkeypatch):
    import subprocess
    monkeypatch.setattr(subprocess,'run',lambda *args,**kwargs:pytest.fail('No automatic firewall changes'))
    assert lan_discovery._try_open_firewall() is None


@pytest.mark.parametrize("advertised", [9123, "9123"])
def test_chat_send_uses_registered_recipient_port(installation, monkeypatch, advertised):
    from tests.test_peer_trust import computer, entry
    import peer_trust
    import time
    _, _, directory = installation
    _, card = computer("fixture-peer", port=int(advertised))
    directory["fixture-peer"] = entry(card)
    persisted, sent = [], []
    monkeypatch.setattr(mesh, "_append_chat_msg", lambda thread, msg: persisted.append(msg))
    monkeypatch.setattr(peer_trust, "record_message_once", lambda message, direction, append: append())
    def exchange(card, method, path, body, headers, before_send):
        before_send();sent.append((card["origin"], path, body))
        msg=json.loads(body)
        ack={key:msg[key] for key in ('message_id','thread_id','from_id','to_id')}
        return peer_trust.Response(200, peer_trust.canonical(dict(ack,ok=True,duplicate=False)))
    monkeypatch.setattr(peer_trust, "_exchange", exchange)
    message = mesh.ChatMessageRequest(thread_id="fixture-host--fixture-peer", from_id="fixture-host", from_name="Fixture host",
        to_id="fixture-peer", to_ip="192.168.2.20", body="Fixture message", ts=time.time()*1000, message_id="port-fixture-message-identifier")
    assert mesh.mesh_chat_send(message, BackgroundTasks())["delivery"] == "acknowledged"
    assert len(persisted) == 1 and len(sent) == 1
    assert sent[0][0] == f"https://192.168.2.20:{advertised}"
    assert sent[0][1] == "/mesh/chat/receive"
    assert json.loads(sent[0][2])["to_id"] == "fixture-peer"


@pytest.mark.parametrize("to_id,to_ip,port", [
    ("unknown-peer", "192.0.2.11", 9123),
    ("fixture-peer", "192.0.2.12", 9123),
    ("fixture-peer", "192.0.2.11", None),
])
def test_unadvertised_recipient_requires_review_without_default_port_fallback(installation, monkeypatch, to_id, to_ip, port):
    from fastapi import HTTPException
    import peer_trust
    _, _, directory = installation
    directory["fixture-peer"]["tli_port"] = port
    sent = []
    monkeypatch.setattr(peer_trust, "_exchange", lambda *a: sent.append(a))
    with pytest.raises(HTTPException):
        mesh._forward_to_remote(to_ip, {"to_id": to_id, "body": "Fixture message"})
    assert sent == []


@pytest.mark.parametrize("address", ["192.0.2.10:8000", "https://192.0.2.10:8000", "[2001:db8::10]:8000"])
def test_own_saved_host_address_refresh_preserves_config_and_running_port(installation, monkeypatch, address):
    root, cfg, directory = installation
    monkeypatch.setattr(S, "DATA_DIR", str(root / "data"))
    monkeypatch.setattr(S, "NODE_CONFIG_PATH", root / "data" / "mesh" / "node_config.json")
    monkeypatch.setattr(S, "load_node_config", _REAL_LOAD_NODE_CONFIG)
    monkeypatch.setattr(S, "save_node_config", _REAL_SAVE_NODE_CONFIG)
    cfg.host_address = address
    raw = {**cfg.model_dump(), "future_metadata": {"preserve": True}}
    S.NODE_CONFIG_PATH.parent.mkdir(parents=True)
    S.NODE_CONFIG_PATH.write_text(json.dumps(raw))
    monkeypatch.setattr(S, "SERVER_BIND_PORT", 8443)
    mesh._ensure_self_registered()
    saved = json.loads(S.NODE_CONFIG_PATH.read_text())
    assert saved["host_address"] == address.removesuffix(":8000") + ":8443"
    assert saved["future_metadata"] == {"preserve": True}
    before = S.NODE_CONFIG_PATH.read_bytes()
    startup_config.write({"host": "0.0.0.0", "port": 9443, "https": True}, root)
    mesh._ensure_self_registered()
    assert S.NODE_CONFIG_PATH.read_bytes() == before
    monkeypatch.setattr(S, "SERVER_BIND_PORT", 9443)  # next confirmed listener
    mesh._ensure_self_registered()
    saved = json.loads(S.NODE_CONFIG_PATH.read_text())
    assert saved["host_address"] == address.removesuffix(":8000") + ":9443"
    assert saved["future_metadata"] == {"preserve": True}


def test_member_remote_host_address_never_uses_local_port(installation):
    _, cfg, _ = installation
    cfg.role = "member"
    cfg.host_address = "192.0.2.11:9123"
    mesh._ensure_self_registered()
    mesh._ensure_host_in_mesh_directory()
    assert cfg.host_address == "192.0.2.11:9123"
