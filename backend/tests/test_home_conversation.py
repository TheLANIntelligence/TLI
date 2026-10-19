"""Conversational device operations keep identity, auth and observations intact."""
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import device_commands
import home_conversation as home
import tli_state as S


@pytest.fixture
def house(monkeypatch):
    legacy = {"id": "shelly-stable", "source_id": "lamp", "source": "shelly", "kind": "smart_device",
              "vendor": "shelly", "name": "Office Lamp", "address": "192.0.2.10", "relay": 1,
              "aliases": ["reading lamp"], "room": "Office"}
    rows = [legacy]
    calls = []
    monkeypatch.setattr(home.devices, "inventory", lambda: {"devices": deepcopy(rows)})
    monkeypatch.setattr(home, "_license", lambda: None)
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "validate_session_token", lambda token: token == "browser-session")
    monkeypatch.setattr(S, "get_session_user_id", lambda token: "alice")
    monkeypatch.setattr(S, "load_shelly_registry", lambda: [])
    def read(**kwargs):
        calls.append(("read", kwargs))
        return {"raw": {"switch:1": {"output": True, "apower": 3.5}}, "summary": "Status"}
    def change(**kwargs):
        calls.append(("command", kwargs))
        return {"raw": {"was_on": False}}
    driver = SimpleNamespace(get_status=read, turn_on=change, turn_off=change, toggle=change)
    monkeypatch.setattr(S, "shelly_driver", driver)
    monkeypatch.setattr(home.shelly_routes, "shelly_device_info_cached", lambda ip: {"ok": True})
    monkeypatch.setattr(device_commands, "_running", set())
    monkeypatch.setattr(device_commands, "_requests", {})
    request = Request({"type": "http", "method": "POST", "path": "/ai/chat", "scheme": "https",
                       "server": ("testserver", 443), "client": ("192.0.2.20", 1234),
                       "headers": [(b"host", b"testserver"), (b"origin", b"https://testserver"),
                                   (b"cookie", b"tli_session=browser-session")]})
    return SimpleNamespace(rows=rows, calls=calls, driver=driver, request=request,
                           ask=lambda text: home.answer(request, text))


@pytest.mark.parametrize("question", ["Check Office Lamp", "Could you check reading lamp?", "Is shelly-stable on?", "What is the status of lamp?"])
def test_actual_status_uses_requested_relay_and_string_summary_is_safe(house, question):
    reply = house.ask(question)
    assert "**ON**" in reply and "3.5 W" in reply and "UTC" in reply
    assert house.calls == [("read", {"ip": "192.0.2.10", "relay": 1})]


@pytest.mark.parametrize("command", ["Turn on Office Lamp", "Please turn the Office Lamp on", "Could you switch on reading lamp?", "toggle lamp"])
def test_direct_command_runs_once_then_reads_real_state(house, command):
    reply = house.ask(command)
    assert "acknowledged" in reply and "**ON**" in reply
    assert [kind for kind, _ in house.calls] == ["command", "read"]
    assert all(args == {"ip": "192.0.2.10", "relay": 1} for _, args in house.calls)


def test_acknowledgement_cannot_claim_requested_state(house):
    reply = house.ask("turn off Office Lamp")
    assert "does not match" in reply and "**ON**" in reply
    assert len(house.calls) == 2


@pytest.mark.parametrize("reading", [{"raw": {}}, {"raw": {"switch:0": {"output": False}}},
                                    {"raw": {"switch:1": {"output": "false"}}}, {"ok": False}])
def test_missing_requested_switch_is_unknown_never_off(house, reading):
    house.driver.get_status = lambda **kwargs: reading
    reply = house.ask("is Office Lamp off?")
    assert "could not be verified" in reply and "**OFF**" not in reply


