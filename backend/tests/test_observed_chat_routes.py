"""Shared observed answers through real endpoints, using only synthetic readers."""
import json
from types import SimpleNamespace

import pytest

import tli_state as S
from ai import ai_routes
from intelligence import observed_answers
from routers import chat_routes

PATHS = ["/api/ai/chat", "/api/ai/chat/stream", "/chat"]


@pytest.fixture
def isolated_observations(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(node_id="fixture-host", node_name="Study", role="standalone", host_address=None))
    manager = SimpleNamespace(ensure_running=lambda: pytest.fail("Observed answers cannot launch inference"))
    monkeypatch.setattr(ai_routes.BundledAIManager, "get", lambda: manager)
    for name in ("_route_action_intent", "_tool_answer", "_llama_post", "_llama_stream_raw"):
        monkeypatch.setattr(ai_routes, name, lambda *a, **kw: pytest.fail("No actions or models for observed answers"))
    monkeypatch.setattr(S.lm_provider, "complete", lambda **kw: pytest.fail("No LM inference"))
    monkeypatch.setattr(S.lm_provider, "health_check", lambda: pytest.fail("No LM readiness inference"))
    monkeypatch.setattr(observed_answers, "_host", lambda: {"id": "fixture-host", "name": "Study"})
    monkeypatch.setattr(observed_answers, "_memory", lambda: {"ok": True, "observed_at": 1788840000, "ram_pct": 44, "used_gb": 7, "total_gb": 16, "available_gb": 9})
    monkeypatch.setattr(observed_answers.time, "time", lambda: 1788840001)


@pytest.mark.parametrize("path", PATHS)
def test_ram_question_has_observed_receipt_and_zero_generation(path, client, isolated_observations):
    response = client.post(path, json={"message": "How much RAM am I using?", "brain": "lmstudio"} if path == "/chat" else {"message": "How much RAM am I using?"})
    assert response.status_code == 200, response.text
    if path.endswith("/stream"):
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        assert events[-1]["type"] == "done"
        data = next(e for e in events if e["type"] == "meta")
        answer = "".join(e["text"] for e in events if e["type"] == "delta")
    else:
        data = response.json()
        answer = data["reply"]
    assert data["handled_by"] == "observed_status"
    assert data["observation_context"]["topic"] == "ram"
    assert "44" in answer and "Study" in answer and "C:" not in answer
    stored = next(iter(S.load_conversations().values()))["messages"][-1]
    assert stored["observation_context"] == data["observation_context"]
    assert "memory_context" not in stored


def test_malformed_retained_receipts_are_removed_from_history_projection():
    turn = {"role": "assistant", "content": "Historical response", "observation_context": {"status": "current", "secret": "injected"},
            "input_budget": {"fit": "guaranteed", "private_prompt": "injected"}}
    result = ai_routes._public_conversation_turn(turn)
    assert "observation_context" not in result and "input_budget" not in result


@pytest.mark.parametrize("path", PATHS)
def test_selected_report_prevents_host_shortcuts_and_new_diagnostics(path, client, tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(node_id="fixture-host", node_name="Study", role="standalone", host_address=None))
    def forbidden(*a, **kw):
        pytest.fail("An attached report must not silently trigger host/device checks")
    for name in ("_memory", "_metrics", "_storage", "_network", "_printers"):
        monkeypatch.setattr(observed_answers, name, forbidden)
    for target, names in ((ai_routes, ("_route_action_intent", "_tool_answer", "diagnostic_answer")), (chat_routes, ("diagnostic_answer",))):
        for name in names:
            monkeypatch.setattr(target, name, forbidden)
    host = {"id": "fixture-host", "name": "Study"}
    monkeypatch.setattr(ai_routes.shared_context, "build", lambda *a, **kw: {"text": "Selected historical report: Workshop RAM 81%, not a fresh reading.", "categories": ["diagnostic_evidence"], "host": host})
    monkeypatch.setattr(ai_routes, "_get_tli_context", lambda: "")
    monkeypatch.setattr(ai_routes, "_should_prefer_mesh", lambda: False)
    manager = SimpleNamespace(ensure_running=lambda: True, active_preset_id="standard", base_url="http://127.0.0.1:19999")
    monkeypatch.setattr(ai_routes.BundledAIManager, "get", lambda: manager)
    calls = []
    def post(base, payload, **kw):
        calls.append(payload["messages"])
        return {"model": "fixture", "choices": [{"message": {"content": "The selected report is historical."}}]}
    def stream(url, payload, **kw):
        calls.append(payload["messages"])
        yield json.dumps({"choices": [{"delta": {"content": "The selected report is historical."}}]})
    monkeypatch.setattr(ai_routes, "_llama_post", post)
    monkeypatch.setattr(ai_routes, "_llama_stream_raw", stream)
    monkeypatch.setattr(S.lm_provider, "complete", lambda **kw: calls.append(kw["messages"]) or {"text": "The selected report is historical.", "model": "fixture"})
    monkeypatch.setattr(S.lm_provider, "health_check", lambda: True)
    response = client.post(path, json={"message": "How much RAM am I using?", "diagnostic_id": "synthetic-report", "brain": "lmstudio", "use_saved_memory": False})
    assert response.status_code == 200, response.text
    assert len(calls) == 1 and "Selected historical report: Workshop" in str(calls[0])
    assert "selected report is historical" in response.text
