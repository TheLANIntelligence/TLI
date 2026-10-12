import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import re
import threading
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.responses import StreamingResponse
from starlette.requests import Request, ClientDisconnect
from fastapi.testclient import TestClient

from conversation_guard import exclusive_turn


@pytest.fixture
def conversation_store(tmp_path, monkeypatch):
    import tli_state as S
    from ai import ai_routes
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(S, "_CONV_KEY", b"c" * 32)
    monkeypatch.setattr(S, "_MEM_KEY", b"m" * 32)
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(node_id="host", node_name="Office", role="standalone"))
    monkeypatch.setattr(ai_routes, "_route_action_intent", lambda *a: None)
    monkeypatch.setattr(ai_routes, "_tool_answer", lambda *a: None)
    monkeypatch.setattr(ai_routes, "diagnostic_answer", lambda *a: None)
    monkeypatch.setattr(ai_routes, "_should_prefer_mesh", lambda: False)
    monkeypatch.setattr(ai_routes, "_build_system_prompt", lambda **kw: "Test system instructions")
    monkeypatch.setattr(ai_routes.shared_context, "build", lambda *a, **kw: {"text": "Reference", "categories": [], "host": {"id": "host", "name": "Office"}, "use_saved_memory": kw.get("use_saved_memory", True)})
    return S


def browser_request(owner="alice"):
    import tli_state as S
    token = S.create_session_token(owner)
    return Request({"type": "http", "scheme": "https", "server": ("192.168.1.20", 8000), "path": "/", "headers": [(b"cookie", ("tli_session=" + token).encode())]})


def fake_bundled(monkeypatch, chunks):
    from ai import ai_routes
    manager = SimpleNamespace(ensure_running=lambda: True, base_url="http://127.0.0.1:9988", active_preset_id="fake-bundled")
    monkeypatch.setattr(ai_routes.BundledAIManager, "get", lambda: manager)
    def stream(*args, **kwargs):
        assert kwargs.get("allow_redirects") is False
        return iter(chunks)
    monkeypatch.setattr(ai_routes, "_llama_stream_raw", stream)


def event(frame):
    return json.loads(frame.removeprefix("data: "))


def assert_public_turn(actual, expected, conversation_id, index, *, memory_status=None, history_status=None, budget_status=None, evidence_expected=None):
    """Public additions stay bounded and resolve the exact owned saved message."""
    from intelligence import chat_memory, context
    public = dict(actual)
    ref = public.pop("source_ref")
    assert set(ref) == {"conversation_id", "message_index", "revision"}
    assert ref["conversation_id"] == conversation_id and ref["message_index"] == index
    assert re.fullmatch(r"[a-f0-9]{64}", ref["revision"])
    assert chat_memory.preview("alice", ref)["text"] == expected["content"]
    if memory_status is not None:
        receipt = public.pop("memory_context")
        assert context.public_memory_receipt(receipt) == receipt
        assert receipt["status"] == memory_status
    if history_status is not None:
        receipt = public.pop("conversation_context")
        assert context.public_conversation_receipt(receipt) == receipt
        assert receipt["status"] == history_status
    if budget_status is not None:
        from intelligence import input_budget
        receipt = public.pop("input_budget")
        assert input_budget.public_receipt(receipt) == receipt
        assert receipt["capacity_status"] == budget_status
        assert receipt["provider"] == expected["provider"]
        assert receipt["model"] == expected["model"]
    if evidence_expected is not None:
        from intelligence import answer_evidence
        receipt = public.pop("evidence_context")
        assert answer_evidence.public_receipt(receipt) == receipt
        assert receipt == evidence_expected
    assert public == expected


def test_simultaneous_turns_are_rejected_across_entrypoints():
    from ai.ai_routes import ChatRequest
    entered, leave = threading.Event(), threading.Event()

    @exclusive_turn
    def phone(req):
        entered.set()
        assert leave.wait(5)
        return "finished"

    @exclusive_turn
    def desktop(req):
        return "finished"

    with ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(phone, ChatRequest(message="first", conversation_id="shared-test"))
        assert entered.wait(5)
        try:
            with pytest.raises(HTTPException) as error:
                desktop(ChatRequest(message="second", conversation_id="shared-test"))
            assert error.value.status_code == 409
        finally:
            leave.set()
        assert first.result() == "finished"
    assert desktop(ChatRequest(message="next", conversation_id="shared-test")) == "finished"


