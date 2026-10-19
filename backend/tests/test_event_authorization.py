"""Browser-only host feed with real sessions and synthetic async event queues."""
from __future__ import annotations

import asyncio
import json
import time
from collections import deque

import pytest
from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect

import event_bus as bus
import tli_state as S
from browser_authority import browser_control_access


LOCAL = "http://localhost:8000"
REMOTE = "https://tli.test:8000"
PRIVATE = "Synthetic private device event"
TERMINAL = {"type": "auth_required", "code": "session_changed"}


@pytest.fixture(autouse=True)
def isolated_events(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "tli_pin.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(bus, "_events", deque(maxlen=bus.MAX_EVENTS))
    monkeypatch.setattr(bus, "_subscribers", [])
    monkeypatch.setattr(bus, "_post_emit_hooks", [])
    monkeypatch.setattr(bus, "_loop", None)
    monkeypatch.setattr(bus, "_journal", None)
    monkeypatch.setattr(bus, "_sequence", 0)
    monkeypatch.setattr(bus, "AUTH_CHECK_SECONDS", 0.01)
    monkeypatch.setattr(bus, "KEEPALIVE_SECONDS", 0.03)


def app():
    value = FastAPI()
    value.include_router(bus.router)
    assert not value.dependency_overrides
    return value


def enable_pin():
    S.save_pin_config("a" * 64, "b" * 64)
    return S.create_session_token("owner")


def cookie(token):
    return {"Cookie": "tli_session=" + token}


def emit(title=PRIVATE):
    bus.emit_event("device", "info", title, "Synthetic private details", node="Fixture room")


def event(frame):
    if isinstance(frame, bytes):
        frame = frame.decode()
    return json.loads(frame.removeprefix("data: ").strip())


def stream_request(token=None, *, disconnected=None):
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
        "method": "GET", "scheme": "https", "path": "/api/events/stream",
        "raw_path": b"/api/events/stream", "query_string": b"", "root_path": "",
        "server": ("tli.test", 8000), "client": ("192.168.1.9", 41000),
        "headers": [(b"host", b"tli.test:8000")],
    }
    if token:
        scope["headers"].append((b"cookie", ("tli_session=" + token).encode()))
    request = Request(scope)
    state = disconnected if disconnected is not None else {"value": False}

    async def is_disconnected():
        return state["value"]

    request.is_disconnected = is_disconnected
    return request


async def response_for(token, *, disconnected=None):
    request = stream_request(token, disconnected=disconnected)
    check = browser_control_access(request, Response())
    return await bus.events_stream(request, check=check)


async def subscribed():
    async def wait():
        while not bus._subscribers:
            await asyncio.sleep(0)
        return bus._subscribers[0]
    return await asyncio.wait_for(wait(), 0.5)


@pytest.mark.parametrize("path", ("/api/events/recent", "/api/events/stream"))
@pytest.mark.parametrize("origin,client_host,pin,credential,extra", [
    (REMOTE, "192.168.1.9", True, None, {}),
    (REMOTE, "192.168.1.9", True, "revoked", {}),
    (REMOTE, "192.168.1.9", True, "expired", {}),
    (LOCAL, "127.0.0.1", False, "revoked", {}),
    (REMOTE, "192.168.1.9", False, None, {}),
    (LOCAL, "192.168.1.9", False, None, {}),
    ("http://attacker.test:8000", "127.0.0.1", False, None, {}),
    ("http://tli.test:8000", "192.168.1.9", True, "valid", {}),
    (REMOTE, "192.168.1.9", True, "valid", {"Authorization": "Bearer synthetic"}),
    (REMOTE, "192.168.1.9", True, "valid", {"X-TLI-Peer-Id": "peer"}),
    (REMOTE, "192.168.1.9", True, "valid", {"Forwarded": "for=127.0.0.1"}),
    (REMOTE, "192.168.1.9", True, "valid", {"X-Forwarded-For": "127.0.0.1"}),
    (REMOTE, "192.168.1.9", True, "valid", {"Sec-Fetch-Site": "same-site"}),
    (REMOTE, "192.168.1.9", True, "valid", {"Sec-Fetch-Site": "cross-site"}),
    (REMOTE, "192.168.1.9", True, "valid", {"Origin": "https://unrelated.test"}),
])
def test_denied_routes_do_not_read_history_or_create_subscriptions(
    monkeypatch, path, origin, client_host, pin, credential, extra,
):
    token = enable_pin() if pin else S.create_session_token("owner")
    if credential == "revoked":
        S.revoke_session_token(token)
    elif credential == "expired":
        S._active_sessions[token]["expiry"] = time.time() - 1
    monkeypatch.setattr(bus, "get_recent", lambda *a: pytest.fail("Unauthorized history read"))
    with TestClient(app(), base_url=origin, client=(client_host, 41000)) as client:
        response = client.get(path, headers={**(cookie(token) if credential else {}), **extra})
    assert response.status_code in (401, 403), response.text
    assert PRIVATE not in response.text
    assert bus._subscribers == []


