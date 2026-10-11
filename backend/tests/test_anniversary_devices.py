import pytest
from device_resolution import resolve
from ai.intent_engine import detect_intent


def device(name, ip="192.168.1.10", relay=0, **kw):
    return {"name": name, "ip": ip, "relay": relay, **kw}


@pytest.mark.parametrize("query, status, name", [
    ("Office", "ambiguous", None),
    ("office lamp", "resolved", "Office Lamp"),
    ("fan", "resolved", "Office Fan"),
    ("offic lmp", "not_found", None),
    ("desk light", "resolved", "Office Lamp"),
    ("lamp-id", "resolved", "Office Lamp"),
])
def test_matching(query, status, name):
    result = resolve(query, [device("Office Lamp", aliases=["desk light"], device_id="lamp-id"),
                             device("Office Fan", "192.168.1.11")])
    assert result.status == status
    assert (result.device or {}).get("name") == name


def test_exact_names_beat_partial_and_alias_matches():
    target = device("Office")
    assert resolve("office", [device("Office Lamp", aliases=["office"]), target]).device is target


def test_duplicate_names_and_aliases_are_ambiguous():
    devices = [device("Lamp", aliases=["desk"]), device("Lamp", "192.168.1.11", aliases=["desk"])]
    for query in ("Lamp", "desk"):
        result = resolve(query, devices)
        assert result.status == "ambiguous"
        assert len(result.candidates) == 2


def test_shared_address_requires_relay_or_identifier():
    devices = [device("Left", relay=0), device("Right", relay=1, device_id="right")]
    assert resolve("192.168.1.10", devices).status == "ambiguous"
    assert resolve("192.168.1.10 relay 1", devices).device == devices[1]
    assert resolve("right", devices).device == devices[1]


@pytest.mark.parametrize("query", ["office", "offic lmp"])
def test_ambiguous_and_fuzzy_chat_commands_never_fall_through(query):
    result = detect_intent(f"turn off {query}", [device("Office Lamp"), device("Office Fan")])
    assert result.status == "failed"
    assert result.intent is None
    assert "Candidates" in result.error


def test_existing_alias_and_empty_names():
    assert resolve("charger plug", [device("charger")]).status == "resolved"
    assert resolve("anything", [device("")]).status == "not_found"


def test_chat_execution_uses_selected_relay_and_does_not_invent_current_state(monkeypatch):
    from ai import intent_engine
    from types import SimpleNamespace
    calls = []
    def post(url, **kw):
        calls.append(kw)
        return SimpleNamespace(ok=True, json=lambda: {"raw": {"was_on": False}, "summary": "status loaded"})
    monkeypatch.setattr(intent_engine.requests, "post", post)
    result = intent_engine.execute_action("http://localhost:8000", {
        "type": "shelly_control", "action": "on", "device": device("Right", relay=1)})
    assert calls[0]["json"]["relay"] == 1
    assert result.success is True
    assert "not been verified" in result.message