def test_interrupted_stream_releases_conversation():
    from ai.ai_routes import ChatRequest

    @exclusive_turn
    def endpoint(req):
        return StreamingResponse(iter(["first", "second"]))

    async def exercise():
        response = endpoint(ChatRequest(message="first", conversation_id="stream-test"))
        await anext(response.body_iterator)
        with pytest.raises(HTTPException):
            endpoint(ChatRequest(message="overlap", conversation_id="stream-test"))
        await response.body_iterator.aclose()
        again = endpoint(ChatRequest(message="next", conversation_id="stream-test"))
        await again.background()
    asyncio.run(exercise())


def test_failed_turn_releases_conversation():
    from ai.ai_routes import ChatRequest

    @exclusive_turn
    def endpoint(req):
        raise HTTPException(503, "Model unavailable")

    for _ in range(2):
        with pytest.raises(HTTPException) as error:
            endpoint(ChatRequest(message="test", conversation_id="failure-test"))
        assert error.value.status_code == 503


def test_phone_and_desktop_conversation_writes_do_not_lose_turns(monkeypatch):
    import tli_state as S
    from ai import ai_routes
    from routers import chat_routes
    store = {}
    monkeypatch.setattr(S, "load_conversations", lambda: json.loads(json.dumps(store)))
    def save(value):
        store.clear()
        store.update(json.loads(json.dumps(value)))
    monkeypatch.setattr(S, "save_conversations", save)
    def phone(i):
        ident = ai_routes._get_or_create_conv(f"phone-{i}", user_id="local")
        ai_routes._save_turn(ident, "user", f"Phone {i}")
    def desktop(i):
        req = chat_routes.ChatRequest(message=f"Desktop {i}", user_id="local", conversation_id=f"desktop-{i}")
        chat_routes._save_chat_turn(req, "Reply", "test-model")
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(fn, i) for i in range(30) for fn in (phone, desktop)]
        for future in futures:
            future.result()
    assert len(store) == 60
    assert sum(len(c["messages"]) for c in store.values()) == 90


def test_retired_unsigned_mesh_stream_never_sends_or_persists(conversation_store, monkeypatch):
    from ai import ai_routes
    ai_routes._get_or_create_conv("mesh-test", user_id="alice")
    monkeypatch.setattr(ai_routes.requests, "post", lambda *a, **kw: pytest.fail("Unsigned peer transport must not run"))
    frames = [event(frame) for frame in ai_routes._stream_via_mesh_peer(
        {"ip": "192.168.1.5", "port": 8000}, "Question", "mesh-test", 100, .2)]
    assert [frame["type"] for frame in frames] == ["error"]
    assert "retired" in frames[0]["detail"]
    assert conversation_store.load_conversations()["mesh-test"]["messages"] == []


def test_late_background_cleanup_cannot_release_a_new_turn():
    from ai.ai_routes import ChatRequest

    @exclusive_turn
    def endpoint(req):
        return StreamingResponse(iter(["reply"]))

    async def exercise():
        first = endpoint(ChatRequest(message="first", conversation_id="late-cleanup"))
        assert [chunk async for chunk in first.body_iterator] == ["reply"]
        second = endpoint(ChatRequest(message="second", conversation_id="late-cleanup"))
        await first.background()
        try:
            with pytest.raises(HTTPException) as error:
                endpoint(ChatRequest(message="third", conversation_id="late-cleanup"))
            assert error.value.status_code == 409
        finally:
            await second.background()
    asyncio.run(exercise())


def test_disconnect_before_headers_releases_lease_and_preserves_response():
    from ai.ai_routes import ChatRequest

    @exclusive_turn
    def endpoint(req):
        return StreamingResponse(iter(["reply"]), status_code=202, media_type="text/event-stream", headers={"X-Test": "preserved"})

    async def exercise():
        response = endpoint(ChatRequest(message="first", conversation_id="early-disconnect"))
        assert response.status_code == 202 and response.headers["x-test"] == "preserved"
        assert response.media_type == "text/event-stream"
        async def receive():
            return {"type": "http.disconnect"}
        async def send(message):
            raise OSError("Connection closed before headers")
        with pytest.raises(ClientDisconnect):
            await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
        next_response = endpoint(ChatRequest(message="next", conversation_id="early-disconnect"))
        await next_response.background()
    asyncio.run(exercise())