@pytest.mark.parametrize("origin,client_host,pin", [
    (LOCAL, "127.0.0.1", False),
    (LOCAL, "127.0.0.1", True),
    (REMOTE, "192.168.1.9", True),
])
def test_allowed_recent_keeps_shared_history_contract_and_zero_probe(origin, client_host, pin):
    token = enable_pin() if pin else None
    emit()
    expected = bus.get_recent()
    with TestClient(app(), base_url=origin, client=(client_host, 41000)) as client:
        response = client.get("/api/events/recent", headers=cookie(token) if token else {})
        empty = client.get("/api/events/recent?n=0", headers=cookie(token) if token else {})
    assert response.status_code == 200 and response.json() == {"events": expected}
    assert "owner" not in expected[0] and "user_id" not in expected[0]
    assert response.headers["cache-control"] == "no-store"
    assert empty.status_code == 200 and empty.json() == {"events": []}
    assert bus._subscribers == []


def test_recent_rechecks_before_disclosing_history(monkeypatch):
    token = enable_pin()

    def revoked_read(n):
        S.revoke_session_token(token)
        return [{"title": PRIVATE}]

    monkeypatch.setattr(bus, "get_recent", revoked_read)
    with TestClient(app(), base_url=REMOTE, client=("192.168.1.9", 41000)) as client:
        response = client.get("/api/events/recent", headers=cookie(token))
    assert response.status_code == 401
    assert PRIVATE not in response.text


def test_real_asgi_stream_route_admits_cookie_and_terminates_after_revocation():
    token = enable_pin()
    emit()

    async def exercise():
        request = stream_request(token)
        sent = []

        async def receive():
            await asyncio.Event().wait()

        async def send(message):
            sent.append(message)
            if message["type"] == "http.response.body" and PRIVATE.encode() in message.get("body", b""):
                S.revoke_session_token(token)

        await asyncio.wait_for(app()(request.scope, receive, send), 0.5)
        assert sent[0]["status"] == 200
        assert (b"cache-control", b"no-store") in sent[0]["headers"]
        frames = [event(row["body"]) for row in sent if row.get("body")]
        assert frames[0]["title"] == PRIVATE and frames[1:] == [TERMINAL]
        assert sent[-1]["more_body"] is False
        assert bus._subscribers == []

    asyncio.run(exercise())


def test_unused_response_never_registers_queue_and_revoked_admission_cannot_replay(monkeypatch):
    token = enable_pin()

    async def exercise():
        response = await response_for(token)
        assert bus._subscribers == []
        S.revoke_session_token(token)
        monkeypatch.setattr(bus, "get_recent", lambda *a: pytest.fail("Revoked replay read"))
        assert [event(frame) async for frame in response.body_iterator] == [TERMINAL]
        assert bus._subscribers == []
        unused = await response_for(enable_pin())
        await unused.body_iterator.aclose()
        assert bus._subscribers == []

    asyncio.run(exercise())


def test_revocation_during_replay_snapshot_does_not_disclose_snapshot(monkeypatch):
    token = enable_pin()

    def revoked_read(n):
        S.revoke_session_token(token)
        return [{"title": PRIVATE, "ts": time.time()}]

    monkeypatch.setattr(bus, "get_recent", revoked_read)

    async def exercise():
        response = await response_for(token)
        assert [event(frame) async for frame in response.body_iterator] == [TERMINAL]
        assert bus._subscribers == []

    asyncio.run(exercise())


def test_original_cookie_rechecked_between_replayed_events():
    token = enable_pin()
    emit("First synthetic event")
    emit("Second private event")

    async def exercise():
        response = await response_for(token)
        assert event(await anext(response.body_iterator))["title"] == "First synthetic event"
        queue = bus._subscribers[0]
        bus._enqueue(queue, json.dumps({"title": "queued private event"}))
        S.revoke_session_token(token)
        S.create_session_token("owner")  # Another browser cannot renew this stream.
        assert event(await anext(response.body_iterator)) == TERMINAL
        assert bus._subscribers == [] and queue.empty()
        bus._enqueue(queue, "late private callback")
        assert queue.empty()
        assert [frame async for frame in response.body_iterator] == []

    asyncio.run(exercise())


def test_live_meta_payload_is_unchanged_and_revoked_queue_is_drained():
    token = enable_pin()
    emit()

    async def exercise():
        bus.set_event_loop(asyncio.get_running_loop())
        response = await response_for(token)
        await anext(response.body_iterator)
        queue = bus._subscribers[0]
        payload = {"cpu_percent": 5, "scope": "synthetic"}
        bus.emit_meta("state_update", payload)
        await asyncio.sleep(0)
        meta = event(await anext(response.body_iterator))
        assert meta["type"] == "state_update" and meta["payload"] == payload
        assert isinstance(meta["ts"], float)
        bus.emit_meta("narrator_update", {"private": "must not arrive"})
        await asyncio.sleep(0)
        assert queue.qsize() == 1
        S.revoke_session_token(token)
        assert event(await anext(response.body_iterator)) == TERMINAL
        assert bus._subscribers == [] and queue.empty()
        await response.body_iterator.aclose()

    asyncio.run(exercise())


