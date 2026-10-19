"""Legacy relay quarantine: synthetic transports and isolated private history."""
from __future__ import annotations

import asyncio
import json
from collections import deque
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

import relay_server as transport
import tli_state as S
from browser_authority import browser_control_access
from routers import federation_routes as fed
from routers import relay_routes as relay

LOCAL = "http://localhost:8000"
RETIRED = [
    ("POST", "/relay/start"), ("POST", "/federation/settings"),
    ("POST", "/federation/pair/create"), ("POST", "/federation/pair/join"),
    ("POST", "/federation/message"), ("GET", "/federation/events"),
]
PRIVATE = RETIRED + [("GET", "/relay/status"), ("POST", "/relay/stop"),
    ("GET", "/federation/status"), ("GET", "/federation/messages"),
    ("DELETE", "/federation/pair")]


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "pin.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(fed, "_state", {"connected": False, "connecting": False,
        "room": "OLD234", "node_name": "Old node", "peers": [],
        "relay_url": "ws://retained.invalid:9000", "error": None})
    monkeypatch.setattr(fed, "_messages", deque([{"from": "Retained peer", "text": "Retained private message"}]))
    monkeypatch.setattr(fed, "_ws_client", None)
    monkeypatch.setattr(fed, "_ws_thread", None)
    monkeypatch.setattr(transport, "_server", None)
    monkeypatch.setattr(transport, "_relay_thread", None)
    monkeypatch.setattr(transport, "_relay_loop", None)
    monkeypatch.setattr(transport, "_running", False)
    monkeypatch.setattr(transport, "_rooms", {})
    (tmp_path / "relay_settings.json").write_text('{"enabled":true,"port":9123,"unknown":{"keep":1}}')
    (tmp_path / "federation_settings.json").write_text('{"relay_url":"ws://retained.invalid:9000","unknown":{"keep":1}}')
    return tmp_path


@contextmanager
def browser(*, pin=False, session=True, origin=LOCAL, host="127.0.0.1", extra=None):
    headers = {"Origin": origin, **(extra or {})}
    if pin:
        S.save_pin_config("a" * 64, "b" * 64)
        if session:
            headers["Cookie"] = "tli_session=" + S.create_session_token("owner")
    app = FastAPI()
    app.include_router(relay.router)
    app.include_router(fed.router)
    assert not app.dependency_overrides
    with TestClient(app, base_url=origin, client=(host, 41000), headers=headers) as client:
        yield client


def snapshots(root):
    return {p.name: p.read_bytes() for p in root.glob('*settings.json')}


@pytest.mark.parametrize("method,path", PRIVATE)
@pytest.mark.parametrize("mode", ["locked", "lan", "bearer", "cross-origin", "proxy", "stale"])
def test_private_routes_reject_before_any_state_or_transport(monkeypatch, method, path, mode):
    def forbidden(*args, **kwargs):
        pytest.fail("Denied request touched private state or transport")
    for module, names in [(relay, ["_load_settings"]), (fed, ["_load_settings", "_stop_ws"]),
                          (transport, ["start", "stop", "is_running"])]:
        for name in names:
            monkeypatch.setattr(module, name, forbidden)
    class Unreadable:
        def __iter__(self):
            forbidden()
    monkeypatch.setattr(fed, "_messages", Unreadable())
    kwargs = {"pin": mode != "lan", "session": mode != "locked"}
    if mode == "lan": kwargs.update(host="192.0.2.8", origin="https://tli.test")
    if mode == "bearer": kwargs["extra"] = {"Authorization": "Bearer rejected-even-with-cookie"}
    if mode == "cross-origin": kwargs["extra"] = {"Origin": "https://other.invalid"}
    if mode == "proxy": kwargs["extra"] = {"X-Forwarded-For": "127.0.0.1"}
    with browser(**kwargs) as client:
        if mode == "stale": S._active_sessions.clear()
        response = client.request(method, path)
    assert response.status_code in (401, 403)
    assert "Retained" not in response.text and "OLD234" not in response.text


