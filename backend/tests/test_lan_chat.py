"""LAN chat continuity over synthetic inference; no model or household devices.

The transport tests exercise trust and wire framing separately. These checks
retain real request authentication, context preparation and conversation storage
while replacing only the selected inference service and unrelated fast paths.
"""
import copy
import json
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect

import tli_state as S
from ai import ai_routes
from intelligence import context, memory


POSTS = ("/api/ai/chat", "/api/ai/chat/stream")
PEER = {"id": "peer-b", "name": "Gaming PC"}
CHOICE = {"peer_id": PEER["id"], "trust_revision": "a" * 64,
          "resource_id": "f" * 64, "resource_revision": "b" * 64}
QUESTION = "Which printer paper?"
REPLY = "Use the saved printer paper setting."
_REAL_ACTION_ROUTE = ai_routes._route_action_intent


def forbidden(*args, **kwargs):
    pytest.fail("LAN inference must not start a local model, legacy mesh route or another provider")


@pytest.fixture
def lan_chat(app, tmp_path, monkeypatch):
    import lan_inference

    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(S, "_CONV_KEY", b"c" * 32)
    monkeypatch.setattr(S, "_MEM_KEY", b"m" * 32)
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(
        node_id="host-a", node_name="Study", role="standalone", host_address=""))
    monkeypatch.setattr(context.devices, "node", lambda: {"id": "host-a", "name": "Study", "role": "standalone"})
    monkeypatch.setattr(ai_routes, "_build_system_prompt", lambda **kw: "Primary TLI instructions from Study.")
    monkeypatch.setattr(ai_routes, "diagnostic_answer", lambda *a: None)
    monkeypatch.setattr(ai_routes, "ai_status_answer", lambda *a: None)
    monkeypatch.setattr(ai_routes.observed_answers, "answer", lambda *a, **kw: None)
    monkeypatch.setattr(ai_routes, "_route_action_intent", lambda *a: None)
    monkeypatch.setattr(ai_routes, "_tool_answer", lambda *a: None)
    monkeypatch.setattr(ai_routes, "_should_prefer_mesh", forbidden)
    monkeypatch.setattr(ai_routes, "_find_mesh_ai_peer", forbidden)
    monkeypatch.setattr(ai_routes, "_proxy_chat_to_mesh_peer", forbidden)
    monkeypatch.setattr(ai_routes, "_stream_via_mesh_peer", forbidden)
    monkeypatch.setattr(ai_routes, "_llama_post", forbidden)
    monkeypatch.setattr(ai_routes, "_llama_stream_raw", forbidden)
    monkeypatch.setattr(S, "lm_provider", SimpleNamespace(health_check=forbidden, complete=forbidden))
    manager = SimpleNamespace(ensure_running=forbidden, active_preset_id="fixture-local-model",
                              base_url="http://127.0.0.1:9999")
    monkeypatch.setattr(ai_routes.BundledAIManager, "get", lambda: manager)
    calls, selections = [], []

    def selection(value):
        value = value.model_dump() if hasattr(value, "model_dump") else value
        selections.append(copy.deepcopy(value))
        assert value == CHOICE
        return {**value, "peer": dict(PEER)}

    def stream(selected, messages, *, max_tokens, temperature, check):
        check()
        calls.append({"selection": copy.deepcopy(selected), "messages": copy.deepcopy(messages),
                      "max_tokens": max_tokens, "temperature": temperature})
        yield {"type": "meta", "model": "fixture-remote-model", "provider": "lmstudio", "peer": dict(PEER)}
        yield {"type": "delta", "text": "Use the saved "}
        check()
        yield {"type": "delta", "text": "printer paper setting."}
        check()
        yield {"type": "done"}

    monkeypatch.setattr(lan_inference, "selection", selection)
    monkeypatch.setattr(lan_inference, "stream", stream)
    token = S.create_session_token("alice")
    client = TestClient(app, base_url="https://192.0.2.20:8000")
    client.headers["Cookie"] = "tli_session=" + token
    return SimpleNamespace(client=client, calls=calls, selections=selections, service=lan_inference,
                           manager=manager, token=token)


def seed_conversation(owner="alice"):
    history = [{"role": "user", "content": "Let's discuss the printer paper."},
               {"role": "assistant", "content": "We were checking the second paper tray."}]
    S.save_conversations({"continuity": {"id": "continuity", "user_id": owner,
                                        "title": "Printer", "messages": history}})
    return history


def submit(fixture, path, **body):
    return fixture.client.post(path, json={"message": QUESTION, "conversation_id": "continuity",
                                          "lan_inference": CHOICE, **body})