@pytest.mark.parametrize("queued", (False, True))
def test_waiting_stream_rechecks_original_authority_even_without_events(queued):
    token = enable_pin()

    async def exercise():
        response = await response_for(token)
        pending = asyncio.create_task(anext(response.body_iterator))
        queue = await subscribed()
        S.revoke_session_token(token)
        if queued:
            queue.put_nowait(json.dumps({"title": PRIVATE}))
        assert event(await asyncio.wait_for(pending, 0.5)) == TERMINAL
        assert bus._subscribers == [] and queue.empty()
        await response.body_iterator.aclose()

    asyncio.run(exercise())


def test_idle_keepalive_retains_format_and_revocation_prevents_next_keepalive():
    token = enable_pin()

    async def exercise():
        response = await response_for(token)
        assert await asyncio.wait_for(anext(response.body_iterator), 0.5) == ": keep-alive\n\n"
        S.revoke_session_token(token)
        assert event(await anext(response.body_iterator)) == TERMINAL
        assert bus._subscribers == []
        await response.body_iterator.aclose()

    asyncio.run(exercise())


def test_disconnected_request_cannot_replay_or_leave_subscription(monkeypatch):
    token = enable_pin()
    monkeypatch.setattr(bus, "get_recent", lambda *a: pytest.fail("Disconnected replay read"))

    async def exercise():
        response = await response_for(token, disconnected={"value": True})
        assert [frame async for frame in response.body_iterator] == []
        assert bus._subscribers == []

    asyncio.run(exercise())


@pytest.mark.parametrize("finish", ("disconnect", "close"))
def test_replay_disconnect_and_explicit_close_clear_queue(finish):
    token = enable_pin()
    emit()

    async def exercise():
        disconnected = {"value": False}
        response = await response_for(token, disconnected=disconnected)
        await anext(response.body_iterator)
        queue = bus._subscribers[0]
        queue.put_nowait("private backlog")
        if finish == "disconnect":
            disconnected["value"] = True
            assert [frame async for frame in response.body_iterator] == []
        else:
            await response.body_iterator.aclose()
        assert bus._subscribers == [] and queue.empty()

    asyncio.run(exercise())


def test_cancellation_while_waiting_unsubscribes_and_closes_queue_getter():
    token = enable_pin()

    async def exercise():
        response = await response_for(token)
        pending = asyncio.create_task(anext(response.body_iterator))
        queue = await subscribed()
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        assert bus._subscribers == [] and queue.empty()
        assert not queue._getters

    asyncio.run(exercise())


@pytest.mark.parametrize("spec", ("2.0", "2.4"))
def test_asgi_send_failure_closes_suspended_private_stream(spec):
    token = enable_pin()
    emit()

    async def exercise():
        response = await response_for(token)
        scope = stream_request(token).scope
        scope["asgi"]["spec_version"] = spec
        queues = []

        async def receive():
            await asyncio.Event().wait()

        async def send(message):
            if message["type"] == "http.response.body":
                queues.extend(bus._subscribers)
                queues[0].put_nowait("private pending data")
                raise OSError("Synthetic disconnected client")

        with pytest.raises((OSError, ClientDisconnect)):
            await response(scope, receive, send)
        assert len(queues) == 1 and queues[0].empty()
        assert bus._subscribers == []

    asyncio.run(exercise())


def test_slow_consumer_queue_is_finite_and_late_callback_cannot_repopulate_closed_queue():
    token = enable_pin()
    emit()

    async def exercise():
        loop = asyncio.get_running_loop()
        bus.set_event_loop(loop)
        errors = []
        loop.set_exception_handler(lambda _, context: errors.append(context))
        response = await response_for(token)
        await anext(response.body_iterator)
        queue = bus._subscribers[0]
        for number in range(150):
            emit(f"Synthetic burst {number}")
        await asyncio.sleep(0)
        assert queue.maxsize == 128 and queue.qsize() == 128
        assert len(bus.get_recent(200)) == 151
        assert errors == []
        bus.emit_meta("narrator_update", {"private": "late callback"})
        await response.body_iterator.aclose()
        await asyncio.sleep(0)
        assert bus._subscribers == [] and queue.empty() and errors == []

    asyncio.run(exercise())


def test_replay_remains_capped_and_old_events_are_not_replayed():
    token = enable_pin()
    for number in range(25):
        emit(f"Synthetic event {number}")
    bus._events[-1]["ts"] = time.time() - 3 * 3600

    async def exercise():
        response = await response_for(token)
        replay = [event(await anext(response.body_iterator)) for _ in range(19)]
        assert [row["title"] for row in replay] == [f"Synthetic event {n}" for n in range(5, 24)]
        await response.body_iterator.aclose()
        assert bus._subscribers == []

    asyncio.run(exercise())