@pytest.mark.parametrize("method,path", RETIRED)
@pytest.mark.parametrize("body", [None, "{", "[]", '{"code":"SYN234","text":"never send"}'])
def test_retired_routes_do_not_parse_payload_or_change_history_settings(isolated, method, path, body):
    before = snapshots(isolated)
    history = list(fed._messages)
    with browser(pin=True) as client:
        response = client.request(method, path, content=body, headers={"Content-Type": "application/json"})
    assert response.status_code == 410
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["detail"] == transport.RETIRED_REASON
    assert snapshots(isolated) == before and list(fed._messages) == history


@pytest.mark.parametrize("pin,origin,host", [(False, LOCAL, "127.0.0.1"),
    (True, LOCAL, "127.0.0.1"), (True, "https://tli.test", "192.0.2.8")])
def test_private_history_and_cleanup_preserve_history_and_settings(isolated, pin, origin, host):
    before = snapshots(isolated)
    with browser(pin=pin, origin=origin, host=host) as client:
        status = client.get('/federation/status')
        assert status.status_code == 200
        assert status.json()["available"] is False and status.json()["retired"] is True
        assert status.json()["room"] == "OLD234"
        assert status.json()["relay_url"] == "ws://retained.invalid:9000"
        messages = client.get('/federation/messages')
        assert messages.json()["messages"] == list(fed._messages)
        disconnected = client.delete('/federation/pair')
        assert disconnected.status_code == 200 and disconnected.json()["connected"] is False
        stopped = client.post('/relay/stop')
        assert stopped.status_code == 200 and stopped.json()["running"] is False
        assert client.get('/federation/messages').json() == messages.json()
    for response in (status, messages, disconnected, stopped):
        assert response.headers["cache-control"] == "no-store"
    assert snapshots(isolated) == before


@pytest.mark.parametrize("module,path", [(relay, '/relay/status'), (fed, '/federation/status')])
@pytest.mark.parametrize("failure", [False, True])
def test_revoked_settings_read_never_discloses_data_or_error(monkeypatch, module, path, failure):
    read = module._load_settings
    def revoke():
        value = read()
        S._active_sessions.clear()
        if failure: raise RuntimeError("PRIVATE read detail")
        return value
    monkeypatch.setattr(module, '_load_settings', revoke)
    with browser(pin=True) as client:
        response = client.get(path)
    assert response.status_code == 401
    assert "PRIVATE" not in response.text and "retained.invalid" not in response.text


@pytest.mark.parametrize("failure", [False, True])
def test_revoked_history_materialization_never_discloses_content(monkeypatch, failure):
    class RevokedHistory:
        def __iter__(self):
            S._active_sessions.clear()
            if failure: raise RuntimeError("PRIVATE history failure")
            yield {"text": "PRIVATE history"}
    monkeypatch.setattr(fed, '_messages', RevokedHistory())
    with browser(pin=True) as client:
        response = client.get('/federation/messages')
    assert response.status_code == 401 and "PRIVATE" not in response.text


@pytest.mark.parametrize("failure", [False, True])
def test_disconnect_rechecks_revocation_after_close_without_clearing_history(monkeypatch, failure):
    history = list(fed._messages)
    def close():
        S._active_sessions.clear()
        if failure: raise RuntimeError("PRIVATE close detail")
    monkeypatch.setattr(fed, '_ws_client', SimpleNamespace(close=close))
    with browser(pin=True) as client:
        response = client.delete('/federation/pair')
    assert response.status_code == 401 and "PRIVATE" not in response.text
    assert list(fed._messages) == history


def test_disconnect_worker_still_alive_does_not_claim_completion(monkeypatch):
    calls = []
    monkeypatch.setattr(fed, '_ws_thread', SimpleNamespace(is_alive=lambda: True, join=lambda **kw: calls.append(kw)))
    with browser() as client:
        response = client.delete('/federation/pair')
    assert response.status_code == 503 and calls == [{"timeout": 1}]
    assert fed._messages


