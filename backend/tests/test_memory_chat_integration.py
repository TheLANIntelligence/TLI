"""Real chat routing and persistence with synthetic providers and owned notes."""
from contextlib import nullcontext
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import requests
from fastapi import HTTPException
from fastapi.testclient import TestClient

import tli_state as S
from ai import ai_routes
from intelligence import context, memory
from routers import chat_routes
from providers.lmstudio import LMStudioProvider


ROUTES = ("bundled", "stream", "lmstudio")
PATHS = {"bundled": "/api/ai/chat", "stream": "/api/ai/chat/stream", "lmstudio": "/chat"}
_REAL_BUNDLED_POST = ai_routes._llama_post
_REAL_BUNDLED_STREAM = ai_routes._llama_stream_raw


@pytest.fixture
def local_chat(app, tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(S, "_CONV_KEY", b"c" * 32)
    monkeypatch.setattr(S, "_MEM_KEY", b"m" * 32)
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(node_id="fixture-host", node_name="Study", role="standalone", host_address=""))
    monkeypatch.setattr(context.devices, "node", lambda: {"id": "fixture-host", "name": "Study", "role": "standalone"})
    monkeypatch.setattr(ai_routes, "_build_system_prompt", lambda **kw: "Primary synthetic instructions remain whole.")
    monkeypatch.setattr(chat_routes, "build_system_prompt", lambda *a, **kw: "Primary synthetic instructions remain whole.")
    monkeypatch.setattr(chat_routes, "choose_model", lambda *a: {"id": "fake-lm"})
    monkeypatch.setattr(ai_routes, "diagnostic_answer", lambda *a: None)
    monkeypatch.setattr(chat_routes, "diagnostic_answer", lambda *a: None)
    monkeypatch.setattr(ai_routes, "_route_action_intent", lambda *a: None)
    monkeypatch.setattr(ai_routes, "_tool_answer", lambda *a: None)
    monkeypatch.setattr(ai_routes, "_should_prefer_mesh", lambda: False)
    monkeypatch.setattr(ai_routes, "_find_mesh_ai_peer", lambda: pytest.fail("Unexpected mesh lookup"))
    import ambient
    monkeypatch.setattr(ambient, "get_home_snapshot", lambda: {})
    calls = []
    manager = SimpleNamespace(ensure_running=lambda: True, base_url="http://127.0.0.1:9999",
                              active_preset_id="fake-bundled", generation=lambda: nullcontext())
    monkeypatch.setattr(ai_routes.BundledAIManager, "get", lambda: manager)

    def bundled_post(url, payload, **kwargs):
        calls.append(copy.deepcopy(payload["messages"]))
        return {"model": "fake-bundled", "choices": [{"message": {"content": "A synthetic printer answer."}}]}

    def stream(url, payload, **kwargs):
        calls.append(copy.deepcopy(payload["messages"]))
        yield json.dumps({"choices": [{"delta": {"content": "A synthetic "}}]})
        yield json.dumps({"choices": [{"delta": {"content": "printer answer."}}]})

    def lm_complete(**kwargs):
        calls.append(copy.deepcopy(kwargs["messages"]))
        return {"text": "A synthetic printer answer.", "model": "fake-lm"}

    monkeypatch.setattr(ai_routes, "_llama_post", bundled_post)
    monkeypatch.setattr(ai_routes, "_llama_stream_raw", stream)
    monkeypatch.setattr(S, "lm_provider", SimpleNamespace(health_check=lambda: True, complete=lm_complete))
    client = TestClient(app, base_url="https://192.0.2.20:8000")
    client.headers["Cookie"] = "tli_session=" + S.create_session_token("alice")
    return SimpleNamespace(client=client, calls=calls, manager=manager)


def seed_conversation(ident="continuity", count=0):
    history = [message for index in range(count) for message in (
        {"role": "user", "content": f"Question {index}: " + "q" * 200},
        {"role": "assistant", "content": f"Answer {index}: " + "a" * 200})]
    S.save_conversations({ident: {"id": ident, "user_id": "alice", "title": "Synthetic printer discussion", "messages": history}})
    return history


def submit(fixture, route, **body):
    return fixture.client.post(PATHS[route], json={"message": "Which printer paper?", "conversation_id": "continuity",
                                                 **({"brain": "lmstudio"} if route == "lmstudio" else {}), **body})