def frames(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


def completed(response, path):
    assert response.status_code == 200, response.text
    if not path.endswith("/stream"):
        return response.json()
    events = frames(response)
    assert events[-1]["type"] == "done", events
    result = {}
    for event in events:
        if event["type"] == "meta":
            result.update(event)
    result["reply"] = "".join(event["text"] for event in events if event["type"] == "delta")
    return result


def supplied_notes(messages):
    return [note for message in messages if message["role"] == "system"
            for line in message["content"].splitlines() if line.startswith("memory: ")
            for note in json.loads(line.removeprefix("memory: "))]


@pytest.mark.parametrize("path", POSTS)
def test_remote_answer_preserves_owner_context_receipts_and_host(lan_chat, path):
    prior = seed_conversation()
    owned = memory.save_fact("alice", "Printer paper is A4.", title="Printer paper")
    memory.save_fact("bob", "Bob's printer paper secret.")
    result = completed(submit(lan_chat, path, user_id="bob", max_tokens=512, temperature=0.3), path)
    assert len(lan_chat.calls) == 1
    sent = lan_chat.calls[0]
    assert sent["max_tokens"] == 512 and sent["temperature"] == 0.3
    messages = sent["messages"]
    assert messages[0]["content"] == "Primary TLI instructions from Study."
    assert messages[-1] == {"role": "user", "content": QUESTION}
    assert [message for message in messages if message["role"] != "system"][:-1] == prior
    assert [note["id"] for note in supplied_notes(messages)] == [owned["id"]]
    assert "Bob" not in json.dumps(messages)
    assert result["session_id"] == result["conversation_id"] == "continuity"
    assert result["reply"] == REPLY and result["provider"] == "lan"
    assert result["handled_by"] == "lan_inference" and result["model"] == "fixture-remote-model"
    assert result["inference_host"] == PEER
    saved = S.load_conversations()["continuity"]
    assert saved["user_id"] == "alice" and saved["messages"][:2] == prior
    assert len(saved["messages"]) == 4
    answer = saved["messages"][-1]
    assert answer["content"] == REPLY and answer["provider"] == "lan"
    assert answer["model"] == "fixture-remote-model" and answer["host"]["id"] == "host-a"
    assert answer["inference_host"] == PEER
    reopened = lan_chat.client.get("/api/ai/conversations/continuity").json()["messages"][-1]
    assert reopened["inference_host"] == PEER
    for key in ("memory_context", "conversation_context"):
        assert answer[key] == result[key] == reopened[key]
    assert reopened["source_ref"] == result["source_ref"]


@pytest.mark.parametrize("path", POSTS)
@pytest.mark.parametrize("saved_memory,history", [(False, True), (True, False), (False, False)])
def test_context_choices_are_applied_on_requester(lan_chat, monkeypatch, path, saved_memory, history):
    prior = seed_conversation()
    memory.save_fact("alice", "Printer paper is A4.", title="Printer paper")
    if not saved_memory:
        monkeypatch.setattr(S, "load_memory", lambda *a, **kw: pytest.fail("Disabled saved memory was read"))
    result = completed(submit(lan_chat, path, use_saved_memory=saved_memory, use_conversation_history=history), path)
    assert len(lan_chat.calls) == 1
    messages = lan_chat.calls[0]["messages"]
    assert bool(supplied_notes(messages)) == saved_memory
    assert [message for message in messages if message["role"] != "system"][:-1] == (prior if history else [])
    if not saved_memory:
        assert result["memory_context"]["status"] == "disabled"
    if not history:
        assert result["conversation_context"]["status"] == "disabled"


@pytest.mark.parametrize("path", POSTS)
def test_second_remote_turn_uses_first_completed_exchange(lan_chat, path):
    first = completed(submit(lan_chat, path, conversation_id=None), path)
    ident = first["conversation_id"]
    second = completed(submit(lan_chat, path, conversation_id=ident, message="Explain that paper setting."), path)
    assert second["conversation_id"] == ident and len(lan_chat.calls) == 2
    messages = [message for message in lan_chat.calls[1]["messages"] if message["role"] != "system"]
    assert messages == [{"role": "user", "content": QUESTION}, {"role": "assistant", "content": REPLY},
                        {"role": "user", "content": "Explain that paper setting."}]
    assert len(S.load_conversations()[ident]["messages"]) == 4


@pytest.mark.parametrize("path", POSTS)
def test_other_owner_conversation_never_reaches_remote(lan_chat, path):
    prior = seed_conversation(owner="bob")
    response = submit(lan_chat, path)
    assert response.status_code == 404
    assert not lan_chat.calls and S.load_conversations()["continuity"]["messages"] == prior


@pytest.mark.parametrize("path", POSTS)
@pytest.mark.parametrize("failure", ["interrupted", "eof", "expired_session", "revoked_peer"])
def test_partial_or_revoked_remote_answer_has_no_completion_or_retry(lan_chat, monkeypatch, path, failure):
    prior = seed_conversation()

    def failed_stream(selected, messages, *, max_tokens, temperature, check):
        check()
        lan_chat.calls.append(copy.deepcopy(messages))
        yield {"type": "meta", "model": "fixture-remote-model", "provider": "lmstudio", "peer": dict(PEER)}
        yield {"type": "delta", "text": "Incomplete answer"}
        if failure == "eof":
            return
        if failure == "expired_session":
            S.revoke_session_token(lan_chat.token)
            check()
            pytest.fail("Expired requester was allowed to finish LAN inference")
        code = 403 if failure == "revoked_peer" else 502
        raise HTTPException(code, "Selected peer revoked" if failure == "revoked_peer" else "LAN response interrupted")

    monkeypatch.setattr(lan_chat.service, "stream", failed_stream)
    response = submit(lan_chat, path)
    if path.endswith("/stream"):
        events = frames(response)
        assert events[-1]["type"] == "error"
        assert not any(event["type"] == "done" or "source_ref" in event or "memory_context" in event for event in events)
    else:
        assert response.status_code in (401, 403, 502), response.text
    assert len(lan_chat.calls) == 1
    appended = S.load_conversations()["continuity"]["messages"][len(prior):]
    assert not any(message["role"] == "assistant" for message in appended)


@pytest.mark.parametrize("path", POSTS)
@pytest.mark.parametrize("standalone", [
    {"image_b64": "c3ludGhldGlj", "image_mime": "image/png"},
    {"documents": [{"name": "fixture.txt", "text": "Synthetic private reference."}]},
    {"note_refs": [{"id": "fixture-note", "revision": "c" * 64}]},
    {"case_ref": {"id": "case-" + "d" * 32, "revision": "e" * 64}},
], ids=["image", "documents", "selected-notes", "case"])
def test_standalone_inputs_reject_lan_before_reference_or_model_work(lan_chat, monkeypatch, path, standalone):
    prior = seed_conversation()
    monkeypatch.setattr(ai_routes, "image_reply", forbidden)
    for module, field in ((ai_routes.documents, "documents"), (ai_routes.notebook, "note_refs"),
                          (ai_routes.case_context, "case_ref")):
        original = module.prepare
        def protected(user, req, *, _original=original, _field=field, **kwargs):
            if getattr(req, _field, None):
                pytest.fail("LAN-incompatible reference was prepared before rejecting the choice")
            return _original(user, req, **kwargs)
        monkeypatch.setattr(module, "prepare", protected)
    response = submit(lan_chat, path, **standalone)
    assert response.status_code in (409, 422), response.text
    assert "LAN" in response.text or "lan" in response.text
    assert not lan_chat.calls and S.load_conversations()["continuity"]["messages"] == prior


@pytest.mark.parametrize("path", POSTS)
@pytest.mark.parametrize("fast_path", ["action", "status", "tool"])
def test_explicit_lan_choice_preserves_local_fast_path_once(lan_chat, monkeypatch, path, fast_path):
    calls = []
    symbols = {"action": "_route_action_intent", "status": "ai_status_answer", "tool": "_tool_answer"}
    def local_answer(*args):
        calls.append(args[-1])
        return "Fixture local result."
    monkeypatch.setattr(ai_routes, symbols[fast_path], local_answer)
    result = completed(submit(lan_chat, path, message="Turn on the Office Lamp."), path)
    assert result["reply"] == "Fixture local result."
    assert calls == ["Turn on the Office Lamp."]
    assert not lan_chat.calls
    assert result.get("inference_host") is None


@pytest.mark.parametrize("path", POSTS)
@pytest.mark.parametrize("success", [True, False])
def test_shelly_intent_success_or_failure_never_forwards_to_remote(lan_chat, monkeypatch, path, success):
    import home_conversation as home
    registry = [{"id": "shelly-office", "source_id": "office", "source": "shelly", "kind": "smart_device",
                 "name": "Office Lamp", "address": "192.0.2.44", "ip": "192.0.2.44", "relay": 0}]
    executions = []
    monkeypatch.setattr(home, "_registry", lambda: registry)
    monkeypatch.setattr(home, "_license", lambda: None)
    monkeypatch.setattr(ai_routes, "_route_action_intent", _REAL_ACTION_ROUTE)
    def execute(device, action, user):
        assert user == "alice" and action == "on"
        executions.append(copy.deepcopy(device))
        return {"ok": success}
    monkeypatch.setattr(home, "_command", execute)
    monkeypatch.setattr(home, "_read", lambda *args: {"ok": True, "on": True})
    monkeypatch.setattr(ai_routes, "execute_action", forbidden)
    result = completed(submit(lan_chat, path, message="Turn on Office Lamp"), path)
    assert len(executions) == 1 and not lan_chat.calls
    assert result["handled_by"] == "intent_engine"
    assert ("acknowledged the on command" if success else "did not confirm the on command") in result["reply"]
    if success:
        assert "**ON**" in result["reply"]


@pytest.mark.parametrize("path", POSTS)
def test_embedded_home_command_never_reaches_legacy_executor(lan_chat, monkeypatch, path):
    import home_conversation as home
    monkeypatch.setattr(home, "_command", forbidden)
    monkeypatch.setattr(ai_routes, "_route_action_intent", _REAL_ACTION_ROUTE)
    monkeypatch.setattr(S, "load_shelly_registry", lambda: [{"name": "Office Lamp", "ip": "192.0.2.44", "relay": 0}])
    monkeypatch.setattr(ai_routes, "execute_action", forbidden)
    result = completed(submit(lan_chat, path, message="Explain how to turn on Office Lamp"), path)
    assert len(lan_chat.calls) == 1
    assert result["reply"] == REPLY


def test_eventsource_get_without_lan_choice_keeps_local_behavior(lan_chat, monkeypatch):
    local_calls = []
    monkeypatch.setattr(lan_chat.service, "selection", forbidden)
    monkeypatch.setattr(lan_chat.service, "stream", forbidden)
    monkeypatch.setattr(lan_chat.manager, "ensure_running", lambda: True)
    monkeypatch.setattr(ai_routes, "_should_prefer_mesh", lambda: False)
    def local_stream(url, payload, **kwargs):
        local_calls.append(copy.deepcopy(payload["messages"]))
        yield json.dumps({"choices": [{"delta": {"content": "Local synthetic answer."}}]})
    monkeypatch.setattr(ai_routes, "_llama_stream_raw", local_stream)
    response = lan_chat.client.get("/api/ai/chat/stream", params={"message": QUESTION})
    result = completed(response, "/api/ai/chat/stream")
    assert result["reply"] == "Local synthetic answer." and len(local_calls) == 1
    assert not lan_chat.calls and result.get("inference_host") is None


def test_unsigned_legacy_generation_is_retired_without_starting_model(lan_chat):
    response = lan_chat.client.post("/tli/ai/chat", json={"messages": [{"role": "user", "content": "Hello"}]})
    assert response.status_code == 410 and "retired" in response.text
    assert not lan_chat.calls and not lan_chat.selections


def test_legacy_discovery_cannot_probe_or_select_a_peer(monkeypatch):
    # Use the real compatibility boundary, independent of per-request fixtures.
    monkeypatch.setattr(ai_routes.requests, "get", forbidden)
    monkeypatch.setattr(S, "load_mesh_directory", forbidden)
    assert ai_routes._find_mesh_ai_peer() is None


def test_requester_disconnect_closes_transport_and_keeps_history_incomplete(lan_chat, monkeypatch):
    closed = []
    seed_conversation()
    def remote(selected, messages, **kwargs):
        try:
            yield {"type": "meta", "model": "fixture-remote-model", "provider": "lmstudio", "peer": dict(PEER)}
            yield {"type": "delta", "text": "Must not complete"}
            yield {"type": "done"}
        finally:
            closed.append(True)
    monkeypatch.setattr(lan_chat.service, "stream", remote)
    scope = {"type": "http", "asgi": {"spec_version": "2.4"}, "method": "POST", "scheme": "https",
             "path": "/api/ai/chat/stream", "query_string": b"", "server": ("192.0.2.20", 8000),
             "client": ("192.0.2.21", 1234), "headers": [(b"cookie", ("tli_session=" + lan_chat.token).encode())]}
    response = ai_routes.ai_chat_stream_post(Request(scope), ai_routes.ChatRequest(
        message=QUESTION, conversation_id="continuity", lan_inference=CHOICE))
    async def exercise():
        async def receive():
            return {"type": "http.request", "body": b""}
        async def send(message):
            if message["type"] == "http.response.body":
                raise OSError("Synthetic requester disconnected")
        with pytest.raises(ClientDisconnect):
            await response(scope, receive, send)
    asyncio.run(exercise())
    assert closed == [True]
    assert S.load_conversations()["continuity"]["messages"][-1]["role"] == "user"
    from conversation_guard import assert_idle
    assert_idle(["continuity"])
