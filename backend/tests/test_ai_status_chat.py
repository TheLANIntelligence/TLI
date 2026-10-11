"""AI readiness questions must never be mistaken for relay commands."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import tli_state as S
from ai import ai_routes, intent_engine, status_answers
from ai.ai_manager import MODEL_PRESETS
from routers import chat_routes


@pytest.mark.parametrize("question", [
    "Is the Qwen Model running?", "Is the AI running", "Is my local AI actually ready?",
    "Check if the AI is running.", "Can you check whether Qwen is loaded?",
    "What's the status of the model?", "AI status", "Is LM Studio online?",
    "Which model are you using?", "What model is currently loaded?",
])
def test_ai_questions_bypass_device_resolution(monkeypatch, question):
    monkeypatch.setattr(intent_engine, "resolve", lambda *a: pytest.fail("Device resolution was called"))
    assert status_answers.is_status_question(question)
    assert intent_engine.detect_intent(question, []).status == "no_match"


@pytest.mark.parametrize("question", [
    "Is the AI Fan running?", "turn on AI", "turn off Qwen", "toggle Office Lamp",
    "Is the AI running and turn on my lamp?", "Why is the model running slowly?",
    "Write a script to check if the AI is running", "Is my printer running?",
    "What model should I install?", "Is the AI running in this screenshot?",
])
def test_only_whole_ai_status_questions_are_intercepted(question):
    assert not status_answers.is_status_question(question)


def test_named_device_status_and_actions_still_resolve():
    devices = [{"name": "AI Fan", "ip": "192.0.2.4", "relay": 0},
               {"name": "Qwen", "ip": "192.0.2.5", "relay": 1}]
    result = intent_engine.detect_intent("Is the AI Fan running?", devices)
    assert result.status == "matched"
    assert result.intent["type"] == "shelly_status"
    assert result.intent["device"]["ip"] == "192.0.2.4"
    result = intent_engine.detect_intent("turn off Qwen", devices)
    assert result.status == "matched"
    assert result.intent["type"] == "shelly_control"
    assert result.intent["device"]["relay"] == 1


@pytest.fixture
def status_chat(app, tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(S, "_CONV_KEY", b"c" * 32)
    monkeypatch.setattr(S, "_MEM_KEY", b"m" * 32)
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    cfg = SimpleNamespace(role="standalone", host_address="")
    monkeypatch.setattr(S, "load_node_config", lambda: cfg)
    monkeypatch.setattr(chat_routes, "choose_model", lambda *a: {"id": "fixture-lm"})

    def forbidden(*args, **kwargs):
        pytest.fail("Status must not generate, start, switch, resolve a device, or proxy to mesh")

    manager = SimpleNamespace(active_preset_id="standard", _transition=False,
                              cfg=SimpleNamespace(model_path=Path("fixture.gguf")),
                              is_healthy=lambda: True, ensure_running=forbidden, start=forbidden,
                              generation=forbidden, switch_model=forbidden)
    monkeypatch.setattr(ai_routes.BundledAIManager, "get", lambda: manager)
    monkeypatch.setattr(ai_routes, "_route_action_intent", forbidden)
    monkeypatch.setattr(ai_routes, "_tool_answer", forbidden)
    monkeypatch.setattr(ai_routes, "_llama_post", forbidden)
    monkeypatch.setattr(ai_routes, "_llama_stream_raw", forbidden)
    monkeypatch.setattr(ai_routes, "_find_mesh_ai_peer", forbidden)
    monkeypatch.setattr(chat_routes, "proxy_chat_to_host", forbidden)
    monkeypatch.setattr(S, "load_shelly_registry", forbidden)
    provider = SimpleNamespace(_report_cache={"ts": 0, "report": None}, report_ttl_seconds=15,
                               health_check=forbidden, health_report=forbidden, complete=forbidden)
    monkeypatch.setattr(S, "lm_provider", provider)
    client = TestClient(app, base_url="https://192.0.2.20:8000")
    client.headers["Cookie"] = "tli_session=" + S.create_session_token("alice")
    return SimpleNamespace(client=client, manager=manager, provider=provider, cfg=cfg)


def submit(fixture, route, message="Is the Qwen Model running?", **extra):
    if route == "stream_get":
        return fixture.client.get("/api/ai/chat/stream", params={"message": message, **extra})
    path = {"bundled": "/api/ai/chat", "stream": "/api/ai/chat/stream", "legacy": "/chat"}[route]
    return fixture.client.post(path, json={"message": message, **extra})


def reply(response, route):
    assert response.status_code == 200, response.text
    if route.startswith("stream"):
        frames = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        assert [frame["type"] for frame in frames] == ["meta", "delta", "done"]
        assert frames[0]["handled_by"] == "ai_status"
        assert frames[0]["provider"] == "tli-status"
        return frames[1]["text"]
    assert response.json()["handled_by"] == "ai_status"
    return response.json()["reply"]


@pytest.mark.parametrize("route", ["bundled", "stream", "stream_get", "legacy"])
@pytest.mark.parametrize("healthy", [True, False])
def test_status_routes_use_actual_health_and_save_truthful_turns(status_chat, route, healthy):
    status_chat.manager.is_healthy = lambda: healthy
    text = reply(submit(status_chat, route), route)
    assert MODEL_PRESETS["standard"]["name"] in text
    assert ("runtime health check passed" in text) == healthy
    assert ("not currently confirmed running" in text) == (not healthy)
    conv = next(iter(S.load_conversations().values()))
    assert conv["user_id"] == "alice"
    assert conv["messages"][-1]["content"] == text
    assert conv["messages"][-1]["provider"] == "tli-status"


def test_switch_in_progress_does_not_probe_or_claim_running(status_chat):
    status_chat.manager._transition = True
    status_chat.manager.is_healthy = lambda: pytest.fail("Transition status probed a runtime")
    assert "changing models" in reply(submit(status_chat, "bundled"), "bundled")


def test_selection_change_during_probe_invalidates_result(status_chat):
    def health():
        status_chat.manager.active_preset_id = "lite"
        return True
    status_chat.manager.is_healthy = health
    text = reply(submit(status_chat, "stream"), "stream")
    assert "changed during this check" in text
    assert "health check passed" not in text


def test_failed_status_probe_is_unknown_without_llm_fallback(status_chat):
    def health():
        raise RuntimeError("synthetic probe failure")
    status_chat.manager.is_healthy = health
    assert "couldn't verify" in reply(submit(status_chat, "bundled"), "bundled")


@pytest.mark.parametrize("state", ["ready", "unavailable", "stale", "missing"])
def test_lm_status_uses_only_existing_recent_evidence(status_chat, monkeypatch, state):
    monkeypatch.setattr(status_answers.time, "time", lambda: 100)
    if state != "missing":
        status_chat.provider._report_cache = {"ts": 10 if state == "stale" else 99,
            "report": {"ok": state != "unavailable", "chat_ok": state != "unavailable"}}
    text = reply(submit(status_chat, "legacy", "Is the AI running?", brain="lmstudio"), "legacy")
    assert "fixture-lm" in text
    if state == "ready":
        assert "responded to its latest readiness check" in text
        assert "does not confirm this specific model is loaded" in text
    elif state == "unavailable":
        assert "not confirmed ready" in text
    else:
        assert "readiness is unknown" in text


def test_mesh_route_does_not_claim_local_ai_is_remote_status(status_chat):
    status_chat.cfg.role = "member"
    status_chat.cfg.host_address = "192.0.2.40"
    text = reply(submit(status_chat, "legacy", "Is the AI running?", brain="lmstudio"), "legacy")
    assert "mesh host" in text and "unknown here" in text


def test_unreadable_provider_configuration_does_not_guess_or_generate(status_chat, monkeypatch):
    def unavailable():
        raise OSError("Synthetic configuration failure")
    monkeypatch.setattr(S, "load_node_config", unavailable)
    text = reply(submit(status_chat, "legacy"), "legacy")
    assert "couldn't verify the configured AI provider" in text


@pytest.mark.parametrize("route", ["bundled", "stream", "stream_get", "legacy"])
def test_status_routes_still_require_authentication(status_chat, route):
    status_chat.client.headers.pop("Cookie", None)
    # Bundled chat has an existing anonymous mode. An explicit invalid
    # credential must never fall back to that mode on any chat route.
    status_chat.client.headers["Authorization"] = "Bearer invalid-status-credential"
    assert submit(status_chat, route).status_code == 401
    assert S.load_conversations() == {}


def test_legacy_status_still_requires_a_session(status_chat):
    status_chat.client.headers.pop("Cookie", None)
    assert submit(status_chat, "legacy").status_code == 401
    assert S.load_conversations() == {}