def frames(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


def completed(response, route):
    assert response.status_code == 200, response.text
    if route != "stream":
        return response.json()
    events = frames(response)
    assert events[-1]["type"] == "done"
    assert "memory_context" not in events[0] and "conversation_context" not in events[0]
    return next(e for e in reversed(events) if e["type"] == "meta")


def supplied_notes(messages):
    for message in messages:
        if message["role"] != "system":
            continue
        for line in message["content"].splitlines():
            if line.startswith("memory: "):
                return json.loads(line.removeprefix("memory: "))
    return []


@pytest.mark.parametrize("route", ROUTES)
def test_final_provider_input_receipts_and_reopened_history_agree(local_chat, route):
    prior = seed_conversation(count=24)
    owned = [memory.save_fact("alice", f"Printer paper setting {i}: " + "detail " * 235, title=f"Printer paper {i}") for i in range(8)]
    memory.save_fact("bob", "Printer paper private to Bob.")
    response = submit(local_chat, route, user_id="bob")
    receipt = completed(response, route)
    assert len(local_chat.calls) == 1
    messages = local_chat.calls[0]
    assert sum(len(m["content"]) for m in messages) <= 12000
    assert messages[0]["content"] == "Primary synthetic instructions remain whole."
    assert messages[-1] == {"role": "user", "content": "Which printer paper?"}
    history = [m for m in messages if m["role"] != "system"][:-1]
    assert len(history) > 8 and history == prior[-len(history):]
    notes = supplied_notes(messages)
    assert notes and all(n["text"] == next(f["text"] for f in owned if f["id"] == n["id"]) for n in notes)
    assert "Bob" not in json.dumps(messages)
    assert receipt["memory_context"]["notes"] == [{k: v for k, v in note.items() if k != "text"} for note in notes]
    assert receipt["memory_context"]["omitted_for_budget"] == 8 - len(notes)
    assert receipt["conversation_context"]["included_messages"] == len(history)
    assert receipt["conversation_context"]["omitted_messages"] == len(prior) - len(history)
    saved = S.load_conversations()["continuity"]
    assert saved["user_id"] == "alice"
    assert saved["messages"][:len(prior)] == prior
    reopened = local_chat.client.get("/api/ai/conversations/continuity").json()["messages"][-1]
    for key in ("memory_context", "conversation_context"):
        assert reopened[key] == receipt[key] == saved["messages"][-1][key]
    assert reopened["source_ref"] == receipt["source_ref"]


@pytest.mark.parametrize("route", ROUTES)
def test_off_skips_all_saved_memory_and_keeps_local_provider_even_if_mesh_preferred(local_chat, monkeypatch, route):
    prior = seed_conversation(count=1)
    monkeypatch.setattr(S, "load_memory", lambda *a, **kw: pytest.fail("Opt-out read owned saved notes"))
    monkeypatch.setattr(memory, "legacy_facts", lambda *a, **kw: pytest.fail("Opt-out read ownerless device notes"))
    monkeypatch.setattr(ai_routes, "_should_prefer_mesh", lambda: True)
    result = completed(submit(local_chat, route, use_saved_memory=False), route)
    assert result["memory_context"] == {"use_saved_memory": False, "status": "disabled", "notes": [], "omitted_for_budget": 0}
    assert len(local_chat.calls) == 1 and not supplied_notes(local_chat.calls[0])
    assert [m for m in local_chat.calls[0] if m["role"] != "system"][:-1] == prior


@pytest.mark.parametrize("route", ("bundled", "stream"))
def test_off_unavailable_bundled_provider_does_not_find_or_call_a_peer(local_chat, monkeypatch, route):
    prior = seed_conversation(count=1)
    local_chat.manager.ensure_running = lambda: False
    monkeypatch.setattr(S, "load_memory", lambda *a, **kw: pytest.fail("Unavailable opt-out read memory"))
    monkeypatch.setattr(ai_routes, "_proxy_chat_to_mesh_peer", lambda *a: pytest.fail("Opt-out called mesh"))
    monkeypatch.setattr(ai_routes, "_stream_via_mesh_peer", lambda *a: pytest.fail("Opt-out streamed through mesh"))
    response = submit(local_chat, route, use_saved_memory=False)
    if route == "stream":
        events = frames(response)
        assert events[-1]["type"] == "error" and not any(e["type"] == "done" for e in events)
    else:
        assert response.status_code == 409
    assert "cannot confirm" in response.text
    assert not local_chat.calls and S.load_conversations()["continuity"]["messages"] == prior


def test_off_legacy_member_route_rejects_before_proxy_or_memory_read(local_chat, monkeypatch):
    prior = seed_conversation(count=1)
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(node_id="member", role="member", host_address="https://192.0.2.30:8000"))
    monkeypatch.setattr(S, "load_memory", lambda *a, **kw: pytest.fail("Member opt-out read memory"))
    monkeypatch.setattr(chat_routes, "proxy_chat_to_host", lambda *a: pytest.fail("Member opt-out forwarded request"))
    response = submit(local_chat, "lmstudio", use_saved_memory=False)
    assert response.status_code == 409 and "cannot confirm" in response.text
    assert not local_chat.calls and S.load_conversations()["continuity"]["messages"] == prior


