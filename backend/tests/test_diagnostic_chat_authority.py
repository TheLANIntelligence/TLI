"""Captured diagnostic access survives formatting, persistence, and SSE boundaries."""
import copy
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

import home_conversation
import tli_state as S
from ai import ai_routes as ai, diagnostics, intent_engine as intent
from routers import tool_routes as tools


@pytest.fixture
def chat(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "load_pin_config", lambda:{"enabled":True})
    monkeypatch.setattr(S, "load_shelly_registry", lambda:[])
    token = S.create_session_token("local")
    def revoke(): S.revoke_session_token(token)
    forbidden = Mock(side_effect=AssertionError("No model, process, or network request is allowed"))
    monkeypatch.setattr(tools.requests, "get", forbidden)
    monkeypatch.setattr(tools.requests, "post", forbidden)
    monkeypatch.setattr(tools.subprocess, "run", forbidden)
    monkeypatch.setattr(ai, "_tool_answer", forbidden)
    monkeypatch.setattr(ai, "_llama_post", forbidden)
    monkeypatch.setattr(ai, "_llama_stream_raw", forbidden)
    monkeypatch.setattr(ai.BundledAIManager, "get", lambda:SimpleNamespace(active_preset_id=None))
    monkeypatch.setattr(home_conversation, "answer", lambda *a:None)
    monkeypatch.setattr(ai, "_log", lambda *a, **k:None)
    monkeypatch.setattr(intent, "_log_action", lambda *a, **k:None)
    for module in (ai.case_context, ai.documents, ai.notebook):
        monkeypatch.setattr(module, "prepare", lambda *a, **k:None)
    monkeypatch.setattr(ai.chat_continuity, "recorded_outcome", lambda *a, **k:None)
    monkeypatch.setattr(ai.chat_continuity, "source_refs", lambda _id:{})
    monkeypatch.setattr(ai, "diagnostic_answer", lambda *a:None)
    monkeypatch.setattr(ai, "ai_status_answer", lambda *a:None)
    monkeypatch.setattr(ai, "storage_question", lambda *a:False)
    monkeypatch.setattr(ai.observed_answers, "answer", lambda *a, **k:None)
    monkeypatch.setattr(ai, "_get_or_create_conv", lambda *a, **k:"private-conversation")
    stored = {"private-conversation":{"id":"private-conversation", "user_id":"local", "messages":[]}}
    writes = []
    monkeypatch.setattr(S, "load_conversations", lambda:copy.deepcopy(stored))
    def persist(value, *, check=None):
        if check is not None:
            check()
        saved = json.loads(json.dumps(value))
        writes.append(saved)
        stored.clear(); stored.update(saved)
    monkeypatch.setattr(S, "save_conversations", persist)
    handler = Mock(return_value={"hostname":"PRIVATE DIAGNOSTIC HOST", "os":"Synthetic OS"})
    monkeypatch.setitem(tools.BUILTIN_TOOLS, "sys_snapshot", {"handler":handler})
    app = FastAPI(); app.include_router(ai.router)
    client = TestClient(app, base_url="http://localhost:8000", client=("127.0.0.1", 1234),
                        headers={"Origin":"http://localhost:8000", "Cookie":"tli_session=" + token})
    yield SimpleNamespace(client=client, token=token, revoke=revoke, writes=writes, stored=stored,
                          persist=persist, handler=handler, forbidden=forbidden, app=app)
    client.close()
    forbidden.assert_not_called()


def submit(chat, stream=False, message="Show me system info"):
    return chat.client.post("/api/ai/chat" + ("/stream" if stream else ""), json={"message":message})