def test_async_iterator_without_aclose_and_background_exception_release():
    from ai.ai_routes import ChatRequest
    from starlette.background import BackgroundTask

    class Content:
        def __aiter__(self): return self
        async def __anext__(self): raise StopAsyncIteration

    async def broken_background():
        raise RuntimeError("Background failure")

    @exclusive_turn
    def endpoint(req):
        return StreamingResponse(Content(), background=BackgroundTask(broken_background))

    async def exercise():
        response = endpoint(ChatRequest(message="first", conversation_id="async-content"))
        assert [chunk async for chunk in response.body_iterator] == []
        with pytest.raises(RuntimeError, match="Background failure"):
            await response.background()
        following = endpoint(ChatRequest(message="next", conversation_id="async-content"))
        with pytest.raises(RuntimeError):
            await following.background()
    asyncio.run(exercise())


def test_real_bundled_stream_persists_assistant_before_done(conversation_store, monkeypatch):
    from ai import ai_routes
    S = conversation_store
    fake_bundled(monkeypatch, [json.dumps({"choices": [{"delta": {"content": text}}]}) for text in ("A ", "complete reply")])
    ident = ai_routes._get_or_create_conv("actual-bundled", user_id="alice")
    stream = ai_routes._stream_response(browser_request(), "Question", ident, "phone-1", 100, .2)
    frames = []
    for frame in stream:
        frames.append(event(frame))
        if frames[-1]["type"] == "done":
            saved = S.load_conversations()[ident]
            assert saved["user_id"] == "alice"
            assert [(m["role"], m["content"]) for m in saved["messages"]] == [("user", "Question"), ("assistant", "A complete reply")]
            assert saved["messages"][-1]["provider"] == "bundled"
            assert saved["messages"][-1]["model"] == "fake-bundled"
            assert saved["messages"][-1]["host"]["name"] == "Office"
            stream.close()  # exactly what a phone may do on the done event
            break
    else:
        pytest.fail("No done event")
    assert frames[0]["type"] == "meta" and frames[0]["session_id"] == ident


def test_provider_error_after_partial_stream_never_persists_as_complete(conversation_store, monkeypatch):
    from ai import ai_routes
    fake_bundled(monkeypatch, [json.dumps({"choices": [{"delta": {"content": "Partial"}}]}), json.dumps({"type": "error", "detail": "Provider lost"})])
    ident = ai_routes._get_or_create_conv("partial-error", user_id="alice")
    frames = [event(frame) for frame in ai_routes._stream_response(browser_request(), "Question", ident, "phone", 100, .2)]
    assert frames[-1] == {"type": "error", "detail": "Provider lost"}
    assert not any(frame["type"] == "done" for frame in frames)
    assert [m["role"] for m in conversation_store.load_conversations()[ident]["messages"]] == ["user"]


def test_cancel_real_stream_releases_lease_without_inventing_a_reply(conversation_store, monkeypatch):
    from ai import ai_routes
    fake_bundled(monkeypatch, [json.dumps({"choices": [{"delta": {"content": text}}]}) for text in ("Partial", " final")])
    request = browser_request()

    async def exercise():
        response = ai_routes.ai_chat_stream_post(request, ai_routes.ChatRequest(message="Question", conversation_id="cancel-real"))
        assert event(await anext(response.body_iterator))["type"] == "meta"
        assert event(await anext(response.body_iterator))["type"] == "delta"
        await response.body_iterator.aclose()
        assert [m["role"] for m in conversation_store.load_conversations()["cancel-real"]["messages"]] == ["user"]
        following = ai_routes.ai_chat_stream_post(request, ai_routes.ChatRequest(message="Next", conversation_id="cancel-real"))
        await following.background()
    asyncio.run(exercise())