@pytest.mark.parametrize("route", ROUTES)
def test_off_plus_explicit_notes_rejects_before_read_or_execution(local_chat, monkeypatch, route):
    seed_conversation()
    monkeypatch.setattr(S, "load_memory", lambda *a, **kw: pytest.fail("Conflicting request read notes"))
    monkeypatch.setattr(ai_routes, "_route_action_intent", lambda *a: pytest.fail("Conflicting request executed action path"))
    monkeypatch.setattr(chat_routes, "diagnostic_answer", lambda *a: pytest.fail("Conflicting request executed diagnostic path"))
    response = submit(local_chat, route, use_saved_memory=False, note_refs=[{"id": "f-note", "revision": "a" * 64}])
    assert response.status_code == 422 and "Remove selected Notebook notes" in response.text
    assert not local_chat.calls and S.load_conversations()["continuity"]["messages"] == []


@pytest.mark.parametrize("route", ROUTES)
def test_oversized_latest_question_never_reaches_provider_or_changes_saved_turns(local_chat, route):
    prior = seed_conversation(count=1)
    before = Path(S.CONVERSATIONS_FILE).read_bytes()
    response = submit(local_chat, route, message="Printer " + "x" * 12000)
    if route == "stream":
        events = frames(response)
        assert events == [{"type": "error", "detail": events[0]["detail"]}]
    else:
        assert response.status_code == 422
    assert "text budget" in response.text
    assert not local_chat.calls
    assert S.load_conversations()["continuity"]["messages"] == prior
    assert Path(S.CONVERSATIONS_FILE).read_bytes() == before


@pytest.mark.parametrize("route", ROUTES)
def test_provider_failure_has_no_completed_receipt_or_saved_assistant(local_chat, monkeypatch, route):
    prior = seed_conversation(count=1)
    memory.save_fact("alice", "Printer uses A4 paper.")

    def fail_post(url, payload, **kwargs):
        local_chat.calls.append(payload["messages"])
        raise HTTPException(502, "Synthetic provider unavailable")

    def fail_stream(url, payload, **kwargs):
        local_chat.calls.append(payload["messages"])
        yield json.dumps({"choices": [{"delta": {"content": "Partial"}}]})
        yield json.dumps({"type": "error", "detail": "Synthetic provider unavailable"})

    def fail_lm(**kwargs):
        local_chat.calls.append(kwargs["messages"])
        raise RuntimeError("Synthetic provider unavailable")

    monkeypatch.setattr(ai_routes, "_llama_post", fail_post)
    monkeypatch.setattr(ai_routes, "_llama_stream_raw", fail_stream)
    monkeypatch.setattr(S.lm_provider, "complete", fail_lm)
    response = submit(local_chat, route)
    if route == "stream":
        events = frames(response)
        assert events[-1]["type"] == "error"
        assert not any(e["type"] == "done" or "memory_context" in e or "conversation_context" in e or "source_ref" in e for e in events)
    else:
        assert response.status_code in (502, 503)
        assert "memory_context" not in response.json() and "conversation_context" not in response.json()
    assert len(local_chat.calls) == 1
    newly_saved = S.load_conversations()["continuity"]["messages"][len(prior):]
    assert not any(m["role"] == "assistant" or "memory_context" in m or "conversation_context" in m for m in newly_saved)


