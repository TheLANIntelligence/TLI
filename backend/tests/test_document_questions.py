"""Explicit document Q&A, isolated from disk contents, devices and inference."""
import hashlib
import json
from contextlib import nullcontext
from types import SimpleNamespace

import pytest
import requests
from fastapi import HTTPException
from pydantic import ValidationError

import tli_state as S
from ai import ai_routes
from intelligence import documents
from routers import chat_routes
from providers.lmstudio import LMStudioProvider

PATHS = ["/api/ai/chat", "/api/ai/chat/stream", "/chat"]
PRIVATE_TEXT = "Document-only private marker: 29e53f6d\r\nThe warranty lasts two years.\r\n"


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(node_id="host", node_name="Office", role="standalone", host_address=None))
    def forbidden(*args, **kwargs):
        pytest.fail("Document questions cannot reach actions, diagnostics, mesh, or implicit context")
    for target, names in [(ai_routes, ("_route_action_intent", "_tool_answer", "diagnostic_answer", "image_reply", "_find_mesh_ai_peer", "_should_prefer_mesh")),
                          (chat_routes, ("diagnostic_answer", "image_reply", "proxy_chat_to_host")),
                          (ai_routes.shared_context, ("build",)), (S, ("load_memory",))]:
        for name in names:
            monkeypatch.setattr(target, name, forbidden)


@pytest.fixture
def provider(monkeypatch):
    calls, probes = [], []
    manager = SimpleNamespace(ensure_running=lambda: probes.append("bundled") or True,
                              active_preset_id="standard", base_url="http://127.0.0.1:19999")
    monkeypatch.setattr(ai_routes.BundledAIManager, "get", lambda: manager)
    def complete(base, payload, **kwargs):
        calls.append(("bundled", payload))
        return {"model": "fixture-bundled", "choices": [{"message": {"content": "Two years [warranty.txt:L2-L2]."}}]}
    def stream(url, payload, **kwargs):
        calls.append(("bundled", payload))
        yield json.dumps({"choices": [{"delta": {"content": "Two years [warranty.txt:L2-L2]."}}]})
    monkeypatch.setattr(ai_routes, "_llama_post", complete)
    monkeypatch.setattr(ai_routes, "_llama_stream_raw", stream)
    monkeypatch.setattr(S.lm_provider, "health_check", lambda: probes.append("lmstudio") or True)
    monkeypatch.setattr(S.lm_provider, "complete", lambda **kw: calls.append(("lmstudio", kw)) or {"text": "Two years [warranty.txt:L2-L2].", "model": "fixture-lm"})
    return SimpleNamespace(calls=calls, probes=probes, manager=manager)


def body(**kwargs):
    return {"message": "How long is the warranty?", "documents": [{"name": "warranty.txt", "text": PRIVATE_TEXT}], **kwargs}