@pytest.mark.parametrize("name,path", [("relay_settings.json", '/relay/status'),
                                       ("federation_settings.json", '/federation/status')])
def test_damaged_settings_preserved_and_explicit_cleanup_remains_available(isolated, name, path):
    damaged = isolated / name
    damaged.write_bytes(b'{broken historical settings')
    with browser() as client:
        response = client.get(path)
        assert response.status_code == 503
        assert client.post('/relay/stop').status_code == 200
        assert client.delete('/federation/pair').status_code == 200
    assert damaged.read_bytes() == b'{broken historical settings'


def test_all_internal_start_entrypoints_are_inert(monkeypatch):
    import socket
    import threading
    import websockets.sync.client
    def forbidden(*args, **kwargs):
        pytest.fail("Retired transport attempted a socket or worker")
    monkeypatch.setattr(socket, 'socket', forbidden)
    monkeypatch.setattr(threading.Thread, 'start', forbidden)
    monkeypatch.setattr(websockets.sync.client, 'connect', forbidden)
    monkeypatch.setattr(relay, '_load_settings', forbidden)
    assert transport.start() is False
    assert transport.start(port=9123, host='0.0.0.0') is False
    assert transport.local_ws_url() is None
    assert relay.autostart() is None
    assert fed._start_ws('ws://never.invalid', 'ABC234', 'Synthetic') is False
    assert fed._ws_loop('ws://never.invalid', 'ABC234', 'Synthetic') is False


def test_room_handler_refuses_without_consuming_frames_or_replacing_peer(monkeypatch):
    calls = []
    old = object()
    monkeypatch.setattr(transport, '_rooms', {'ABC234': {old: 'Known peer'}})
    class Socket:
        def __aiter__(self): pytest.fail('Retired room handler consumed a frame')
        async def close(self, **kw): calls.append(kw)
    asyncio.run(transport._handle(Socket()))
    assert calls == [{"code": 1008, "reason": "Legacy relay retired"}]
    assert transport._rooms == {'ABC234': {old: 'Known peer'}}


def test_existing_listener_cleanup_waits_for_close_without_new_transport(monkeypatch):
    calls = []
    class Server:
        def close(self): calls.append('close')
        async def wait_closed(self): calls.append('closed')
        def is_serving(self): return 'closed' not in calls
    server = Server()
    loop = SimpleNamespace(is_running=lambda: True, stop=lambda: calls.append('loop-stop'))
    loop.call_soon_threadsafe = lambda callback: callback()
    class Completion:
        def __init__(self, coro): self.coro = coro
        def result(self, **kw): asyncio.run(self.coro)
        def cancel(self): pytest.fail('Unexpected cancellation')
    monkeypatch.setattr(transport, '_server', server)
    monkeypatch.setattr(transport, '_relay_loop', loop)
    monkeypatch.setattr(transport.asyncio, 'run_coroutine_threadsafe', lambda coro, target: Completion(coro))
    transport.stop()
    assert calls == ['close', 'closed', 'loop-stop']
    assert not transport.is_running()

@pytest.mark.parametrize("name,path", [("relay_settings.json", '/relay/status'),
                                       ("federation_settings.json", '/federation/status')])
@pytest.mark.parametrize("raw", [b'[]', b'{"x":1,"x":2}', b'{"unknown":{"x":1,"x":2}}',
    b'{"unknown":NaN}', b'{"unknown":Infinity}', b'{"unknown":-Infinity}',
    b'{"unknown":1e999}', b'{"unknown":-1e999}', b'{"x":"' + b'x'*65536 + b'"}'],
    ids=['scalar', 'duplicate', 'nested-duplicate', 'nan', 'infinity', 'negative-infinity', 'overflow', 'negative-overflow', 'oversized'])
def test_bounded_strict_historical_json_is_preserved(isolated, name, path, raw):
    target = isolated / name
    target.write_bytes(raw)
    with browser() as client:
        response = client.get(path)
    assert response.status_code == 503
    assert response.headers['cache-control'] == 'no-store'
    assert target.read_bytes() == raw