@pytest.mark.parametrize("route", ROUTES)
def test_corrected_and_deleted_notes_change_next_recall_but_keep_old_chat(local_chat, route):
    seed_conversation()
    fact = memory.save_fact("alice", "Printer paper is A4.", title="Printer paper")
    first = completed(submit(local_chat, route), route)
    first_history = copy.deepcopy(S.load_conversations()["continuity"]["messages"])
    edited = memory.change("alice", fact["id"], "Printer paper is now letter.")
    second = completed(submit(local_chat, route), route)
    assert supplied_notes(local_chat.calls[-1])[0]["text"] == "Printer paper is now letter."
    assert second["memory_context"]["notes"][0]["revision"] == edited["revision"]
    assert first["memory_context"]["notes"][0]["revision"] != edited["revision"]
    memory.change("alice", fact["id"], None)
    third = completed(submit(local_chat, route), route)
    assert third["memory_context"]["status"] == "none" and not supplied_notes(local_chat.calls[-1])
    assert S.load_conversations()["continuity"]["messages"][:2] == first_history
    assert third["conversation_context"]["included_exchanges"] == 2


@pytest.mark.parametrize("path,brain", [("/api/ai/chat", "bundled"), ("/api/ai/chat/stream", "bundled"),
                                        ("/chat", "bundled"), ("/chat", "lmstudio")])
@pytest.mark.parametrize("explicit_note", [False, True], ids=["automatic-recall", "selected-note"])
@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_private_context_redirect_is_not_followed_or_retried_and_has_no_receipt(local_chat, monkeypatch, path, brain, explicit_note, status):
    prior = seed_conversation(count=1)
    secret = "Synthetic printer private-note marker 76c9401a"
    fact = memory.save_fact("alice", secret, title="Printer")
    selected_url = local_chat.manager.base_url + "/v1/chat/completions"
    provider = LMStudioProvider(selected_url, local_chat.manager.base_url + "/v1/models")
    monkeypatch.setattr(provider, "health_check", lambda: True)
    monkeypatch.setattr(S, "lm_provider", provider)
    monkeypatch.setattr(ai_routes, "_llama_post", _REAL_BUNDLED_POST)
    monkeypatch.setattr(ai_routes, "_llama_stream_raw", _REAL_BUNDLED_STREAM)
    sent = []

    def post(url, **kwargs):
        sent.append(url)
        assert secret in str(kwargs["json"]["messages"])
        followed = kwargs.get("allow_redirects", True)
        if followed:
            # Model requests.Session's redirect behavior without contacting a
            # listener: 307/308 would replay this exact private request body.
            sent.append("https://unselected.invalid/collect")
        response = requests.Response()
        response.status_code = 200 if followed else status
        response.url = selected_url
        response.headers["Location"] = "https://unselected.invalid/collect"
        if kwargs.get("stream"):
            response._content = ('data: {"choices":[{"delta":{"content":"Wrong endpoint reply"}}]}\n\ndata: [DONE]\n\n').encode()
        else:
            response._content = json.dumps({"choices": [{"message": {"content": secret}}]}).encode()
        response._content_consumed = True
        return response

    monkeypatch.setattr(requests, "post", post)
    body = {"message": "Which printer?", "brain": brain, "conversation_id": "continuity"}
    if explicit_note:
        body["note_refs"] = [{"id": fact["id"], "revision": fact["revision"]}]
    response = local_chat.client.post(path, json=body)
    assert sent == [selected_url]  # No redirect, provider fallback or replay.
    assert secret not in response.text
    if path.endswith("/stream"):
        events = frames(response)
        assert events[-1]["type"] == "error"
        assert not any(e["type"] == "done" or any(key in e for key in
            ("note_context", "memory_context", "conversation_context", "source_ref")) for e in events)
    else:
        assert response.status_code in (502, 503)
        assert not any(response.json().get(key) for key in ("note_context", "memory_context", "conversation_context", "source_ref"))
    new_turns = S.load_conversations()["continuity"]["messages"][len(prior):]
    assert not any(m["role"] == "assistant" or "memory_context" in m or "note_context" in m for m in new_turns)