def events(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


def result(response, path):
    if not path.endswith("/stream"):
        return response.json()
    frames = events(response)
    assert frames[-1]["type"] == "done", frames
    combined = {}
    for frame in frames:
        if frame["type"] == "meta":
            combined.update(frame)
    return combined


@pytest.mark.parametrize("path", PATHS)
def test_selected_documents_are_numbered_reference_with_bounded_history(path, local_browser_client, provider):
    client = local_browser_client
    response = client.post(path, json=body(message="Turn off the lamp", device_id="requesting-browser", raw_input="Ignored hidden raw input"))
    assert response.status_code == 200, response.text
    data = result(response, path)
    assert data["handled_by"] == "documents"
    receipt = data["document_context"]
    normalized = PRIVATE_TEXT.replace("\r\n", "\n")
    assert receipt == {"documents": [{"name": "warranty.txt", "sha256": hashlib.sha256(normalized.encode()).hexdigest(), "line_count": 3, "chars": len(normalized)}], "actions_performed": False}
    assert provider.probes == ["bundled"] and len(provider.calls) == 1
    prompt = provider.calls[0][1]["messages"]
    assert "untrusted reference data" in prompt[0]["content"]
    assert "Do not invent citations" in prompt[0]["content"]
    reference = json.loads(prompt[1]["content"].split("\n", 1)[1])
    assert reference[0]["numbered_text"].endswith("L2: The warranty lasts two years.\nL3: ")
    assert prompt[-1] == {"role": "user", "content": "Turn off the lamp"}
    assert len(prompt) == 3 and "requesting-browser" not in str(prompt)
    assert not provider.calls[0][1].get("tools")
    saved = S.load_conversations()[data["conversation_id"]]
    assert saved["messages"][-1]["document_context"] == receipt
    assert "29e53f6d" not in json.dumps(saved)
    public = client.get("/api/ai/conversations/" + data["conversation_id"]).json()
    assert public["messages"][-1]["document_context"] == receipt
    assert "29e53f6d" not in json.dumps(public)


@pytest.mark.parametrize("path", PATHS)
def test_prior_history_is_not_added_to_document_question(path, client, provider):
    S.save_conversations({"prior": {"id": "prior", "user_id": "local", "messages": [{"role": "user", "content": "OLD-CONTEXT-MUST-NOT-BE-USED"}]}})
    response = client.post(path, json=body(conversation_id="prior"))
    assert response.status_code == 200
    assert "OLD-CONTEXT" not in str(provider.calls)


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("extra", [
    {"note_refs": [{"id": "missing", "revision": "a" * 64}]}, {"target_id": "device"}, {"diagnostic_id": "report"},
    {"image_b64": "abc"}, {"image_mime": "image/png"}, {"image_provider_key": "a" * 64},
    {"include_vault_secrets": True}, {"secret_keys": ["secret"]},
    {"message": "Use [vault:secret]"}, {"raw_input": "Use [VAULT:secret]"},
])
def test_mixed_context_rejected_before_any_probe(path, extra, client, provider):
    response = client.post(path, json=body(**extra))
    assert response.status_code == 422
    assert not provider.probes and not provider.calls and not S.load_conversations()


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("docs", [
    [{"name": "file.pdf", "text": "plain"}], [{"name": "C:\\file.txt", "text": "plain"}],
    [{"name": "../file.txt", "text": "plain"}], [{"name": "bad[name].md", "text": "plain"}],
    [{"name": "a\u202eb.txt", "text": "plain"}], [{"name": "file.txt", "text": "\x00binary"}],
    [{"name": "file.txt", "text": "\x1b[31mcontrol"}], [{"name": "file.txt", "text": "\x85control"}],
    [{"name": "file.txt", "text": " \n\t "}], [{"name": "x" * 118 + ".md", "text": "plain"}],
    [{"name": "same.txt", "text": "one"}, {"name": "SAME.TXT", "text": "two"}],
    [{"name": str(i) + ".txt", "text": "one"} for i in range(5)],
    [{"name": "file.txt", "text": "é" * 32769}],
    [{"name": "first.txt", "text": "a" * 32768}, {"name": "second.txt", "text": "b" * 32769}],
    [{"name": "file.txt", "text": "plain", "path": "C:\\secret"}],
])
def test_invalid_documents_never_reach_provider(path, docs, client, provider):
    response = client.post(path, json=body(documents=docs))
    assert response.status_code == 422, response.text
    assert not provider.probes and not provider.calls and not S.load_conversations()


def test_utf8_boundary_and_four_documents_are_not_truncated(client, provider):
    selected = [{"name": str(i) + ".MD", "text": "é" * 8192} for i in range(4)]
    response = client.post("/chat", json=body(documents=selected, brain="lmstudio"))
    assert response.status_code == 200
    coverage = [doc["coverage"] for doc in response.json()["document_context"]["documents"]]
    assert [item["mode"] for item in coverage] == ["full", "omitted", "omitted", "omitted"]
    reference = json.loads(provider.calls[-1][1]["messages"][1]["content"].split("\n", 1)[1])
    assert reference[0]["numbered_text"] == "L1: " + selected[0]["text"]
    assert all(doc["numbered_text"] == "" for doc in reference[1:])
    provider.calls.clear()
    selected = [{"name": str(i) + ".MD", "text": "é" * 1000} for i in range(4)]
    response = client.post("/chat", json=body(documents=selected, brain="lmstudio"))
    assert response.status_code == 200
    prompt = provider.calls[0][1]["messages"]
    reference = json.loads(prompt[1]["content"].split("\n", 1)[1])
    assert [doc["numbered_text"] for doc in reference] == ["L1: " + doc["text"] for doc in selected]
    assert len(response.json()["document_context"]["documents"]) == 4


@pytest.mark.parametrize("extra", [{"message": " "}, {"message": "é" * 4001}, {"max_tokens": 0}, {"max_tokens": 4097}, {"temperature": 3}])
def test_question_and_generation_limits_before_provider(extra, client, provider):
    assert client.post("/chat", json=body(**extra)).status_code == 422
    assert not provider.probes


def test_lone_surrogate_rejected_before_numbering():
    with pytest.raises(ValidationError, match="valid string"):
        ai_routes.ChatRequest(**body(documents=[{"name": "file.txt", "text": "\ud800"}]))


@pytest.mark.parametrize("path", PATHS)
def test_auth_required_and_conversation_owner_enforced(path, client, monkeypatch, provider):
    S.save_conversations({"other": {"id": "other", "user_id": "bob", "messages": []}})
    assert client.post(path, json=body(conversation_id="other")).status_code == 404
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    assert client.post(path, json=body()).status_code == 401
    assert not provider.probes


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("brain", ["mesh", "auto", "some-other-provider"])
def test_unsupported_provider_is_not_silently_substituted(path, brain, client, provider):
    assert client.post(path, json=body(brain=brain)).status_code == 409
    assert not provider.probes and not provider.calls


@pytest.mark.parametrize("path", PATHS)
def test_mesh_member_rejected_without_forwarding(path, client, provider, monkeypatch):
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(role="member", host_address="http://fixture-peer"))
    response = client.post(path, json=body())
    assert response.status_code == 409 and "mesh" in response.json()["detail"]
    assert not provider.probes


