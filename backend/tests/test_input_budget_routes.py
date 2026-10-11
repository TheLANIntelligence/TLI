"""Final provider budgeting and no-replay behavior through actual chat routes."""
import json
from contextlib import contextmanager, nullcontext
from types import SimpleNamespace

import pytest
import requests
from fastapi import HTTPException

import tli_state as S
from ai import ai_routes as ai
from intelligence import input_budget as ib, memory
from routers import chat_routes as legacy

REAL_POST = ai._llama_post
REAL_STREAM = ai._llama_stream_raw


@pytest.fixture
def isolated_provider(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled":False})
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(node_id="fixture", node_name="Fixture", role="standalone", host_address=None))
    monkeypatch.setattr(ai, "_should_prefer_mesh", lambda: False)
    monkeypatch.setattr(ai, "_find_mesh_ai_peer", lambda: pytest.fail("no mesh fallback"))
    monkeypatch.setattr(ai, "_route_action_intent", lambda *a: None)
    monkeypatch.setattr(ai, "_tool_answer", lambda *a: None)
    monkeypatch.setattr(ai, "_build_system_prompt", lambda **kw: "Synthetic local assistant.")
    monkeypatch.setattr(legacy, "diagnostic_answer", lambda *a: None)
    monkeypatch.setattr(ai, "diagnostic_answer", lambda *a: None)
    monkeypatch.setattr(S.lm_provider, "health_check", lambda: pytest.fail("no extra readiness generation"))
    calls, probes = [], []
    manager = SimpleNamespace(base_url="http://127.0.0.1:19998", active_preset_id="standard", generation=nullcontext,
        ensure_running=lambda: probes.append("ensure") or True,
        text_capacity=lambda: {"status":"configured", "context_tokens":4096, "source":"owned_runtime_launch", "model":"standard"})
    monkeypatch.setattr(ai.BundledAIManager, "get", lambda: manager)
    def complete(base, payload, **kwargs):
        calls.append(("bundled", payload))
        return {"model":"standard", "choices":[{"message":{"content":"Synthetic answer"}}]}
    def stream(url, payload, **kwargs):
        calls.append(("bundled", payload))
        report = ib.for_provider("bundled", manager=manager, max_tokens=payload["max_tokens"]).validate(payload["messages"])
        yield json.dumps({"type":"input_budget", "input_budget":report})
        yield json.dumps({"choices":[{"delta":{"content":"Synthetic answer"}}]})
    monkeypatch.setattr(ai, "_llama_post", complete)
    monkeypatch.setattr(ai, "_llama_stream_raw", stream)
    monkeypatch.setattr(S.lm_provider, "complete", lambda **kw: calls.append(("lmstudio",kw)) or {"text":"Synthetic answer", "model":"fixture-lm"})
    return SimpleNamespace(calls=calls, probes=probes, manager=manager)


