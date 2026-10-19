"""Real browser/Companion admission, captured checks and synthetic device effects."""
import copy
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

import companion_auth as companion
import device_commands
import home_conversation as home
import tli_state as S
from ai import ai_routes as ai


MESSAGES = ["list smart devices", "check Private Lamp", "turn on Private Lamp"]


@pytest.fixture
def house(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "_active_sessions", {})
    pin = {"enabled": True}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(pin))
    monkeypatch.setattr(home, "_license", lambda: None)
    rows = [{"id": "lamp-id", "source_id": "lamp", "source": "shelly", "kind": "smart_device",
             "vendor": "shelly", "name": "Private Lamp", "address": "192.0.2.10", "relay": 1,
             "aliases": ["reading light"], "room": "Office"}]
    inventory = Mock(side_effect=lambda: {"devices": copy.deepcopy(rows)})
    legacy = Mock(return_value=[])
    monkeypatch.setattr(home.devices, "inventory", inventory)
    monkeypatch.setattr(S, "load_shelly_registry", legacy)
    runtime = SimpleNamespace(load_devices=Mock(return_value=[]))
    monkeypatch.setattr(home.home_power, "get_runtime", lambda: runtime)
    driver = SimpleNamespace(get_status=Mock(return_value={"raw": {"switch:1": {"output": True}}}),
        turn_on=Mock(return_value={"raw": {"was_on": False}}),
        turn_off=Mock(return_value={"raw": {"was_on": True}}),
        toggle=Mock(return_value={"raw": {"was_on": False}}))
    monkeypatch.setattr(S, "shelly_driver", driver)
    info = Mock(return_value={"ok": True})
    monkeypatch.setattr(home.shelly_routes, "shelly_device_info_cached", info)
    monkeypatch.setattr(device_commands, "_requests", {})
    monkeypatch.setattr(device_commands, "_running", set())
    monkeypatch.setattr(ai, "_log", lambda *a, **k: None)
    app = FastAPI()
    @app.post("/answer")
    def answer(request: Request, message: str):
        return {"reply": home.answer(request, message)}
    @app.post("/intent")
    def intent(request: Request, message: str):
        return {"reply": ai._route_action_intent(request, message)}
    clients = []
    def connect(mode="browser"):
        pin["enabled"] = mode != "open-local"
        origin = "http://localhost:8000" if mode == "open-local" else "https://tli.invalid"
        client = TestClient(app, base_url=origin, client=("127.0.0.1" if mode == "open-local" else "192.0.2.20", 1234))
        clients.append(client)
        if mode == "companion":
            invite, _ = companion.create_pairing("alice", origin, "synthetic-fingerprint")
            paired = companion.redeem_pairing(invite, origin, "synthetic-fingerprint", "Test phone", "synthetic")
            client.headers["Authorization"] = "Bearer " + paired["credential"]
            revoke = lambda: companion.revoke_device("alice", paired["device_id"])
        elif mode == "browser":
            token = S.create_session_token("alice")
            client.headers.update({"Cookie": "tli_session=" + token, "Origin": origin})
            revoke = lambda: S.revoke_session_token(token)
        else:
            client.headers["Origin"] = origin
            revoke = lambda: pin.update(enabled=True)
        return client, revoke
    yield SimpleNamespace(app=app, connect=connect, inventory=inventory, legacy=legacy, rows=rows,
                          pin=pin, driver=driver, info=info, runtime=runtime)
    for client in clients: client.close()


def submit(client, message="turn on Private Lamp", route="/answer"):
    return client.post(route, params={"message": message})


@pytest.mark.parametrize("message", MESSAGES)
@pytest.mark.parametrize("mode", ["open-local", "browser", "companion"])
def test_supported_clients_keep_named_inventory_status_and_control(house, mode, message):
    client, _ = house.connect(mode)
    response = submit(client, message)
    assert response.status_code == 200, response.text
    assert "Private Lamp" in response.json()["reply"]
    assert house.driver.turn_on.call_count == int(message.startswith("turn"))
    assert house.driver.get_status.call_count == int(not message.startswith("list"))