def test_explicit_lmstudio_and_wrong_route(client, provider):
    response = client.post("/chat", json=body(brain="lmstudio"))
    assert response.status_code == 200 and response.json()["brain_used"] == "lmstudio"
    assert provider.probes == [] and provider.calls[0][0] == "lmstudio"
    for path in PATHS[:2]:
        assert client.post(path, json=body(brain="lmstudio")).status_code == 409
    assert provider.probes == []


@pytest.mark.parametrize("path", PATHS)
def test_unavailable_bundled_does_not_fallback(path, client, provider):
    provider.manager.ensure_running = lambda: False
    response = client.post(path, json=body())
    if path.endswith("/stream"):
        frames = events(response)
        assert frames[-1]["type"] == "error" and "unavailable" in frames[-1]["detail"]
        assert not any(frame.get("document_context") for frame in frames)
    else:
        assert response.status_code == 409
    assert not provider.calls


@pytest.mark.parametrize("failure", ["unavailable", "exception", "empty"])
def test_lmstudio_failure_does_not_fallback_or_persist_receipt(failure, client, monkeypatch, provider):
    if failure == "unavailable":
        def unavailable(**kwargs):
            raise requests.ConnectionError("Synthetic provider unavailable")
        monkeypatch.setattr(S.lm_provider, "complete", unavailable)
    else:
        def fail(**kwargs):
            if failure == "exception":
                raise RuntimeError(PRIVATE_TEXT)
            return {"text": []}
        monkeypatch.setattr(S.lm_provider, "complete", fail)
    response = client.post("/chat", json=body(brain="lmstudio"))
    assert response.status_code in (502, 503)
    assert "29e53f6d" not in response.text
    assert not provider.calls and not S.load_conversations()


@pytest.mark.parametrize("path", ["/api/ai/chat", "/chat"])
@pytest.mark.parametrize("returned", [{}, {"choices": []}, {"choices": [{"message": {"content": []}}]}])
def test_bad_bundled_results_are_not_saved_as_success(path, returned, client, monkeypatch, provider):
    monkeypatch.setattr(ai_routes, "_llama_post", lambda *a, **kw: returned)
    assert client.post(path, json=body()).status_code == 502
    assert all(not c["messages"] for c in S.load_conversations().values())


