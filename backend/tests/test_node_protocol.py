"""Lightweight compute boundaries using synthetic identities and local fakes."""
import copy
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import lan_inference as L
import peer_trust as P
import tli_state as S
from peer_inference_routes import make_peer_router
from tests.test_lan_inference import authorize, payload, resource
from tests.test_peer_trust import browser, entry, peers


def node_card(peers):
    card = copy.deepcopy(peers.b)
    card["capabilities"] = ["inference_v1"]
    card.pop("signature")
    card["signature"] = peers.key_b.sign(P.canonical(card)).hex()
    return card


@pytest.mark.parametrize("value", ["https://192.168.2.10:0", "https://192.168.2.10:65536", "https://192.168.2.10:-1"])
def test_node_origin_never_reinterprets_invalid_explicit_port(value):
    with pytest.raises(HTTPException):
        P.origin(value)


@pytest.mark.parametrize("scheme", ["http", "https"])
def test_node_model_origin_never_reinterprets_zero_port(scheme):
    with pytest.raises(HTTPException):
        L._local_url(f"{scheme}://127.0.0.1:0/v1/chat/completions", "/v1/chat/completions")


def signed_request(peers, method, path, body=None):
    raw = P.canonical(body) if body is not None else b""
    stamp, nonce = str(int(time.time())), ("ab" if method == "GET" else "cd") * 24
    signed = P._signed(method, path, raw,
                       {"node_id": peers.a["node_id"], "public_key": peers.a["public_key"]},
                       stamp, nonce, peers.b["node_id"])
    headers = {"content-type": "application/json", "x-tli-peer-id": peers.b["node_id"],
               "x-tli-peer-time": stamp, "x-tli-peer-nonce": nonce,
               "x-tli-peer-signature": peers.key_b.sign(signed).hex()}
    return raw, headers


def test_inference_only_card_requires_explicit_inference_review(peers):
    card = node_card(peers)
    assert P.validate_card(card) == card
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    preview = P.preview(card, ["inference"], "owner", browser())
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before
    P.approve(preview["review_id"], card["identity_fingerprint"], card["certificate_sha256"], "owner", browser())
    assert P.trusted("peer-b", "inference")[1] == card
    assert L.peers()["peers"] == [{"id": "peer-b", "name": card["name"]}]
    assert P.public_trust("peer-b")["peer_profile"] == "inference_node"
    with pytest.raises(HTTPException) as error:
        P.trusted("peer-b", "observe")
    assert error.value.status_code == 403


@pytest.mark.parametrize("grants", [["observe"], ["coordinate"], ["messages"], ["inference", "observe"]])
def test_node_profile_cannot_be_reviewed_or_saved_with_other_grants(peers, grants):
    card = node_card(peers)
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    with pytest.raises(HTTPException) as error:
        P.preview(card, grants, "owner", browser())
    assert error.value.status_code == 422
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before
    S.save_mesh_directory({"peer-b": entry(card, grants=grants)})
    with pytest.raises(HTTPException) as error:
        P.trusted("peer-b")
    assert error.value.status_code == 409


@pytest.mark.parametrize("capabilities", [[], ["inference_v1", "messages_v1"], ["inference_v2"], ["command.execute"]])
def test_signed_but_unknown_capability_profiles_are_rejected(peers, capabilities):
    card = node_card(peers)
    card["capabilities"] = capabilities
    card.pop("signature")
    card["signature"] = peers.key_b.sign(P.canonical(card)).hex()
    with pytest.raises(HTTPException):
        P.validate_card(card)


def test_card_export_preserves_host_default_and_explicit_node_profile(peers, monkeypatch):
    import tls_cert
    monkeypatch.setattr(S, "TLS_ENABLED", True)
    monkeypatch.setattr(S, "SERVER_BIND_PORT", 8443)
    monkeypatch.setattr(tls_cert, "certificate_bundle", lambda *args: {
        "certificate_der": peers.a["certificate_der"], "fingerprint": peers.a["certificate_sha256"]})
    host = P.local_card(peers.a["origin"])
    node = P.local_card(peers.a["origin"], capabilities=["inference_v1"])
    assert host["capabilities"] == ["system_observation_v1", "coordination_v1", "messages_v1"]
    assert node["capabilities"] == ["inference_v1"]
    assert P.validate_card(host) == host
    assert P.validate_card(node) == node
    assert host["public_key"] == node["public_key"]
    assert "peer_profile" not in P.public_trust("peer-b")
    with pytest.raises(HTTPException):
        P.local_card(peers.a["origin"], capabilities=["inference_v1", "command.execute"])