def frames(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


def assert_denied(response, stream, status=401):
    if stream:
        assert response.status_code == 200
        assert frames(response) == [{"type":"error", "status_code":status, "code":"session_changed",
                                      "detail":"Action access ended. Reconnect to TLI and check the device or action status before trying again; nothing will retry automatically."}]
    else:
        assert response.status_code == status, response.text
    assert "PRIVATE DIAGNOSTIC HOST" not in response.text


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("message", ["Show me system info", "Run diagnostics"])
def test_foreign_origin_diagnostic_is_denied_before_service_or_saved_turn(chat, monkeypatch, stream, message):
    report = Mock(side_effect=AssertionError("A denied diagnostic cannot start"))
    monkeypatch.setattr(ai, "run_full_diagnostic", report)
    chat.client.headers["Origin"] = "https://foreign.example"
    assert_denied(submit(chat, stream, message), stream, status=403)
    chat.handler.assert_not_called()
    report.assert_not_called()
    assert chat.writes == []


@pytest.mark.parametrize("stream", [False, True])
def test_successful_diagnostic_retains_response_contract_and_plain_saved_text(chat, stream):
    response = submit(chat, stream)
    assert response.status_code == 200, response.text
    if stream:
        assert [frame["type"] for frame in frames(response)] == ["meta", "delta", "done"]
    else:
        assert response.json()["handled_by"] == "intent_engine"
    assert "PRIVATE DIAGNOSTIC HOST" in response.text
    assert len(chat.writes) == 2
    assert [turn["role"] for turn in chat.stored["private-conversation"]["messages"]] == ["user", "assistant"]
    assert all(type(turn["content"]) is str and "authorize" not in turn for turn in chat.stored["private-conversation"]["messages"])
    chat.handler.assert_called_once_with({})


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("stage,writes", [("handler",0), ("format",0), ("audit",0), ("route-log",0),
    ("trace",0), ("save-read",0), ("save-user",1), ("save-assistant",2), ("references",2)])
def test_revocation_withholds_diagnostic_and_stops_further_turn_writes(chat, monkeypatch, stream, stage, writes):
    if stage == "handler":
        def result(_params):
            chat.revoke(); return {"hostname":"PRIVATE DIAGNOSTIC HOST"}
        chat.handler.side_effect = result
    elif stage == "format":
        original = intent._format_tool_output
        def format_result(*args):
            text = original(*args); chat.revoke(); return text
        monkeypatch.setattr(intent, "_format_tool_output", format_result)
    elif stage == "audit":
        monkeypatch.setattr(intent, "_log_action", lambda *a, **k:chat.revoke())
    elif stage in {"route-log", "trace"}:
        def log(_sub, _level, message, **kwargs):
            matches = message.startswith("Action result:") if stage == "route-log" else message == "request_trace"
            if matches:
                chat.revoke()
        monkeypatch.setattr(ai, "_log", log)
    elif stage == "save-read":
        def read():
            chat.revoke(); return copy.deepcopy(chat.stored)
        monkeypatch.setattr(S, "load_conversations", read)
    elif stage in {"save-user", "save-assistant"}:
        def persist(value, *, check=None):
            chat.persist(value, check=check)
            if len(chat.writes) == writes:
                chat.revoke()
        monkeypatch.setattr(S, "save_conversations", persist)
    elif stage == "references":
        def references(_id):
            chat.revoke(); return {}
        monkeypatch.setattr(ai.chat_continuity, "source_refs", references)
    response = submit(chat, stream)
    assert_denied(response, stream)
    assert len(chat.writes) == writes
    assert len(chat.stored["private-conversation"]["messages"]) == writes


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("stage", ["report", "format"])
def test_full_diagnostic_report_and_formatting_use_original_guard(chat, monkeypatch, stream, stage):
    def report(**kwargs):
        kwargs["check"]()
        if stage == "report": chat.revoke()
        return {"healthy":True, "checks":[{"name":"PRIVATE DIAGNOSTIC HOST", "ok":True, "detail":"Private", "ms":0}]}
    monkeypatch.setattr(ai, "run_full_diagnostic", report)
    if stage == "format":
        original = intent._format_diagnostic_report
        def format_result(value):
            text = original(value); chat.revoke(); return text
        monkeypatch.setattr(intent, "_format_diagnostic_report", format_result)
    assert_denied(submit(chat, stream, "Run diagnostics"), stream)
    assert chat.writes == []
    chat.handler.assert_not_called()


@pytest.mark.parametrize("after", ["meta", "delta"])
def test_sse_rechecks_between_frames_without_undoing_completed_turns(chat, after):
    request = Request({"type":"http", "method":"POST", "scheme":"http", "path":"/api/ai/chat/stream",
        "headers":[(b"host", b"localhost:8000"), (b"origin", b"http://localhost:8000"),
                   (b"cookie", ("tli_session=" + chat.token).encode())], "client":("127.0.0.1",1234), "server":("localhost",8000)})
    stream = ai._stream_response(request, "Show me system info", "private-conversation", None, 300, 0.2)
    first = json.loads(next(stream)[6:])
    assert first["type"] == "meta"
    if after == "delta":
        assert "PRIVATE DIAGNOSTIC HOST" in next(stream)
    chat.revoke()
    remaining = list(stream)
    assert len(remaining) == 1
    error = json.loads(remaining[0][6:])
    assert error["type"] == "error" and error["status_code"] == 401
    assert "PRIVATE DIAGNOSTIC HOST" not in remaining[0]
    assert len(chat.writes) == 2


@pytest.mark.parametrize("stage", ["read", "write"])
def test_failed_persistence_cannot_replace_original_revocation_with_an_error(chat, monkeypatch, stage):
    def fail(*args, **kwargs):
        chat.revoke(); raise OSError("Synthetic private persistence failure")
    monkeypatch.setattr(S, "load_conversations" if stage == "read" else "save_conversations", fail)
    response = submit(chat)
    assert_denied(response, False)
    assert "Synthetic private" not in response.text
    assert chat.writes == []


@pytest.mark.parametrize("status", [401, 403])
def test_diagnostic_check_read_failure_propagates_original_authority(status):
    denial = HTTPException(status, "Original authority ended")
    revoked = False
    def check():
        if revoked: raise denial
    def failure():
        nonlocal revoked
        revoked = True
        raise OSError("Private read failure")
    with pytest.raises(HTTPException) as result:
        diagnostics._check("Private", failure, check)
    assert result.value is denial
