"""Compute-only Nodes have truthful directory status without observation probes."""
from types import SimpleNamespace

from routers import mesh_routes, system_routes


def install_directory(monkeypatch):
    monkeypatch.setattr(mesh_routes, "_ensure_host_in_mesh_directory", lambda: None)
    monkeypatch.setattr(mesh_routes.S, "load_node_config", lambda: SimpleNamespace(node_id="primary", role="host"))
    monkeypatch.setattr(mesh_routes.S, "load_mesh_directory", lambda: {
        "compute": {"display_name": "Gaming PC", "ip": "192.168.1.50", "tli_port": 8444, "status": "allowed"},
        "host": {"display_name": "Other full TLI", "ip": "192.168.1.51", "tli_port": 8000, "status": "allowed"}})
    monkeypatch.setattr(mesh_routes.peer_trust, "public_trust", lambda ident: {
        "trust_state": "verified", "trust_revision": "a" * 64,
        **({"peer_profile": "inference_node"} if ident == "compute" else {})})


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
    def trusted(ident, grant):
        assert ident == "host" and grant == "coordinate"
    def health(ident):
        assert ident == "host"
        contacted.append(ident)
        return {"node_name": "Other full TLI"}
    monkeypatch.setattr(mesh_routes.peer_trust, "trusted", trusted)
    monkeypatch.setattr(mesh_routes.peer_trust, "health", health)
    result = mesh_routes.mesh_health(_session="local")
    nodes = {row.get("peer_id"): row for row in result["nodes"]}
    assert nodes["compute"]["online"] is None
    assert nodes["compute"]["connection_state"] == "inference_only"
    assert nodes["compute"]["trust_state"] == "verified"
    assert nodes["host"]["online"] is True
    assert contacted == ["host"]