def test_standalone_import_and_catalog_never_load_host_or_bundled_runtime(tmp_path):
    code = """
import builtins, json, sys
from types import SimpleNamespace
import peer_inference_routes
import lan_inference as L
import tli_state as S
original = builtins.__import__
def guarded(name, *args, **kwargs):
    if name in ('ai.ai_manager', 'main', 'routers.system_routes', 'companion_auth', 'vault_security'):
        raise AssertionError('Unexpected host import: ' + name)
    return original(name, *args, **kwargs)
builtins.__import__ = guarded
S.lm_provider = SimpleNamespace(chat_url='http://127.0.0.1:1234/v1/chat/completions', models_url='http://127.0.0.1:1234/v1/models')
L._local_json = lambda *args, **kwargs: {'models': [{'type': 'llm', 'key': 'local', 'loaded_instances': [{'id': 'instance', 'config': {'context_length': 4096}}]}]}
rows = L._resources(include_bundled=False)
assert [r['model_id'] for r in rows] == ['instance']
for name in ('ai.ai_manager', 'main', 'routers.system_routes', 'companion_auth', 'vault_security'):
    assert name not in sys.modules, name
print(json.dumps({'models': len(rows)}))
"""
    env = {**os.environ, "TLI_ROOT": str(tmp_path), "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
    result = subprocess.run([sys.executable, "-c", code], env=env, cwd=tmp_path, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"models": 1}


def test_peer_only_router_exposes_no_host_surfaces_and_rejects_unsigned_input(peers):
    calls = []
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.include_router(make_peer_router(resource_loader=lambda **kw: calls.append(kw)))
    assert set(app.openapi()["paths"]) == {"/agent/peer/inference", "/agent/peer/inference/stream"}
    with TestClient(app, base_url="https://192.168.2.10:8443") as client:
        assert client.get("/agent/peer/inference").status_code == 401
        assert client.post("/agent/peer/inference/stream", json=payload()).status_code == 401
        for path in ("/", "/docs", "/redoc", "/openapi.json", "/api/ai/lan/peers", "/api/ai/chat",
                     "/vault/status", "/open_reveal", "/mesh/trust/approve"):
            assert client.get(path).status_code == 404
            assert client.post(path, json={}).status_code == 404
    assert calls == []


def test_injected_catalog_and_worker_share_signed_permissions_and_stream_lifecycle(peers, monkeypatch):
    authorize(peers)
    row = resource()
    checks = []
    def loader(*, check):
        check()
        checks.append(True)
        return [row]
    monkeypatch.setattr(L, "_resources", lambda **kw: pytest.fail("Default catalog accessed by Node"))
    monkeypatch.setattr(L, "_lm_binding", lambda: row["_binding"])
    requests = []
    def upstream(resource, messages, max_tokens, temperature, check):
        check()
        requests.append(copy.deepcopy(messages))
        yield {"type": "delta", "text": "Prepared context handled"}
        yield {"type": "done"}
    monkeypatch.setattr(L, "_upstream", upstream)
    app = FastAPI(); app.include_router(make_peer_router(resource_loader=loader))
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    with TestClient(app, base_url="https://192.168.2.10:8443") as client:
        _, headers = signed_request(peers, "GET", "/agent/peer/inference")
        catalog = client.get("/agent/peer/inference", headers=headers)
        assert catalog.status_code == 200, catalog.text
        assert catalog.json()["resources"] == [L._public_resource(row)]
        assert catalog.headers["Cache-Control"] == "no-store"
        raw, headers = signed_request(peers, "POST", "/agent/peer/inference/stream", payload())
        response = client.post("/agent/peer/inference/stream", content=raw, headers=headers)
        assert response.status_code == 200, response.text
        events = [json.loads(event) for event in L._events(iter(response.content.splitlines(keepends=True)))]
        assert [event["type"] for event in events] == ["meta", "delta", "done"]
        assert events[0]["peer"]["id"] == "local-a"
        assert client.post("/agent/peer/inference/stream", content=raw, headers=headers).status_code == 409
    assert requests == [payload()["messages"]]
    assert checks == [True, True]
    assert not L._SLOT.locked()
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before