def frames(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


@pytest.mark.parametrize("path", ["/api/ai/chat", "/api/ai/chat/stream", "/chat"])
@pytest.mark.parametrize("kind", ["notes", "documents"])
def test_explicit_references_reject_configured_overflow_even_with_fake_transport(path, kind, client, isolated_provider):
    body = {"message":"Summarize the selected reference."}
    if kind == "documents":
        body["documents"] = [{"name":"reference.txt", "text":"你" * 1600}]
    else:
        fact = memory.save_fact("local", "你" * 1600, title="Saved setup")
        body["note_refs"] = [{"id":fact["id"], "revision":fact["revision"]}]
    response = client.post(path, json=body)
    expected_error = "whole-line" if kind == "documents" else "configured context"
    if path.endswith("/stream"):
        data = frames(response)
        assert data[-1]["type"] == "error" and expected_error in data[-1]["detail"]
        assert not any(f["type"] == "done" or f.get("input_budget") for f in data)
    else:
        assert response.status_code == 422 and expected_error in response.json()["detail"]
    assert not isolated_provider.calls


@pytest.mark.parametrize("path", ["/api/ai/chat", "/api/ai/chat/stream", "/chat"])
def test_long_formatted_document_uses_disclosed_whole_lines(path, client, isolated_provider):
    response = client.post(path, json={"message":"Summarize.", "documents":[{"name":"many-lines.txt", "text":"a\n" * 3000}]})
    assert response.status_code == 200
    assert len(isolated_provider.calls) == 1
    if path.endswith('/stream'):
        data = frames(response)
        assert data[-1]['type'] == 'done'
        receipt = next(frame['document_context'] for frame in data if frame.get('document_context'))
    else:
        receipt = response.json()['document_context']
    doc = receipt['documents'][0]
    assert doc['line_count'] == 3001
    assert 0 < doc['coverage']['included_lines'] < 3001
    assert doc['coverage']['omitted_lines'] == 3001 - doc['coverage']['included_lines']
    saved = list(S.load_conversations().values())[0]['messages'][-1]
    assert saved['document_context'] == receipt
    assert '_document_source' not in json.dumps(S.load_conversations())


@pytest.mark.parametrize('path', ['/api/ai/chat', '/api/ai/chat/stream', '/chat'])
def test_document_excerpts_refit_to_chosen_runtime_and_keep_original_citations(path, client, isolated_provider):
    from intelligence import documents
    from hashlib import sha256
    isolated_provider.manager.text_capacity = lambda: {'status': 'configured', 'context_tokens': 2048,
        'source': 'owned_runtime_launch', 'model': 'standard'}
    lines = ['Unrelated housekeeping information.' for _ in range(200)]
    lines[177] = 'Printer amber light: remove the torn paper behind the tray.'
    original = '\n'.join(lines)
    body = {'message': 'What does the printer amber light mean?', 'max_tokens': 256,
            'documents': [{'name': 'manual.txt', 'text': original}]}
    response = client.post(path, json=body)
    assert response.status_code == 200, response.text
    if path.endswith('/stream'):
        data = frames(response)
        assert data[-1]['type'] == 'done', data
        result = next(frame for frame in data if frame.get('document_context'))
    else:
        result = response.json()
    assert len(isolated_provider.calls) == 1
    messages = isolated_provider.calls[0][1]['messages']
    assert len(json.dumps(messages)) < len(original)
    text = '\n'.join(message['content'] for message in messages)
    assert 'L178: ' + lines[177] in text
    assert 'omitted' in text
    doc = result['document_context']['documents'][0]
    assert doc['sha256'] == sha256(original.encode()).hexdigest()
    assert documents.public_receipt(result['document_context']) == result['document_context']
    assert result['input_budget']['context_tokens'] == 2048
    assert result['input_budget']['estimated_input_tokens'] + 256 <= 2048
    stored = S.load_conversations()
    assert '_document_source' not in json.dumps(stored)
    assert original not in json.dumps(stored)


@pytest.mark.parametrize("path", ["/api/ai/chat", "/api/ai/chat/stream", "/chat"])
def test_note_reply_reserves_default_output_and_persists_budget_only_after_completion(path, client, isolated_provider):
    fact = memory.save_fact("local", "The spare cable is in the drawer.", title="Cable")
    response = client.post(path, json={"message":"Where is the cable?", "note_refs":[{"id":fact["id"], "revision":fact["revision"]}]})
    assert response.status_code == 200
    if path.endswith("/stream"):
        data = frames(response)
        assert data[-1]["type"] == "done"
        assert not any(f["type"] == "input_budget" for f in data)
        report = next(f["input_budget"] for f in data if f.get("input_budget"))
    else:
        report = response.json()["input_budget"]
    assert report["reserved_output_tokens"] == isolated_provider.calls[0][1]["max_tokens"] == 1024
    assert report["capacity_status"] == "configured" and report["estimation"] == "heuristic"
    saved = list(S.load_conversations().values())[0]["messages"][-1]
    assert saved["input_budget"] == report
    assert "messages" not in report


@pytest.mark.parametrize("kind", ["ordinary", "notes", "documents"])
def test_lmstudio_uses_one_selected_request_without_health_probe(kind, client, isolated_provider):
    body = {"message":"Please explain this useful topic.", "brain":"lmstudio"}
    if kind == "notes":
        fact = memory.save_fact("local", "My synthetic preference", title="Preference")
        body["note_refs"] = [{"id":fact["id"], "revision":fact["revision"]}]
    if kind == "documents":
        body["documents"] = [{"name":"topic.txt", "text":"Synthetic reference."}]
    response = client.post("/chat", json=body)
    assert response.status_code == 200, response.text
    assert [name for name, _ in isolated_provider.calls] == ["lmstudio"]
    assert isolated_provider.calls[0][1]["enforce_text_budget"] is True
    assert response.json()["input_budget"]["capacity_status"] == "unknown"
    assert not isolated_provider.probes


def test_uncertain_bundled_request_never_falls_back_to_lmstudio(client, isolated_provider, monkeypatch):
    calls = []
    def fail(*args, **kwargs):
        calls.append(kwargs); raise requests.Timeout("Synthetic timeout after send")
    monkeypatch.setattr(legacy.requests, "post", fail)
    response = client.post("/chat", json={"message":"Please explain a useful concept.", "brain":"bundled"})
    assert response.status_code == 502 and "not retried" in response.json()["detail"]
    assert len(calls) == 1 and not isolated_provider.calls
    assert not S.load_conversations()


def test_no_runtime_before_send_can_still_use_existing_lmstudio_fallback(client, isolated_provider):
    isolated_provider.manager.ensure_running = lambda: False
    response = client.post("/chat", json={"message":"Please explain a useful concept.", "brain":"bundled"})
    assert response.status_code == 200
    assert [name for name, _ in isolated_provider.calls] == ["lmstudio"]
    assert response.json()["input_budget"]["provider"] == "lmstudio"


@pytest.mark.parametrize("streaming", [False, True])
def test_final_generation_guard_revalidates_capacity_after_preparation(streaming, monkeypatch):
    state = {"context":4096}
    @contextmanager
    def generation():
        state["context"] = 2048
        yield
    manager = SimpleNamespace(base_url="http://127.0.0.1:19998", active_preset_id="standard", generation=generation,
        text_capacity=lambda: {"status":"configured", "context_tokens":state["context"], "source":"owned_runtime_launch", "model":"standard"})
    payload = {"model":"tli-bundled", "messages":[{"role":"user", "content":"detail " * 550}], "max_tokens":1024}
    assert ib.for_provider("bundled", manager=manager, max_tokens=1024).validate(payload["messages"])
    monkeypatch.setattr(ai.BundledAIManager, "get", lambda: manager)
    monkeypatch.setattr(ai, "_llama_post_unlocked", lambda *a, **kw: pytest.fail("overflow cannot reach transport"))
    monkeypatch.setattr(ai, "_llama_stream_unlocked", lambda *a, **kw: pytest.fail("overflow cannot reach stream transport"))
    if streaming:
        data = [json.loads(frame) for frame in ai._llama_stream_raw(manager.base_url + "/v1/chat/completions", payload, expected_model="standard")]
        assert len(data) == 1 and data[0]["type"] == "error" and data[0]["status_code"] == 422
    else:
        with pytest.raises(HTTPException) as exc:
            ai._llama_post(manager.base_url, payload, expected_model="standard")
        assert exc.value.status_code == 422


def test_changed_model_is_not_authorized_by_an_older_budget(monkeypatch):
    manager = SimpleNamespace(base_url="http://127.0.0.1:19998", active_preset_id="new-selection", generation=nullcontext)
    monkeypatch.setattr(ai.BundledAIManager, "get", lambda: manager)
    monkeypatch.setattr(ai, "_llama_post_unlocked", lambda *a, **kw: pytest.fail("changed model cannot receive the question"))
    with pytest.raises(HTTPException) as exc:
        ai._llama_post(manager.base_url, {"messages":[{"role":"user", "content":"Question"}], "max_tokens":300}, expected_model="previous-selection")
    assert exc.value.status_code == 409


def test_upstream_cannot_spoof_local_budget_receipts(monkeypatch):
    manager = SimpleNamespace(base_url="http://127.0.0.1:19998", active_preset_id="standard", generation=nullcontext,
        text_capacity=lambda: {"status":"configured", "context_tokens":4096, "source":"owned_runtime_launch", "model":"standard"})
    monkeypatch.setattr(ai.BundledAIManager, "get", lambda: manager)
    monkeypatch.setattr(ai, "_llama_stream_unlocked", lambda *a, **kw: iter([
        json.dumps({"type":"input_budget", "input_budget":{"model":"fabricated", "estimation":"exact"}}),
        json.dumps({"choices":[{"delta":{"content":"Answer"}}]})]))
    data = [json.loads(frame) for frame in ai._llama_stream_raw(manager.base_url + "/v1/chat/completions",
        {"messages":[{"role":"user", "content":"Question"}], "max_tokens":300}, expected_model="standard")]
    assert len(data) == 2 and data[0]["input_budget"]["model"] == "standard"
    assert data[0]["input_budget"]["estimation"] == "heuristic"
    assert data[1]["choices"][0]["delta"]["content"] == "Answer"


@pytest.mark.parametrize("path", ["/api/ai/chat", "/api/ai/chat/stream", "/chat"])
@pytest.mark.parametrize("kind", ["ordinary", "notes", "documents"])
@pytest.mark.parametrize("changed", ["model", "endpoint"])
def test_switch_during_preparation_cannot_authorize_a_different_runtime(path, kind, changed, client, isolated_provider, monkeypatch):
    monkeypatch.setattr(client._transport, "raise_server_exceptions", True)
    monkeypatch.setattr(ai, "_llama_post", REAL_POST)
    monkeypatch.setattr(ai, "_llama_stream_raw", REAL_STREAM)
    monkeypatch.setattr(ai, "_llama_post_unlocked", lambda *a, **kw: pytest.fail("changed runtime received private text"))
    monkeypatch.setattr(ai, "_llama_stream_unlocked", lambda *a, **kw: pytest.fail("changed runtime received private stream"))
    monkeypatch.setattr(legacy.requests, "post", lambda *a, **kw: pytest.fail("changed runtime received a legacy request"))
    validate = ib.TextBudget.validate
    changed_during_prepare = []
    def validate_and_switch(policy, messages):
        result = validate(policy, messages)
        if policy.provider == "bundled" and not changed_during_prepare:
            changed_during_prepare.append(True)
            if changed == "model":
                isolated_provider.manager.active_preset_id = "different-model"
            else:
                isolated_provider.manager.base_url = "http://127.0.0.1:19997"
        return result
    monkeypatch.setattr(ib.TextBudget, "validate", validate_and_switch)
    body = {"message":"Please explain this useful topic."}
    if kind == "notes":
        fact = memory.save_fact("local", "Synthetic setup", title="Setup")
        body["note_refs"] = [{"id":fact["id"], "revision":fact["revision"]}]
    elif kind == "documents":
        body["documents"] = [{"name":"topic.txt", "text":"Synthetic topic."}]
    response = client.post(path, json=body)
    assert changed_during_prepare, response.text
    if path.endswith("/stream"):
        data = frames(response)
        assert data[-1]["type"] == "error"
        assert not any(f["type"] == "done" for f in data)
    else:
        assert response.status_code == 409, response.text
    assert not isolated_provider.calls