@pytest.mark.parametrize("broken", ["{", json.dumps({"type": "error", "detail": PRIVATE_TEXT}), json.dumps({"error": PRIVATE_TEXT}), json.dumps({"choices": [{"delta": {"content": [1]}}]})])
def test_partial_stream_failure_has_no_success_receipt(broken, client, monkeypatch, provider):
    def stream(*args, **kwargs):
        yield json.dumps({"choices": [{"delta": {"content": "Partial answer"}}]})
        yield broken
    monkeypatch.setattr(ai_routes, "_llama_stream_raw", stream)
    response = client.post("/api/ai/chat/stream", json=body())
    frames = events(response)
    assert frames[-1]["type"] == "error"
    assert not any(frame.get("document_context") or frame["type"] == "done" for frame in frames)
    assert "29e53f6d" not in response.text
    assert all(not c["messages"] for c in S.load_conversations().values())


def test_cancelled_document_stream_does_not_save_receipt(provider):
    req = ai_routes.ChatRequest(**body())
    conv_id = ai_routes._get_or_create_conv(None, user_id="local")
    stream = ai_routes._document_stream(req, conv_id, documents.prepare("local", req))
    next(stream)  # metadata
    next(stream)  # partial content
    stream.close()
    assert not S.load_conversations()[conv_id]["messages"]


@pytest.mark.parametrize("path", ["/api/ai/chat", "/chat"])
def test_bundled_busy_remains_retryable(path, client, provider, monkeypatch):
    def busy(*args, **kwargs):
        raise HTTPException(409, "Generation busy")
    monkeypatch.setattr(ai_routes, "_llama_post", busy)
    response = client.post(path, json=body())
    assert response.status_code == 409 and "busy" in response.json()["detail"]
    assert all(not c["messages"] for c in S.load_conversations().values())


def test_receipt_sanitizer_never_keeps_inline_text():
    receipt = documents.prepare("local", ai_routes.ChatRequest(**body()))["document_context"]
    untrusted = {**receipt, "text": PRIVATE_TEXT, "documents": [{**receipt["documents"][0], "text": PRIVATE_TEXT, "path": "C:\\secret"}]}
    assert documents.public_receipt(untrusted) == receipt
    assert documents.public_receipt({**receipt, "actions_performed": True}) is None
    assert documents.public_receipt({**receipt, "documents": [{**receipt["documents"][0], "chars": True}]}) is None
    message = {"role": "assistant", "content": "Answer", "document_context": untrusted}
    assert ai_routes._public_conversation_turn(message)["document_context"] == receipt
    assert "document_context" not in ai_routes._public_conversation_turn({**message, "role": "user"})