def test_http_desktop_json_and_phone_stream_reject_overlapping_turns(app, conversation_store, monkeypatch):
    import companion_auth as auth
    from ai import ai_routes
    from routers import chat_routes
    S = conversation_store
    origin = "https://192.168.1.20:8000"
    token, _ = auth.create_pairing("alice", origin, "f" * 64)
    device = auth.redeem_pairing(token, origin, "f" * 64, "Phone", "ios")
    phone_headers = {"Authorization": "Bearer " + device["credential"]}
    desktop_headers = {"Cookie": "tli_session=" + S.create_session_token("alice")}
    entered, leave = threading.Event(), threading.Event()
    model_calls = []

    def complete(**kwargs):
        model_calls.append(kwargs)
        entered.set()
        assert leave.wait(5)
        return {"text": "Desktop reply", "model": "fake-lmstudio"}

    monkeypatch.setattr(S, "lm_provider", SimpleNamespace(health_check=lambda: True, complete=complete))
    monkeypatch.setattr(chat_routes, "diagnostic_answer", lambda *a: None)
    monkeypatch.setattr(chat_routes, "choose_model", lambda *a: {"id": "fake-lmstudio"})
    monkeypatch.setattr(chat_routes, "build_messages", lambda req, *a, **kw: [{"role": "user", "content": req.message}])
    fake_bundled(monkeypatch, [json.dumps({"choices": [{"delta": {"content": "Phone reply"}}]})])
    desktop = TestClient(app, base_url=origin)
    phone = TestClient(app, base_url=origin)
    body = {"message": "Desktop question", "conversation_id": "shared-http", "brain": "lmstudio"}
    with ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(desktop.post, "/chat", json=body, headers=desktop_headers)
        assert entered.wait(5)
        try:
            overlap = phone.post("/api/ai/chat/stream", json={"message": "Phone overlap", "conversation_id": "shared-http"}, headers=phone_headers)
            assert overlap.status_code == 409
        finally:
            leave.set()
        assert first.result().status_code == 200
    next_turn = phone.post("/api/ai/chat/stream", json={"message": "Phone question", "conversation_id": "shared-http"}, headers=phone_headers)
    assert next_turn.status_code == 200 and '"done"' in next_turn.text
    conversation = S.load_conversations()["shared-http"]
    assert conversation["user_id"] == "alice"
    assert [m["content"] for m in conversation["messages"]] == ["Desktop question", "Desktop reply", "Phone question", "Phone reply"]
    assert len(model_calls) == 1


@pytest.mark.parametrize("path", ["/api/ai/chat/stream", "/api/ai/chat", "/chat"])
def test_image_request_keeps_owner_provider_and_private_context(app, conversation_store, monkeypatch, path):
    from ai import ai_routes
    from routers import chat_routes
    S = conversation_store
    captured = []
    def image_reply(*args, screenshot=None, image_provider_key=None, use_saved_memory=True, authorize=None):
        assert callable(authorize)
        authorize()
        assert screenshot is None and image_provider_key is None
        assert use_saved_memory is True
        captured.append(args)
        return {"reply": "A scene", "provider": "lmstudio", "model": "vision-model", "context_categories": ["memory"], "host": {"id": "host", "name": "Office"}, "retained_image": None}
    monkeypatch.setattr(ai_routes, "image_reply", image_reply)
    monkeypatch.setattr(chat_routes, "image_reply", image_reply)
    client = TestClient(app, base_url="https://192.168.1.20:8000")
    headers = {"Cookie": "tli_session=" + S.create_session_token("alice")}
    body = {"message": "Describe", "conversation_id": "photo-private", "device_id": "phone-7", "image_b64": "cGljdHVyZQ==", "image_mime": "image/jpeg", "target_id": "lamp", "diagnostic_id": "alice-report", "retention_days": 0}
    result = client.post(path, json=body, headers=headers)
    assert result.status_code == 200, result.text
    assert captured[0][:8] == ("alice", "Describe", "cGljdHVyZQ==", "image/jpeg", "lamp", "alice-report", "phone-7", 0)
    conversation = S.load_conversations()["photo-private"]
    assert conversation["user_id"] == "alice" and conversation["device_id"] == "phone-7"
    assert conversation["messages"][-1]["content"] == "A scene"
    assert "cGljdHVyZQ==" not in json.dumps(conversation)
    assert "lmstudio" in result.text
    reopened = client.get("/api/ai/conversations/photo-private", headers=headers)
    assert reopened.status_code == 200
    assert_public_turn(reopened.json()["messages"][-1],
        {"role": "assistant", "content": "A scene", "provider": "lmstudio", "model": "vision-model", "host": "Office"},
        "photo-private", 1)
    foreign = client.post(path, json={**body, "image_b64": None}, headers={"Cookie": "tli_session=" + S.create_session_token("bob")})
    assert foreign.status_code == 404


