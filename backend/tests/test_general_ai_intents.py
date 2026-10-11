"""Ordinary writing and learning requests must reach the model, not tools."""
from types import SimpleNamespace

import pytest

from ai import ai_routes, intent_engine
from intelligence import devices


@pytest.fixture
def registry(monkeypatch):
    monkeypatch.setattr(devices, "with_context", lambda rows: rows)
    return [{"name": "Office Lamp", "device_id": "office-lamp", "ip": "192.0.2.10", "relay": 0}]


GENERAL_REQUESTS = [
    "Write a story about a health check",
    "Explain how to clean up Python code",
    "Write a PowerShell script to list running processes",
    "What does system health mean?",
    'Translate "turn on Office Lamp" into French',
    "Explain how to turn on Office Lamp",
    "Please explain the difference between a ping test and DNS",
    "Summarize this sentence: run diagnostics before calling support",
    "What is disk space?",
    "Help me brainstorm ways to make room for a new hobby",
    "Write an email asking someone to clean up the files",
    "Can you explain why temporary files use disk space?",
    "Tell me a story about an engineer who runs a self-test",
    "Start a story about a lonely robot",
    "Start a story about Office Lamp",
    "Enable Python logging in this code example",
    "Stop using headings in your answers",
    "Stop mentioning Office Lamp in your answers",
    "Disable animations in this CSS example",
    "Run diagnostics is the title; write an introduction",
    "If the app crashes, run diagnostics",
    "Run a health check then write a poem",
    "Explain photosynthesis to a child",
    "Write a friendly email declining an invitation",
]


@pytest.mark.parametrize("question", GENERAL_REQUESTS)
def test_general_requests_fall_through_without_action_execution(registry, monkeypatch, question):
    import home_conversation
    monkeypatch.setattr(home_conversation, "answer", lambda *args: None)
    monkeypatch.setattr(ai_routes.S, "load_shelly_registry", lambda: registry)
    monkeypatch.setattr(ai_routes, "_HAS_STATE", True)
    def forbidden(*args, **kwargs):
        pytest.fail("A general question must not execute a legacy action")
    monkeypatch.setattr(ai_routes, "execute_action", forbidden)
    assert intent_engine.detect_intent(question, registry).status == "no_match"
    assert ai_routes._route_action_intent(SimpleNamespace(base_url="http://unused/"), question) is None


@pytest.mark.parametrize("question,kind,tool", [
    ("Run diagnostics", "diagnostic", None),
    ("Please run a health check", "diagnostic", None),
    ("Could you check all systems?", "diagnostic", None),
    ("Hey, can you run a self-test, please?", "diagnostic", None),
    ("System health", "diagnostic", None),
    ("Free up disk space", "cleanup_run", None),
    ("Please clean up my computer", "cleanup_run", None),
    ("Help me free up space", "cleanup_run", None),
    ("My disk is full", "cleanup_run", None),
    ("Running processes", "tool_run", "sys_top_processes"),
    ("Please list running processes", "tool_run", "sys_top_processes"),
    ("Show me system info", "tool_run", "sys_snapshot"),
    ("Disk usage", "tool_run", "disk_overview"),
    ("Could you run a ping test?", "tool_run", "net_connectivity_diag"),
    ("Network info", "tool_run", "net_snapshot"),
])
def test_whole_commands_keep_existing_action_handlers(registry, question, kind, tool):
    result = intent_engine.detect_intent(question, registry)
    assert result.status == "matched"
    assert result.intent["type"] == kind
    assert result.intent.get("tool_id") == tool


@pytest.mark.parametrize("question", ["Turn on Missing Lamp", "Could you turn off Office?", "Toggle Missing Lamp"])
def test_explicit_unknown_or_ambiguous_device_commands_keep_clarification(registry, question):
    registry.append({"name": "Office Fan", "ip": "192.0.2.11", "relay": 0})
    result = intent_engine.detect_intent(question, registry)
    assert result.status == "failed" and result.error
    assert result.intent is None


@pytest.mark.parametrize("question", ["Start Office Lamp", "Please enable Office Lamp", "Stop Office Lamp", "Disable Office Lamp"])
def test_broad_verbs_still_recognize_registered_devices(registry, question):
    result = intent_engine.detect_intent(question, registry)
    assert result.status == "matched" and result.intent["type"] == "shelly_control"
    assert result.intent["device"]["device_id"] == "office-lamp"