@pytest.mark.parametrize("message", MESSAGES)
@pytest.mark.parametrize("route", ["/answer", "/intent"])
@pytest.mark.parametrize("mode", ["anonymous", "pin-off-lan", "stale-cookie", "foreign-origin", "missing-origin",
    "proxy", "peer", "remote-http", "bearer-cookie", "bearer-origin", "bearer-fetch", "bearer-proxy",
    "bearer-peer", "bearer-duplicate", "bearer-http", "bearer-bad-host", "bearer-revoked", "host-token"])
def test_denial_precedes_registry_or_driver_and_never_falls_back(house, mode, route, message):
    native = mode.startswith("bearer-") or mode == "host-token"
    client, revoke = house.connect("companion" if native else "browser")
    if mode == "anonymous": del client.headers["Cookie"]
    if mode == "pin-off-lan": house.pin["enabled"] = False
    if mode == "stale-cookie": revoke(); house.pin["enabled"] = False
    if mode == "foreign-origin": client.headers["Origin"] = "https://foreign.invalid"
    if mode == "missing-origin": del client.headers["Origin"]
    if mode in {"proxy", "bearer-proxy"}: client.headers["X-Forwarded-For"] = "127.0.0.1"
    if mode in {"peer", "bearer-peer"}: client.headers["X-TLI-Peer-Signature"] = "synthetic"
    if mode in {"remote-http", "bearer-http"}:
        client.base_url = "http://tli.invalid"
        if not native: client.headers["Origin"] = "http://tli.invalid"
    if mode == "bearer-cookie": client.headers["Cookie"] = "tli_session=" + S.create_session_token("alice")
    if mode == "bearer-origin": client.headers["Origin"] = "https://tli.invalid"
    if mode == "bearer-fetch": client.headers["Sec-Fetch-Site"] = "same-origin"
    if mode == "bearer-duplicate": client.headers.update([("Authorization", client.headers["Authorization"])] * 2)
    if mode == "bearer-bad-host": client.headers["Host"] = "tli.invalid:99999"
    if mode == "bearer-revoked": revoke()
    if mode == "host-token": client.headers["Authorization"] = "Bearer tlih_not-a-home-grant"
    response = submit(client, message, route)
    assert response.status_code in (401, 403), response.text
    house.inventory.assert_not_called(); house.legacy.assert_not_called()
    for mock in vars(house.driver).values(): mock.assert_not_called()
    assert "Private Lamp" not in response.text and device_commands._requests == {}


@pytest.mark.parametrize("mode", ["open-local", "browser", "companion"])
@pytest.mark.parametrize("stage", ["legacy", "runtime", "inventory", "resolve", "command-lock", "command", "followup", "format", "failure"])
def test_original_authority_survives_private_reads_lock_waits_effects_and_errors(house, monkeypatch, mode, stage):
    client, revoke = house.connect(mode)
    if stage == "legacy": house.legacy.side_effect = lambda: (revoke(), [])[1]
    elif stage == "runtime": house.runtime.load_devices.side_effect = lambda: (revoke(), [])[1]
    elif stage == "inventory": house.inventory.side_effect = lambda: (revoke(), {"devices": copy.deepcopy(house.rows)})[1]
    elif stage == "resolve":
        original = home.resolve
        monkeypatch.setattr(home, "resolve", lambda *a: (original(*a), revoke())[0])
    elif stage == "command-lock":
        original = home.shelly_routes.run_command
        def wait(*args):
            revoke()
            return original(*args)
        monkeypatch.setattr(home.shelly_routes, "run_command", wait)
    elif stage == "command": house.driver.turn_on.side_effect = lambda **k: (revoke(), {"raw": {"was_on": False}})[1]
    elif stage == "followup": house.driver.get_status.side_effect = lambda **k: (revoke(), {"raw": {"switch:1": {"output": True}}})[1]
    elif stage == "format":
        original = home._status_text
        monkeypatch.setattr(home, "_status_text", lambda *a: (original(*a), revoke())[0])
    else:
        def fail(**kwargs):
            revoke(); raise TimeoutError("Private device details")
        house.driver.turn_on.side_effect = fail
    response = submit(client)
    assert response.status_code == 401, response.text
    assert "Private Lamp" not in response.text and "Private device details" not in response.text
    assert house.driver.turn_on.call_count == int(stage in {"command", "followup", "format", "failure"})
    assert house.driver.get_status.call_count == int(stage in {"followup", "format"})
    assert not device_commands._running
    if stage in {"command", "followup", "format", "failure"}:
        retained = list(device_commands._requests.values())
        assert len(retained) == 1
        assert retained[0]["result"]["outcome"] == ("unknown" if stage == "failure" else "accepted")