def test_bootstrap_does_not_select_transport_from_mesh_advertisements(tmp_path, monkeypatch):
    import tli_state as S
    from ai import ai_routes
    from routers import companion_routes
    from fastapi import Response
    manager = SimpleNamespace(cfg=SimpleNamespace(model_path=tmp_path / "missing.gguf"), is_healthy=lambda: False)
    monkeypatch.setattr(ai_routes.BundledAIManager, "get", lambda: manager)
    monkeypatch.setattr(ai_routes, "_find_mesh_ai_peer", lambda: pytest.fail("Bootstrap probed the mesh"))
    monkeypatch.setattr(ai_routes, "_MESH_CACHE", {"ts": 0, "peers": []})
    monkeypatch.setattr(companion_routes.models, "image_provider", lambda: (_ for _ in ()).throw(HTTPException(409, "Unavailable")))
    monkeypatch.setattr(companion_routes, "_node", lambda: {"id": "host", "name": "Office"})
    now = time.time()
    entries = {"peer": {"ip": "192.168.1.25", "status": "allowed", "ai_healthy": True,
                        "ai_observed_at": datetime.fromtimestamp(now, timezone.utc).isoformat()}}
    monkeypatch.setattr(S, "load_mesh_directory", lambda: entries)
    assert companion_routes.bootstrap(Response(), "alice")["chat"]["streaming"] is False
    entries["peer"]["ai_observed_at"] = datetime.fromtimestamp(now - companion_routes.AI_ADVERTISEMENT_TTL - 5, timezone.utc).isoformat()
    assert companion_routes.bootstrap(Response(), "alice")["chat"]["streaming"] is False
    monkeypatch.setattr(ai_routes, "_MESH_CACHE", {"ts": now - ai_routes._MESH_CACHE_TTL - 5, "peers": [{"ip": "192.168.1.25"}]})
    assert companion_routes.bootstrap(Response(), "alice")["chat"]["streaming"] is False
    manager.cfg.model_path.write_bytes(b"test model presence; never loaded")
    assert companion_routes.bootstrap(Response(), "alice")["chat"]["streaming"] is True


def test_lan_probe_retains_observed_capabilities_without_fabricating_health(monkeypatch):
    import lan_discovery
    import tli_state as S
    from ai import ai_routes
    from routers import companion_routes
    directory = {}
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(node_id="self"))
    monkeypatch.setattr(S, "load_mesh_directory", lambda: directory)
    monkeypatch.setattr(S, "save_mesh_directory", lambda value: None)
    monkeypatch.setattr(ai_routes, "_MESH_CACHE", {"ts": 0, "peers": []})
    lan_discovery._upsert_peer("peer", "Office", "192.168.1.25", 8000, {"has_ai": True, "ai_healthy": True})
    entry = directory["peer"]
    assert entry["status"] == "pending"
    assert entry["discovery"]["has_ai"] is True
    assert entry["discovery"]["ai_healthy"] is True
    assert entry["discovery"]["verified"] is False
    assert datetime.fromisoformat(entry["discovery"]["observed_at"].replace("Z", "+00:00")).tzinfo
    assert not {"has_ai", "ai_healthy", "ai_observed_at"}.intersection(entry)
    assert companion_routes._recent_mesh_ai() is False
    lan_discovery._upsert_peer("peer", "Office", "192.168.1.25", 8000, {"has_ai": True, "ai_healthy": False})
    assert entry["discovery"]["has_ai"] is True and entry["discovery"]["ai_healthy"] is False
    assert entry["discovery"]["verified"] is False
    assert not {"has_ai", "ai_healthy", "ai_observed_at"}.intersection(entry)
    assert companion_routes._recent_mesh_ai() is False
    lan_discovery._upsert_peer("peer", "Office", "192.168.1.25", 8000)
    assert not {"has_ai", "ai_healthy"}.intersection(entry["discovery"])
    assert entry["discovery"]["verified"] is False
    assert companion_routes._recent_mesh_ai() is False


