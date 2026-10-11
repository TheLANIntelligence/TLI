"""Only complete device status requests reach device execution, never prose."""
from types import SimpleNamespace

import pytest
from starlette.requests import Request

import tli_state as S
from ai import ai_routes, intent_engine
from intelligence import devices
from routers import home_power, shelly_routes


@pytest.fixture
def route(monkeypatch):
    registry = [{"name": "Office Lamp", "device_id": "office-lamp", "ip": "192.0.2.10", "relay": 1},
                {"name": "Office Fan", "device_id": "office-fan", "ip": "192.0.2.11", "relay": 0}]
    calls = []
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(node_id="synthetic-host", node_name="Test host", role="standalone"))
    monkeypatch.setattr(S, "load_mesh_directory", lambda: {})
    monkeypatch.setattr(devices, "metadata", lambda: {})
    monkeypatch.setattr(devices, "with_context", lambda value: value)
    monkeypatch.setattr(S, "load_shelly_registry", lambda: registry)
    monkeypatch.setattr(home_power, "get_runtime", lambda: SimpleNamespace(load_devices=lambda: []))
    import license
    monkeypatch.setattr(license, "has_feature", lambda *args: True)
    monkeypatch.setattr(ai_routes, "_HAS_STATE", True)
    monkeypatch.setattr(ai_routes, "_log", lambda *args, **kwargs: None)
    def read(ip, relay):
        calls.append({"ip": ip, "relay": relay})
        return {"raw": {f"switch:{relay}": {"output": True, "apower": 3.5}}, "summary": "Synthetic driver status"}
    def forbidden(*args, **kwargs):
        pytest.fail("Status questions must never send a command or use the legacy loopback executor")
    monkeypatch.setattr(S, "shelly_driver", SimpleNamespace(get_status=read, turn_on=forbidden, turn_off=forbidden, toggle=forbidden))
    monkeypatch.setattr(shelly_routes, "shelly_device_info_cached", lambda ip: {"ok": True})
    monkeypatch.setattr(ai_routes, "execute_action", forbidden)
    monkeypatch.setattr(intent_engine.requests, "get", lambda *a, **kw: pytest.fail("No network in intent test"))
    monkeypatch.setattr(intent_engine.requests, "post", lambda *a, **kw: pytest.fail("No network in intent test"))
    token = S.create_session_token("alice")
    request = Request({"type": "http", "method": "POST", "path": "/api/ai/chat", "scheme": "https",
                       "server": ("tli.invalid", 443), "headers": [(b"cookie", ("tli_session=" + token).encode())]})
    def invoke(question):
        return ai_routes._route_action_intent(request, question)
    return SimpleNamespace(invoke=invoke, registry=registry, calls=calls)


@pytest.mark.parametrize("question", [
    "What is CPU usage, and does one high sample prove an application is faulty?",
    "What is CPU usage when one application is busy?",
    "What is power consumption, and does one reading establish health?",
    "Why is Office Lamp on?",
    "Explain whether Office Lamp is on.",
    "Could you explain why Office Lamp is active?",
    "Is Office Lamp on most of the time?",
    "Is Office Lamp off because a measurement failed?",
    "What is Office Lamp status in general?",
    "How much power is Office Lamp using compared with a computer?",
    "Does it matter that Office Lamp is running?",
    "The example question is Office Lamp on; explain its grammar.",
])
def test_explanatory_or_embedded_status_text_does_not_resolve_or_execute_devices(route, question):
    assert route.invoke(question) is None
    assert route.calls == []


@pytest.mark.parametrize("question", [
    "Is the Office Lamp on?", "Are the Office Lamp off?", "Is Office Lamp running?",
    "Check Office Lamp", "Status of the Office Lamp.", "Power of Office Lamp",
    "What's the Office Lamp status?", "What is the status of Office Lamp?",
    "How much power is the Office Lamp using?", "How much energy does Office Lamp use?",
    "How much power is the Office Lamp?", "How much energy does Office Lamp?",
    "Could you check the Office Lamp?", "Please, check Office Lamp.",
    "Can you please check Office Lamp?", "Please could you check Office Lamp?",
    "Is Office Lamp on, please?", "Hey, could you check Office Lamp?",
    "What’s the Office Lamp state?", "CHECK OFFICE LAMP!",
    "Is office-lamp on?", "Is 192.0.2.10 relay 1 on?",
])
def test_complete_direct_or_polite_status_requests_preserve_exact_target_and_relay(route, question):
    reply = route.invoke(question)
    assert "**Office Lamp** is **ON**" in reply and "3.5 W" in reply
    assert len(route.calls) == 1
    assert route.calls[0] == {"ip": "192.0.2.10", "relay": 1}


@pytest.mark.parametrize("question", ["Is Office on?", "Please check Office", "Could you check Desk?", "Is Desk on?"])
def test_ambiguous_actual_status_commands_remain_clarification_with_zero_execution(route, question):
    route.registry.extend([{"name": "Desk", "device_id": "left", "ip": "192.0.2.20", "relay": 0},
                           {"name": "Desk", "device_id": "right", "ip": "192.0.2.21", "relay": 1}])
    reply = route.invoke(question)
    assert "Multiple devices match" in reply
    assert route.calls == []


@pytest.mark.parametrize("question", ["Is Missing Lamp on?", "Please check Missing Lamp", "Could you check Missing Lamp?"])
def test_unknown_direct_status_request_still_asks_for_an_exact_device(route, question):
    assert "No device matched" in route.invoke(question)
    assert route.calls == []


@pytest.mark.parametrize("name", ["Start Lamp", "Stop Fan", "Lamp When Needed"])
def test_status_precedence_preserves_literal_names_instead_of_executing_action_words(route, name):
    route.registry[:] = [{"name": name, "device_id": "literal-name", "ip": "192.0.2.30", "relay": 0}]
    assert f"**{name}** is **ON**" in route.invoke(f"Please check {name}")
    assert route.calls[0] == {"ip": "192.0.2.30", "relay": 0}


def test_exact_alias_with_clause_word_stays_status_and_duplicate_alias_stays_ambiguous(route):
    route.registry[0]["aliases"] = ["Lamp When Needed"]
    assert "**Office Lamp** is **ON**" in route.invoke("How much power is Lamp When Needed?")
    route.calls.clear()
    route.registry[1]["aliases"] = ["Lamp When Needed"]
    assert "Multiple devices match" in route.invoke("How much power is Lamp When Needed?")
    assert route.calls == []


@pytest.mark.parametrize("command,action", [("power on Office Lamp", "on"), ("power off Office Lamp", "off"),
                                          ("turn on Office Lamp", "on"), ("turn off Office Lamp", "off"),
                                          ("toggle Office Lamp", "toggle")])
def test_direct_control_patterns_are_preserved(route, command, action):
    value = intent_engine.detect_intent(command, route.registry)
    assert value.status == "matched" and value.intent["type"] == "shelly_control"
    assert value.intent["action"] == action
    assert value.intent["device"]["device_id"] == "office-lamp"
    assert route.calls == []