@pytest.mark.parametrize("mode", ["browser", "companion"])
@pytest.mark.parametrize("stage", ["lookup", "command", "status"])
def test_homepower_adapter_receives_the_same_captured_authority(house, monkeypatch, mode, stage):
    client, revoke = house.connect(mode)
    house.rows[0].update(source="homepower", vendor="hue", source_id="hue1")
    record = {"device_id": "hue1", "vendor": "hue", "capabilities": ["switch.on"]}
    execute = Mock(return_value={"ok": True})
    status = Mock(return_value={"ok": True, "on": True})
    def lookup(_id):
        if stage == "lookup": revoke()
        return record
    house.runtime.load_devices.return_value = [record]
    house.runtime._find_device = lookup
    house.runtime._driver_registry = {"hue": SimpleNamespace(execute=execute, get_status=status)}
    if stage == "command": execute.side_effect = lambda *a: (revoke(), {"ok": True})[1]
    if stage == "status": status.side_effect = lambda *a: (revoke(), {"ok": True, "on": True})[1]
    assert submit(client).status_code == 401
    assert execute.call_count == int(stage != "lookup")
    assert status.call_count == int(stage == "status")


@pytest.mark.parametrize("message", ["Help me write a story", "Explain how to turn on a lamp", "Build an app", "Why is Office Lamp on?"])
def test_ordinary_conversation_does_not_enter_home_authority_or_inventory(house, monkeypatch, message):
    monkeypatch.setattr(home, "_access", Mock(side_effect=AssertionError("No home authorization for prose")))
    client, revoke = house.connect(); revoke()
    assert submit(client, message).json() == {"reply": None}
    house.inventory.assert_not_called(); house.legacy.assert_not_called()


@pytest.mark.parametrize("credential", ["revoked", "malformed", "host-start"])
def test_explicit_native_credential_never_downgrades_to_pin_off_local(house, credential):
    client, revoke = house.connect("companion")
    house.pin["enabled"] = False
    if credential == "revoked": revoke()
    elif credential == "malformed": client.headers["Authorization"] = "invalid"
    else: client.headers["Authorization"] = "Bearer tlih_not-a-home-grant"
    assert submit(client).status_code == 401
    house.inventory.assert_not_called(); house.legacy.assert_not_called()
    house.driver.turn_on.assert_not_called()


@pytest.fixture
def chat(house, monkeypatch):
    forbidden = Mock(side_effect=AssertionError("No model, process or network allowed"))
    monkeypatch.setattr(ai, "_tool_answer", forbidden)
    monkeypatch.setattr(ai, "_llama_post", forbidden)
    monkeypatch.setattr(ai, "_llama_stream_raw", forbidden)
    monkeypatch.setattr(ai.BundledAIManager, "get", lambda: SimpleNamespace(active_preset_id=None))
    for module in (ai.case_context, ai.documents, ai.notebook):
        monkeypatch.setattr(module, "prepare", lambda *a, **k: None)
    monkeypatch.setattr(ai.chat_continuity, "recorded_outcome", lambda *a, **k: None)
    monkeypatch.setattr(ai.chat_continuity, "source_refs", lambda _id: {})
    monkeypatch.setattr(ai, "diagnostic_answer", lambda *a: None)
    monkeypatch.setattr(ai, "ai_status_answer", lambda *a: None)
    monkeypatch.setattr(ai, "storage_question", lambda *a: False)
    monkeypatch.setattr(ai.observed_answers, "answer", lambda *a, **k: None)
    monkeypatch.setattr(ai, "_get_or_create_conv", lambda *a, **k: "private-conversation")
    stored = {"private-conversation": {"id": "private-conversation", "user_id": "alice", "messages": []}}
    writes = []
    monkeypatch.setattr(S, "load_conversations", lambda: copy.deepcopy(stored))
    def persist(value, *, check=None):
        if check: check()
        saved = json.loads(json.dumps(value))
        writes.append(saved); stored.clear(); stored.update(saved)
    monkeypatch.setattr(S, "save_conversations", persist)
    house.app.include_router(ai.router)
    yield SimpleNamespace(house=house, writes=writes, stored=stored, persist=persist)
    forbidden.assert_not_called()