@pytest.mark.parametrize(("method", "path", "body"), [
    ("delete", "/conversations/delete-active", None),
    ("delete", "/api/ai/conversations", None),
    ("post", "/api/ai/clear-session", {"session_id": "delete-active"}),
])
def test_delete_routes_cannot_erase_an_active_reply(app, conversation_store, monkeypatch, method, path, body):
    from ai import ai_routes
    S = conversation_store
    fake_bundled(monkeypatch, [json.dumps({"choices": [{"delta": {"content": "Saved reply"}}]})])
    request = browser_request()
    client = TestClient(app, base_url="https://192.168.1.20:8000")
    headers = {"Cookie": "tli_session=" + S.create_session_token("alice")}

    async def exercise():
        response = ai_routes.ai_chat_stream_post(request, ai_routes.ChatRequest(message="Question", conversation_id="delete-active"))
        assert event(await anext(response.body_iterator))["type"] == "meta"
        try:
            rejected = client.request(method, path, json=body, headers=headers)
            assert rejected.status_code == 409, rejected.text
            assert "delete-active" in S.load_conversations()
            frames = [event(chunk) async for chunk in response.body_iterator]
            assert frames[-1]["type"] == "done"
            assert S.load_conversations()["delete-active"]["messages"][-1]["content"] == "Saved reply"
        finally:
            await response.background()
        accepted = client.request(method, path, json=body, headers=headers)
        assert accepted.status_code == 200
        assert "delete-active" not in S.load_conversations()
    asyncio.run(exercise())


@pytest.mark.parametrize("local_available", [True, False])
def test_retired_mesh_proxy_cannot_forward_even_with_legacy_preference(app, conversation_store, monkeypatch, local_available):
    from ai import ai_routes
    S = conversation_store
    manager = SimpleNamespace(ensure_running=lambda: local_available, base_url="http://127.0.0.1:9988", active_preset_id="fake")
    monkeypatch.setattr(ai_routes.BundledAIManager, "get", lambda: manager)
    monkeypatch.setattr(ai_routes, "_should_prefer_mesh", lambda: True)
    monkeypatch.setattr(ai_routes, "_find_mesh_ai_peer", lambda: {"ip": "192.168.1.25", "port": 8000, "node_name": "Peer"})
    monkeypatch.setattr(ai_routes.requests, "post", lambda *a, **kw: pytest.fail("Unsigned peer transport must not run"))
    client = TestClient(app, base_url="https://192.168.1.20:8000")
    headers = {"Cookie": "tli_session=" + S.create_session_token("alice")}
    result = client.post("/api/ai/chat", json={"message": "Question", "conversation_id": "local-mesh", "device_id": "phone"}, headers=headers)
    assert result.status_code == 410 and "retired" in result.text
    saved = S.load_conversations()["local-mesh"]
    assert saved["user_id"] == "alice" and saved["device_id"] == "phone"
    assert saved["messages"] == []