def test_transport_timeout_is_not_retried_or_claimed_failed_delivery(house):
    def timeout(**kwargs):
        house.calls.append(("command", kwargs))
        raise TimeoutError("may have arrived")
    house.driver.toggle = timeout
    reply = house.ask("toggle lamp")
    assert "unconfirmed outcome" in reply and "may have reached" in reply
    assert len(house.calls) == 1


def test_failed_command_gets_no_followup_claim(house):
    house.driver.turn_on = lambda **kwargs: {"ok": False}
    reply = house.ask("turn on lamp")
    assert "did not confirm" in reply and "acknowledged" not in reply
    assert house.calls == []


def test_failed_followup_preserves_ack_but_not_observed_state(house):
    house.driver.get_status = lambda **kwargs: (_ for _ in ()).throw(TimeoutError())
    reply = house.ask("turn on lamp")
    assert "acknowledged" in reply and "could not be verified" in reply
    assert "**ON**" not in reply and len(house.calls) == 1


@pytest.mark.parametrize("text", [
    "Build an app that can turn on Office Lamp", "Write code to toggle lamp", "Explain how to turn off lamp",
    "The example command is turn on lamp", "Why is Office Lamp on?", "Is my local AI running?",
    "How much power is Office Lamp using compared with a computer?",
])
def test_prose_and_builder_requests_never_reach_device_services(house, text):
    assert house.ask(text) is None
    assert house.calls == []


@pytest.mark.parametrize("text", [
    "Check my grammar", "Please check this paragraph for clarity",
    "Could you check my code?", "Check this sentence: the lamp are on",
    "Check my essay", "Check the spelling in this email", "Check this translation",
])
def test_general_review_requests_reach_model_through_real_home_and_intent_routes(house, monkeypatch, text):
    from ai import ai_routes
    def forbidden(*args, **kwargs):
        pytest.fail("General review requests must not run device or legacy handlers")
    monkeypatch.setattr(ai_routes, "execute_action", forbidden)
    assert house.ask(text) is None
    assert ai_routes._route_action_intent(house.request, text) is None
    assert house.calls == []


@pytest.mark.parametrize("name", ["My Grammar", "Code", "This Paragraph For Clarity"])
def test_literal_device_names_preserve_status_even_when_they_sound_like_review(house, name):
    house.rows[0]["name"] = name
    assert "**ON**" in house.ask(f"Check {name}")
    assert house.calls == [("read", {"ip": "192.0.2.10", "relay": 1})]


@pytest.mark.parametrize("text", ["turn on lamp and fan", "turn on lamp or fan", "turn on lamp tomorrow", "turn on lamp; turn off fan", "turn on lamp if it is dark", "turn on lamp for 5 minutes", "turn on lamp in 5 minutes"])
def test_compound_or_conditional_requests_require_routine_review(house, text):
    assert "No device command was sent" in house.ask(text)
    assert house.calls == []


def test_exact_name_containing_clause_word_is_not_misclassified(house):
    house.rows[0]["name"] = "Lamp When Needed"
    assert "**ON**" in house.ask("Check Lamp When Needed")
    assert len(house.calls) == 1


def test_room_qualified_name_disambiguates_same_named_devices(house):
    house.rows[0]["name"] = "Lamp"
    house.rows.append({**house.rows[0], "id": "other", "source_id": "other", "room": "Bedroom", "address": "192.0.2.11"})
    assert "Multiple devices" in house.ask("check Lamp")
    assert "**ON**" in house.ask("check Lamp in the Office")
    assert house.calls == [("read", {"ip": "192.0.2.10", "relay": 1})]


def test_shared_name_overlay_keeps_existing_registered_names_and_aliases(house, monkeypatch):
    house.rows[0]["name"] = "Reading Corner"
    monkeypatch.setattr(S, "load_shelly_registry", lambda: [{"name": "Old Office Lamp", "ip": "192.0.2.10", "relay": 1, "aliases": ["favourite light"]}])
    assert "Reading Corner" in house.ask("check Old Office Lamp")
    assert "**ON**" in house.ask("check favourite light")
    assert len(house.calls) == 2