def frames(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


@pytest.mark.parametrize("mode", ["browser", "companion"])
@pytest.mark.parametrize("stream", [False, True])
def test_full_chat_persists_plain_named_reply_and_preserves_response_contract(chat, mode, stream):
    client, _ = chat.house.connect(mode)
    response = client.post("/api/ai/chat" + ("/stream" if stream else ""), json={"message": "turn on Private Lamp"})
    assert response.status_code == 200, response.text
    assert "acknowledged" in response.text and "ON" in response.text
    if stream: assert [f["type"] for f in frames(response)] == ["meta", "delta", "done"]
    assert len(chat.writes) == 2
    assert all(type(turn["content"]) is str and "authorize" not in turn for turn in chat.stored["private-conversation"]["messages"])


@pytest.mark.parametrize("mode", ["browser", "companion"])
@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("stage,writes", [("driver", 0), ("trace", 0), ("save-read", 0), ("save-user", 1), ("references", 2)])
def test_full_chat_withholds_private_result_after_revocation_and_never_replays(chat, monkeypatch, mode, stream, stage, writes):
    client, revoke = chat.house.connect(mode)
    if stage == "driver": chat.house.driver.turn_on.side_effect = lambda **k: (revoke(), {"raw": {"was_on": False}})[1]
    elif stage == "trace": monkeypatch.setattr(ai, "_log", lambda *a, **k: revoke())
    elif stage == "save-read": monkeypatch.setattr(S, "load_conversations", lambda: (revoke(), copy.deepcopy(chat.stored))[1])
    elif stage == "save-user":
        def persist(value, *, check=None):
            chat.persist(value, check=check); revoke()
        monkeypatch.setattr(S, "save_conversations", persist)
    else: monkeypatch.setattr(ai.chat_continuity, "source_refs", lambda _id: (revoke(), {})[1])
    response = client.post("/api/ai/chat" + ("/stream" if stream else ""), json={"message": "turn on Private Lamp"})
    if stream:
        assert response.status_code == 200
        events = frames(response)
        assert len(events) == 1 and events[0]["type"] == "error" and events[0]["status_code"] == 401
    else: assert response.status_code == 401, response.text
    assert "Private Lamp" not in response.text and "acknowledged" not in response.text
    assert len(chat.writes) == writes
    chat.house.driver.turn_on.assert_called_once()


@pytest.mark.parametrize("mode", ["browser", "companion"])
@pytest.mark.parametrize("after", ["meta", "delta"])
def test_original_credential_rechecked_between_sse_frames(chat, mode, after):
    client, revoke = chat.house.connect(mode)
    request = Request({"type": "http", "method": "POST", "scheme": "https", "path": "/api/ai/chat/stream",
        "headers": [(b"host", b"tli.invalid"), *((key.lower(), value) for key, value in client.headers.raw)], "client": ("192.0.2.20", 1234),
        "server": ("tli.invalid", 443)})
    stream = ai._stream_response(request, "turn on Private Lamp", "private-conversation", None, 300, 0.2)
    assert json.loads(next(stream)[6:])["type"] == "meta"
    if after == "delta": assert "acknowledged" in next(stream)
    revoke()
    remaining = list(stream)
    assert len(remaining) == 1 and json.loads(remaining[0][6:])["type"] == "error"
    assert "Private Lamp" not in remaining[0]
    assert len(chat.writes) == 2
    chat.house.driver.turn_on.assert_called_once()
