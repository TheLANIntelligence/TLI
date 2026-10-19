"""Compute-only Nodes have truthful directory status without observation probes."""
from types import SimpleNamespace

from routers import mesh_routes, system_routes
from tests.test_peer_trust import computer, entry


def install_directory(monkeypatch):
    monkeypatch.setattr(mesh_routes, "_ensure_host_in_mesh_directory", lambda: None)
    monkeypatch.setattr(mesh_routes.S, "load_node_config", lambda: SimpleNamespace(node_id="primary", role="host"))
    monkeypatch.setattr(mesh_routes.S, "read_node_config", lambda: SimpleNamespace(node_id="primary", role="host"))
    key,node=computer('compute','192.168.1.50',8444)
    node['capabilities']=['inference_v1']; node.pop('signature')
    node['signature']=key.sign(mesh_routes.peer_trust.canonical(node)).hex()
    _,host=computer('host','192.168.1.51',8000)
    records={'compute':entry(node,grants=['inference']),'host':entry(host)}
    monkeypatch.setattr(mesh_routes.S, 'load_mesh_directory', lambda:records)


def test_directory_preserves_compute_profile_without_changing_full_host(monkeypatch):
    install_directory(monkeypatch)
    result = mesh_routes.get_mesh_directory(_session="local").model_dump()
    devices = {row["device_id"]: row for row in result["devices"]}
    assert devices["compute"]["peer_profile"] == "inference_node"
    assert devices["host"]["peer_profile"] is None
    assert devices["compute"]["trust_state"] == "verified"


def test_collective_health_does_not_probe_compute_nodes_or_label_them_offline(monkeypatch):
    install_directory(monkeypatch)
    monkeypatch.setattr(system_routes, "agent_health", lambda: {"node_name": "Primary"})
    contacted = []
    def health(ident):
        assert ident == "host"
        contacted.append(ident)
        return {"node_name": "Other full TLI"}
    monkeypatch.setattr(mesh_routes.peer_trust, "health", health)
    result = mesh_routes.mesh_health(_session="local")
    nodes = {row.get("peer_id"): row for row in result["nodes"]}
    assert nodes["compute"]["online"] is None
    assert nodes["compute"]["connection_state"] in {'unknown','discovered'}
    assert nodes["compute"]["trust_state"] == "verified"
    assert nodes["host"]["online"] is None
    assert contacted == []
