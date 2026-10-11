"""Actual Chat dispatch must preserve a selected computer before any check."""
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import tli_state as S
from ai import ai_routes as bundled
from routers import chat_routes as legacy
from intelligence import devices, diagnostics

PATHS = ["/api/ai/chat", "/api/ai/chat/stream", "/chat"]
HOST = {"id": "host-one", "name": "Study"}


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(
        node_id=HOST["id"], node_name=HOST["name"], role="standalone", host_address=None))
    monkeypatch.setattr(devices, "node", lambda: dict(HOST))
    def get(ident):
        if ident == "missing":
            raise HTTPException(404, "Selected computer is unavailable")
        return {"id": ident, "name": "Study", "source": "local_node" if ident == "local" else "mesh",
                "source_id": HOST["id"] if ident == "local" else "other-host", "kind": "computer",
                "address": "192.0.2.10"}
    monkeypatch.setattr(devices, "get", get)
    def forbidden(*args, **kwargs):
        pytest.fail("An explicit diagnostic cannot fall through to a provider or device action")
    for obj, names in [
        (bundled, ("_route_action_intent", "_tool_answer", "_llama_post", "_llama_stream_raw", "_find_mesh_ai_peer")),
        (legacy, ("choose_model", "proxy_chat_to_host")),
        (S.lm_provider, ("complete", "health_check"))]:
        for name in names:
            monkeypatch.setattr(obj, name, forbidden)
    monkeypatch.setattr(bundled.BundledAIManager, "get", lambda: SimpleNamespace(ensure_running=forbidden))
    return monkeypatch


def frames(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("question", ["check my system", "check my network"])
@pytest.mark.parametrize("target,code", [("remote", 422), ("missing", 404)])
def test_remote_or_missing_selection_rejected_before_any_measurement(path, question, target, code, client, isolated):
    calls = []
    import event_bus
    isolated.setattr(event_bus, "emit_event", lambda *args, **kwargs: calls.append("event"))
    isolated.setattr(diagnostics, "probe", lambda ident, label, fn: calls.append("probe") or
                       {"id": ident, "label": label, "status": "unavailable", "detail": "Synthetic sample"})
    isolated.setattr(diagnostics.psutil, "disk_partitions", lambda **kwargs: [])
    isolated.setattr(diagnostics, "write_private", lambda *args, **kwargs: calls.append("save"))
    response = client.post(path, json={"message": question, "target_id": target, "brain": "lmstudio"})
    if path.endswith("/stream") and response.status_code == 200:
        assert response.status_code == 200
        events = frames(response)
        assert [event["type"] for event in events] == ["error"]
        detail = events[0]["detail"]
    else:
        assert response.status_code == code, response.text
        detail = response.json()["detail"]
    assert ("TLI host" if target == "remote" else "unavailable") in detail
    assert calls == []
    assert diagnostics.history("local") == []
    assert all(not row.get("messages") for row in S.load_conversations().values())


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("target", [None, "local"])
def test_explicit_host_check_still_saves_the_measured_host(path, target, client, isolated):
    measured = []
    isolated.setattr(diagnostics.psutil, "cpu_percent", lambda **kw: measured.append("cpu") or 12)
    isolated.setattr(diagnostics.psutil, "virtual_memory", lambda: SimpleNamespace(percent=34))
    isolated.setattr(diagnostics.psutil, "disk_partitions", lambda **kw: [])
    response = client.post(path, json={"message": "check my system", "target_id": target, "brain": "lmstudio"})
    assert response.status_code == 200, response.text
    if path.endswith("/stream"):
        events = frames(response)
        assert events[-1]["type"] == "done"
        reply = "".join(event["text"] for event in events if event["type"] == "delta")
    else:
        assert (response.json()["brain_used"] if path == "/chat" else response.json()["provider"]) == "tli-diagnostics"
        reply = response.json()["reply"]
    assert "Checks ran on Study" in reply and "12%" in reply
    reports = diagnostics.history("local")
    assert len(reports) == 1 and reports[0]["host"]["id"] == HOST["id"]
    assert reports[0]["target"] is None and reports[0]["internet_checks"] is False
    assert measured == ["cpu"]


@pytest.mark.parametrize("path", PATHS)
def test_device_check_preserves_its_exact_target(path, client, isolated):
    probes = []
    isolated.setattr(diagnostics, "tcp", lambda address, port: probes.append((address, port)) or ("pass", "Fixture reachability"))
    response = client.post(path, json={"message": "check this device", "target_id": "remote", "brain": "lmstudio"})
    assert response.status_code == 200, response.text
    assert probes == [("192.0.2.10", 80), ("192.0.2.10", 443)]
    assert diagnostics.history("local")[0]["target"]["id"] == "remote"