@pytest.mark.parametrize("name,path,raw", [
    ('relay_settings.json', '/relay/status', '{"enabled":"true"}'),
    ('relay_settings.json', '/relay/status', '{"port":true}'),
    ('relay_settings.json', '/relay/status', '{"port":"9000"}'),
    ('relay_settings.json', '/relay/status', '{"port":65536}'),
    ('relay_settings.json', '/relay/status', '{"port":0}'),
    ('federation_settings.json', '/federation/status', '{"relay_url":{}}'),
    ('federation_settings.json', '/federation/status', json.dumps({'relay_url':'x'*4097})),
], ids=['enabled-string', 'port-bool', 'port-string', 'port-over', 'port-zero', 'url-object', 'url-long'])
def test_invalid_known_historical_fields_are_preserved(isolated, name, path, raw):
    target = isolated / name
    target.write_bytes(raw.encode())
    with browser() as client:
        response = client.get(path)
    assert response.status_code == 503
    assert response.headers['cache-control'] == 'no-store'
    assert target.read_bytes() == raw.encode()


def test_missing_historical_settings_are_read_only_defaults(isolated):
    (isolated / 'relay_settings.json').unlink()
    (isolated / 'federation_settings.json').unlink()
    with browser() as client:
        assert client.get('/relay/status').json()['saved_enabled'] is False
        assert client.get('/federation/status').json()['available'] is False
    assert not list(isolated.glob('*settings.json'))


@pytest.mark.parametrize('mode,attributes', [(0o120777, 0), (0o100644, 1024)])
def test_linked_historical_settings_are_refused_without_open(mode, attributes):
    class LinkedPath:
        def lstat(self):
            return SimpleNamespace(st_mode=mode, st_file_attributes=attributes, st_size=10)
        def open(self, *args): pytest.fail('Linked historical metadata was opened')
    with pytest.raises(ValueError):
        transport.read_saved_settings(LinkedPath(), {})


def test_growing_settings_read_stays_bounded(isolated, monkeypatch):
    import io
    from pathlib import Path
    original = Path.open
    count = []
    target = isolated / 'relay_settings.json'
    class Growing:
        def __enter__(self): self.real = original(target, 'rb'); return self
        def __exit__(self, *args): self.real.close()
        def fileno(self): return self.real.fileno()
        def read(self, size): count.append(size); return b' ' * size
    def opened(path, *args, **kwargs):
        return Growing() if path == target else original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'open', opened)
    with browser() as client:
        response = client.get('/relay/status')
    assert response.status_code == 503
    assert count == [65537]

@pytest.mark.parametrize('via_route', [False, True])
def test_closed_listener_with_unconfirmed_clients_still_requires_cleanup(monkeypatch, via_route):
    calls = []
    class Server:
        serving = True
        def close(self): self.serving = False; calls.append('close')
        async def wait_closed(self): raise TimeoutError('Synthetic remaining client')
        def is_serving(self): return self.serving
    server = Server()
    loop = SimpleNamespace(is_running=lambda: True)
    class Completion:
        def __init__(self, coro): self.coro = coro
        def result(self, **kw): asyncio.run(self.coro)
        def cancel(self): calls.append('cancel')
    monkeypatch.setattr(transport, '_server', server)
    monkeypatch.setattr(transport, '_relay_loop', loop)
    monkeypatch.setattr(transport.asyncio, 'run_coroutine_threadsafe', lambda coro, target: Completion(coro))
    if via_route:
        with browser() as client:
            stopped = client.post('/relay/stop')
            assert stopped.status_code == 503
            assert stopped.headers['cache-control'] == 'no-store'
            status = client.get('/relay/status')
            assert status.json()['running'] is True
    else:
        with pytest.raises(RuntimeError, match='could not be confirmed'):
            transport.stop()
    assert server.is_serving() is False
    assert transport.is_running() is True
    assert calls == ['close', 'cancel']