def test_lock_during_command_prevents_followup_read(house, monkeypatch):
    def change(**kwargs):
        house.calls.append(("command", kwargs))
        monkeypatch.setattr(S, "validate_session_token", lambda token: False)
        return {"raw": {"was_on": False}}
    house.driver.turn_on = change
    with pytest.raises(HTTPException) as denied:
        house.ask("turn on lamp")
    assert denied.value.status_code == 401
    assert len(house.calls) == 1


def test_ambiguity_and_missing_devices_do_not_contact_devices(house):
    house.rows.append({**house.rows[0], "id": "other", "source_id": "other", "address": "192.0.2.11"})
    assert "Multiple devices" in house.ask("turn on Office Lamp")
    assert "No device matched" in house.ask("check Missing Light")
    assert house.calls == []


def test_inventory_is_configured_only_and_does_not_probe(house):
    reply = house.ask("What smart devices do I have?")
    assert "Office Lamp" in reply and "shelly-stable" in reply and "not a live network scan" in reply
    assert house.calls == []


def test_missing_auth_and_license_block_before_device_contact(house, monkeypatch):
    monkeypatch.setattr(S, "validate_session_token", lambda token: False)
    with pytest.raises(HTTPException) as denied:
        house.ask("turn on lamp")
    assert denied.value.status_code == 401
    monkeypatch.setattr(S, "validate_session_token", lambda token: True)
    monkeypatch.setattr(home, "_license", lambda: (_ for _ in ()).throw(HTTPException(402, {"message": "license"})))
    assert "license" in house.ask("check lamp")
    assert house.calls == []


def test_invalid_explicit_bearer_does_not_fall_back_to_valid_browser(house, monkeypatch):
    import companion_auth
    monkeypatch.setattr(companion_auth, "credential_owner", lambda token: (_ for _ in ()).throw(HTTPException(401, "Invalid companion credential.")))
    house.request.scope["headers"].append((b"authorization", b"Bearer revoked"))
    with pytest.raises(HTTPException) as denied:
        house.ask("turn on lamp")
    assert denied.value.status_code == 403  # Conflicting browser/native authority.
    assert house.calls == []


def test_renamed_or_rebound_target_is_not_operated(house, monkeypatch):
    count = 0
    def inventory():
        nonlocal count
        count += 1
        rows = deepcopy(house.rows)
        if count > 1:
            rows[0]["address"] = "192.0.2.99"
        return {"devices": rows}
    monkeypatch.setattr(home.devices, "inventory", inventory)
    assert "Device details changed" in house.ask("turn on lamp")
    assert house.calls == []


def test_registered_capability_driver_supports_non_shelly_device(house, monkeypatch):
    house.rows[:] = [{**house.rows[0], "id": "homepower-stable", "source": "homepower", "source_id": "hue1", "vendor": "hue", "name": "Bedroom Light"}]
    record = {"device_id": "hue1", "vendor": "hue", "capabilities": ["switch.on", "switch.off"]}
    driver = SimpleNamespace(execute=lambda device, cap: house.calls.append(("hue", cap)) or {"ok": True},
                             get_status=lambda device: {"ok": True, "on": True})
    rt = SimpleNamespace(load_devices=lambda: [record], _find_device=lambda ident: record, _driver_registry={"hue": driver})
    monkeypatch.setattr(home.home_power, "get_runtime", lambda: rt)
    assert "acknowledged" in house.ask("Turn on Bedroom Light")
    assert house.calls == [("hue", "switch.on")]
    assert "does not advertise" in house.ask("Toggle Bedroom Light")
    assert len(house.calls) == 1


def test_command_uses_same_owner_and_lock_as_device_panel(house, monkeypatch):
    device_commands._running.add(("shelly", "192.0.2.10", 1))
    assert "Another command" in house.ask("turn on lamp")
    assert house.calls == []