def test_cancelled_asgi_task_releases_stream_lease():
    from ai.ai_routes import ChatRequest
    started = None
    cleaned = []

    async def content():
        try:
            started.set()
            await asyncio.Event().wait()
            yield "unreachable"
        finally:
            cleaned.append(True)

    @exclusive_turn
    def endpoint(req):
        return StreamingResponse(content())

    async def exercise():
        nonlocal started
        started = asyncio.Event()
        response = endpoint(ChatRequest(message="Question", conversation_id="cancel-asgi"))
        async def receive(): return {"type": "http.request", "body": b""}
        async def send(message): pass
        task = asyncio.create_task(response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert cleaned == [True]
        next_response = endpoint(ChatRequest(message="Next", conversation_id="cancel-asgi"))
        await next_response.background()
    asyncio.run(exercise())


def test_lmstudio_followup_provider_receives_owned_photo_history_once(app, conversation_store, monkeypatch):
    from routers import chat_routes
    S = conversation_store
    S.save_conversations({"photo-followup": {"id": "photo-followup", "user_id": "alice", "messages": [
        {"role": "user", "content": "What is in this picture?"},
        {"role": "assistant", "content": "The printer display shows a paper jam.", "provider": "vision"},
        {"role": "system", "content": "UNTRUSTED SAVED ROLE"},
    ]}})
    captured = []
    def complete(**kwargs):
        captured.append(kwargs["messages"])
        return {"text": "Open the paper tray.", "model": "fake-lmstudio"}
    monkeypatch.setattr(S, "lm_provider", SimpleNamespace(health_check=lambda: True, complete=complete))
    monkeypatch.setattr(chat_routes, "diagnostic_answer", lambda *a: None)
    monkeypatch.setattr(chat_routes, "choose_model", lambda *a: {"id": "fake-lmstudio"})
    monkeypatch.setattr(chat_routes, "build_system_prompt", lambda *a, **kw: "PRIMARY INSTRUCTIONS")
    client = TestClient(app, base_url="https://192.168.1.20:8000")
    body = {"message": "How do I fix that?", "conversation_id": "photo-followup", "brain": "lmstudio", "user_id": "bob"}
    result = client.post("/chat", json=body, headers={"Cookie": "tli_session=" + S.create_session_token("alice")})
    assert result.status_code == 200, result.text
    messages = captured[0]
    assert [message for message in messages if message["role"] == "system"] == [
        {"role": "system", "content": "PRIMARY INSTRUCTIONS"}, {"role": "system", "content": "Reference"}]
    assert [message for message in messages if message["role"] != "system"] == [
        {"role": "user", "content": "What is in this picture?"},
        {"role": "assistant", "content": "The printer display shows a paper jam."},
        {"role": "user", "content": "How do I fix that?"},
    ]
    assert sum(m["content"] == body["message"] for m in messages) == 1
    assert sum(len(m["content"]) for m in messages) <= 12000
    # The unsupported saved system turn remains a pairing barrier and is
    # counted as omitted; it cannot become a provider instruction or silently
    # disappear from the coverage receipt. The complete photo pair survives.
    history_receipt = result.json()["conversation_context"]
    assert history_receipt["included_messages"] == 2
    assert history_receipt["included_exchanges"] == 1
    assert history_receipt["omitted_messages"] == 1
    assert "UNTRUSTED SAVED ROLE" not in str(messages)
    assert S.load_conversations()["photo-followup"]["messages"][2] == {"role": "system", "content": "UNTRUSTED SAVED ROLE"}
    reopened = client.get("/api/ai/conversations/photo-followup", headers={"Cookie": "tli_session=" + S.create_session_token("alice")})
    assert_public_turn(reopened.json()["messages"][-1],
        {"role": "assistant", "content": "Open the paper tray.", "provider": "lmstudio", "model": "fake-lmstudio", "host": "Office"},
        "photo-followup", 4, memory_status="unknown", history_status="limited", budget_status="unknown",
        evidence_expected={"version": 1, "interpretation": "ai", "sources": [],
                           "historical_notes": {"checked": False, "changed": 0, "unavailable": 0},
                           "citations_checked": True, "citations": [], "invalid_citations": 0})
    foreign = client.post("/chat", json=body, headers={"Cookie": "tli_session=" + S.create_session_token("bob")})
    assert foreign.status_code == 404 and len(captured) == 1


def test_conversation_provenance_whitelist_does_not_invent_legacy_values(app, conversation_store):
    S = conversation_store
    S.save_conversations({"legacy": {"id": "legacy", "user_id": "alice", "messages": [
        {"role": "assistant", "content": "Old reply", "image_b64": "private-image", "trace": "private-trace"},
        {"role": "assistant", "content": "Known reply", "provider": "bundled", "model": "vision", "host": {"id": "secret-node-id", "name": "Office"}, "internal": "secret"},
    ]}})
    client = TestClient(app, base_url="https://192.168.1.20:8000")
    result = client.get("/api/ai/conversations/legacy", headers={"Cookie": "tli_session=" + S.create_session_token("alice")})
    messages = result.json()["messages"]
    assert len(messages) == 2
    assert_public_turn(messages[0], {"role": "assistant", "content": "Old reply"}, "legacy", 0)
    assert_public_turn(messages[1],
        {"role": "assistant", "content": "Known reply", "provider": "bundled", "model": "vision", "host": "Office"},
        "legacy", 1)
    assert not any(key in messages[0] for key in ("provider", "model", "host", "memory_context", "conversation_context"))
    assert not any(secret in result.text for secret in ("private-image", "private-trace", "secret-node-id", "internal"))


@pytest.mark.parametrize("brain", ["lmstudio", "bundled"])
def test_chat_storage_failure_does_not_report_success_or_retry_provider(app, conversation_store, monkeypatch, brain):
    from contextlib import nullcontext
    from routers import chat_routes
    S = conversation_store
    calls = []
    def fail_save(value):
        raise OSError("disk full")
    monkeypatch.setattr(S, "save_conversations", fail_save)
    monkeypatch.setattr(chat_routes, "diagnostic_answer", lambda *a: None)
    monkeypatch.setattr(chat_routes, "choose_model", lambda *a: {"id": "fake-model"})
    monkeypatch.setattr(chat_routes, "build_system_prompt", lambda *a, **kw: "PRIMARY")
    def complete(**kwargs):
        calls.append("lmstudio")
        return {"text": "Reply", "model": "fake-model"}
    monkeypatch.setattr(S, "lm_provider", SimpleNamespace(health_check=lambda: True, complete=complete))
    manager = SimpleNamespace(ensure_running=lambda: True, base_url="http://127.0.0.1:9999", active_preset_id="fake", generation=lambda: nullcontext())
    monkeypatch.setattr(chat_routes.BundledAIManager, "get", lambda: manager)
    def bundled_post(*args, **kwargs):
        calls.append("bundled")
        return SimpleNamespace(status_code=200, json=lambda: {"choices": [{"message": {"content": "Reply"}}]})
    monkeypatch.setattr(chat_routes.requests, "post", bundled_post)
    client = TestClient(app, base_url="https://192.168.1.20:8000")
    result = client.post("/chat", json={"message": "Question", "brain": brain}, headers={"Cookie": "tli_session=" + S.create_session_token("alice")})
    assert result.status_code == 503
    assert "could not be saved" in result.json()["detail"]
    assert calls == [brain]


@pytest.mark.parametrize("completed", [True, False])
def test_bundled_provider_eof_requires_terminal_marker(conversation_store, monkeypatch, completed):
    from contextlib import nullcontext
    from ai import ai_routes
    S = conversation_store
    manager = SimpleNamespace(ensure_running=lambda: True, base_url="http://127.0.0.1:9999", active_preset_id="fake", generation=lambda: nullcontext())
    monkeypatch.setattr(ai_routes.BundledAIManager, "get", lambda: manager)
    class Reply:
        ok = True
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def iter_lines(self, **kwargs):
            lines = ['data: {"choices":[{"delta":{"content":"A reply"}}]}']
            if completed:
                lines.append("data: [DONE]")
            return iter(lines)
        status_code = 200
    monkeypatch.setattr(ai_routes.requests, "post", lambda *a, **kw: Reply())
    ident = ai_routes._get_or_create_conv("upstream-eof", user_id="alice")
    frames = [event(frame) for frame in ai_routes._stream_response(browser_request(), "Question", ident, "phone", 100, .2)]
    assert frames[-1]["type"] == ("done" if completed else "error")
    roles = [m["role"] for m in S.load_conversations()[ident]["messages"]]
    assert roles == (["user", "assistant"] if completed else ["user"])


@pytest.mark.parametrize("proxy_status", [200, 503])
def test_legacy_member_proxy_persists_locally_or_fails_without_replay(app, conversation_store, monkeypatch, proxy_status):
    from routers import chat_routes
    S = conversation_store
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(node_id="member", node_name="Office", role="member", host_address="https://192.168.1.25:8000"))
    monkeypatch.setattr(chat_routes, "diagnostic_answer", lambda *a: None)
    monkeypatch.setattr(chat_routes, "choose_model", lambda *a: pytest.fail("Proxied submission was replayed locally"))
    calls = []
    def post(url, **kwargs):
        calls.append((url, kwargs["json"]))
        return SimpleNamespace(status_code=proxy_status, json=lambda: {
            "reply": "Host reply", "conversation_id": "remote-owned-id", "model_used": "host-model",
            "brain_used": "lmstudio", "timestamp": "2026-09-06T12:00:00Z",
        })
    monkeypatch.setattr(chat_routes.requests, "post", post)
    client = TestClient(app, base_url="https://192.168.1.20:8000")
    headers = {"Cookie": "tli_session=" + S.create_session_token("alice")}
    response = client.post("/chat", json={"message": "Question", "conversation_id": "member-local", "device_id": "phone"}, headers=headers)
    assert len(calls) == 1
    assert calls[0][0] == "https://192.168.1.25:8000/chat"
    if proxy_status != 200:
        assert response.status_code == 502
        assert "member-local" not in S.load_conversations()
        return
    assert response.status_code == 200, response.text
    assert response.json()["conversation_id"] == "member-local"
    assert response.json()["brain_used"] == "mesh" and response.json()["model_used"] == "host-model"
    saved = S.load_conversations()["member-local"]
    assert saved["user_id"] == "alice" and saved["device_id"] == "phone"
    assert [m["content"] for m in saved["messages"]] == ["Question", "Host reply"]
    reopened = client.get("/api/ai/conversations/member-local", headers=headers).json()
    assert_public_turn(reopened["messages"][-1],
        {"role": "assistant", "content": "Host reply", "provider": "mesh", "model": "host-model", "host": "https://192.168.1.25:8000"},
        "member-local", 1, memory_status="unknown", history_status="unknown")
    assert "remote-owned-id" not in S.load_conversations()