def test_same_conversation_guard_covers_document_routes(client, provider, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    started, release = threading.Event(), threading.Event()
    def complete(*args, **kwargs):
        started.set()
        assert release.wait(5)
        return {"choices": [{"message": {"content": "Answer"}}]}
    monkeypatch.setattr(ai_routes, "_llama_post", complete)
    with ThreadPoolExecutor() as pool:
        first = pool.submit(client.post, "/api/ai/chat", json=body(conversation_id="same"))
        try:
            assert started.wait(5)
            response = client.post("/chat", json=body(conversation_id="same", brain="lmstudio"))
            assert response.status_code == 409
            assert provider.probes == ["bundled"]
        finally:
            release.set()
        assert first.result().status_code == 200
    assert len(S.load_conversations()["same"]["messages"]) == 2


def transport_response(status, payload, *, stream=False):
    response = requests.Response()
    response.status_code = status
    response.url = "http://selected-provider.invalid/v1/chat/completions"
    response.headers["Location"] = "https://unselected-provider.invalid/collect"
    response._content = (("data: " + json.dumps({"choices": [{"delta": {"content": "Answer"}}]}) + "\n\ndata: [DONE]\n\n")
                         if stream else json.dumps(payload)).encode()
    response._content_consumed = True
    return response


def install_real_transports(monkeypatch):
    manager = SimpleNamespace(ensure_running=lambda: True, generation=nullcontext,
                              active_preset_id="standard", base_url="http://selected-provider.invalid")
    monkeypatch.setattr(ai_routes.BundledAIManager, "get", lambda: manager)
    provider = LMStudioProvider("http://selected-provider.invalid/v1/chat/completions",
                                "http://selected-provider.invalid/v1/models")
    monkeypatch.setattr(provider, "health_check", lambda: True)
    monkeypatch.setattr(S, "lm_provider", provider)
    return provider


@pytest.mark.parametrize("path,brain", [("/api/ai/chat", "bundled"), ("/api/ai/chat/stream", "bundled"), ("/chat", "bundled"), ("/chat", "lmstudio")])
@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_document_transports_do_not_follow_redirects(path, brain, status, client, monkeypatch):
    install_real_transports(monkeypatch)
    sent = []
    def post(url, **kwargs):
        sent.append(url)
        assert "29e53f6d" in str(kwargs["json"]["messages"])
        # Synthetic requests redirect behavior: without the explicit option,
        # the document body would be sent to the unselected endpoint again.
        if kwargs.get("allow_redirects", True):
            sent.append("https://unselected-provider.invalid/collect")
            return transport_response(200, {"choices": [{"message": {"content": "Answer"}}]}, stream=kwargs.get("stream"))
        return transport_response(status, {"choices": [{"message": {"content": PRIVATE_TEXT}}]}, stream=kwargs.get("stream"))
    monkeypatch.setattr(requests, "post", post)
    response = client.post(path, json=body(brain=brain))
    assert sent == ["http://selected-provider.invalid/v1/chat/completions"]
    if path.endswith("/stream"):
        frames = events(response)
        assert frames[-1]["type"] == "error"
        assert not any(frame.get("document_context") or frame["type"] == "done" for frame in frames)
    else:
        assert response.status_code == 502 and not response.json().get("document_context")
    assert "29e53f6d" not in response.text
    assert all(not c["messages"] for c in S.load_conversations().values())


@pytest.mark.parametrize("content", [{"unexpected": "object"}, ["content"], 123, True, None])
def test_real_lmstudio_normalizer_cannot_turn_invalid_content_into_document_success(content, client, monkeypatch):
    install_real_transports(monkeypatch)
    sent = []
    def post(url, **kwargs):
        sent.append(url)
        return transport_response(200, {"choices": [{"message": {"content": content}}]})
    monkeypatch.setattr(requests, "post", post)
    response = client.post("/chat", json=body(brain="lmstudio"))
    assert response.status_code == 502 and not response.json().get("document_context")
    assert len(sent) == 1 and not S.load_conversations()


def test_document_lmstudio_real_normalizer_accepts_text(client, monkeypatch):
    install_real_transports(monkeypatch)
    monkeypatch.setattr(requests, "post", lambda *a, **kw: transport_response(200, {"choices": [{"message": {"content": "Two years [warranty.txt:L2-L2]."}}]}))
    response = client.post("/chat", json=body(brain="lmstudio"))
    assert response.status_code == 200 and response.json()["document_context"]["actions_performed"] is False


def test_ordinary_lmstudio_and_bundled_stream_keep_transport_defaults(monkeypatch):
    provider = install_real_transports(monkeypatch)
    options = []
    def post(url, **kwargs):
        options.append(kwargs)
        return transport_response(200, {"choices": [{"message": {"content": {"legacy": "value"}}}]}, stream=kwargs.get("stream"))
    monkeypatch.setattr(requests, "post", post)
    result = provider.complete(messages=[{"role": "user", "content": "Hi"}], model_id="fixture")
    assert result["text"] == "{'legacy': 'value'}"  # Existing normalizer semantics stay unchanged.
    chunks = list(ai_routes._llama_stream_raw("http://selected-provider.invalid/v1/chat/completions", {}))
    assert json.loads(chunks[0])["choices"][0]["delta"]["content"] == "Answer"
    assert all("allow_redirects" not in kwargs for kwargs in options)


def test_document_capability_check_requires_session(client, monkeypatch, provider):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    response = client.get("/api/ai/documents/capabilities")
    assert response.status_code == 401
    assert not provider.probes and not provider.calls and not S.load_conversations()


def test_document_capability_check_is_fresh_and_does_not_probe_inference(authed_client, provider):
    response = authed_client.get("/api/ai/documents/capabilities")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "protocol": "tli-document-questions-v1"}
    assert response.headers["cache-control"] == "no-store"
    assert not provider.probes and not provider.calls and not S.load_conversations()
