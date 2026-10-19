"""HomeLab registry preservation, browser authority and bounded request contracts."""
import asyncio
import json
import threading
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
from starlette.requests import Request

import homelab_overview as overview
import tli_state as S
from intelligence.devices import stable_id
from routers import home_power
from routers import homelab_routes as routes


PAYLOAD = {"origin": "https://192.168.1.2:8006", "token_id": "observer@pve!tli",
           "token_secret": "PRIVATE-TOKEN-SECRET", "certificate_sha256": ""}


@pytest.fixture
def lab(monkeypatch, tmp_path):
    monkeypatch.setattr(S, "DATA_DIR", tmp_path)
    monkeypatch.setattr(S, "NODE_CONFIG_PATH", tmp_path / "node_config.json")
    monkeypatch.setattr(S, "MESH_DIRECTORY_PATH", tmp_path / "mesh_directory.json")
    monkeypatch.setattr(S, "SHELLY_REGISTRY_PATH", tmp_path / "shelly_registry.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    pin = {"enabled": False}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(pin))
    logs = Mock()
    monkeypatch.setattr(S, "log_debug", logs)
    def write(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")
    write(S.NODE_CONFIG_PATH, {"node_id": "host-1", "node_name": "Lab host", "role": "standalone",
        "created_at": "2026-10-16T00:00:00Z", "updated_at": "2026-10-16T00:00:00Z", "future_field": "preserved"})
    write(S.MESH_DIRECTORY_PATH, {"peer-2": {"node_name": "Workshop", "role": "member", "online": True,
        "ip": "192.168.1.20", "peer_trust": {"token": "PRIVATE-PEER-TOKEN"}, "card": {"private": "PRIVATE-CARD"}}})
    write(S.SHELLY_REGISTRY_PATH, [{"id": "legacy-lamp", "name": "Legacy lamp", "ip": "192.168.1.50",
        "relay": 0, "extra": {"secret": "PRIVATE-DEVICE-SECRET"}},
        {"id": "legacy-heater", "name": "Heater", "ip": "192.168.1.51", "relay": 1}])
    write(tmp_path / "home_power" / "devices.json", {"devices": [{"device_id": "lamp", "name": "Lamp",
        "vendor": "shelly", "ip": "192.168.1.50:80", "relay": 0, "future_field": "preserved"}], "future": 2})
    write(tmp_path / "intelligence" / "device_context.json", {
        stable_id("homepower", "lamp"): {"name": "Desk lamp", "room": "Office"},
        "node-peer-2": {"name": "Workshop server"}})
    runtime = home_power.HomePowerRuntime(tmp_path, Mock(), Mock())
    monkeypatch.setattr(home_power, "_RUNTIME", runtime)
    app = FastAPI()
    app.include_router(routes.router)
    clients = []
    def browser(*, pin_on=False, remote=False, secure=False, cookie=False):
        pin["enabled"] = pin_on
        base = ("https" if secure else "http") + "://" + ("lab.example.test:8443" if remote else "localhost:8000")
        client = TestClient(app, base_url=base, client=("192.0.2.10" if remote else "127.0.0.1", 1234),
            headers={"Origin": base, "Sec-Fetch-Site": "same-origin"}, raise_server_exceptions=False)
        token = S.create_session_token("owner") if cookie else None
        if token:
            client.headers["Cookie"] = "tli_session=" + token
        clients.append(client)
        return client, token
    inspect = Mock(return_value={"resources": [], "scope": "One explicit observation", "actions_performed": False})
    monkeypatch.setattr(routes.homelab_proxmox, "inspect", inspect)
    yield SimpleNamespace(browser=browser, pin=pin, runtime=runtime, root=tmp_path, inspect=inspect, logs=logs,
                          write=write, app=app)
    for client in clients:
        client.close()
    logs.assert_not_called()


def snapshot(root):
    return {str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns)
            for path in root.rglob("*") if path.is_file()}


@pytest.mark.parametrize("mode", ["open-local", "pin-local", "pin-https"])
def test_overview_preserves_sources_and_never_checks_or_starts_ai(lab, monkeypatch, mode):
    client, _ = lab.browser(pin_on=mode != "open-local", remote=mode == "pin-https",
                            secure=mode == "pin-https", cookie=mode != "open-local")
    prohibited = Mock(side_effect=AssertionError("No initialization, writes or probes"))
    monkeypatch.setattr(S, "load_node_config", prohibited)
    monkeypatch.setattr(S, "load_model_config_from_disk", prohibited)
    monkeypatch.setattr(S, "save_json_file", prohibited)
    monkeypatch.setattr(home_power, "init_home_power_runtime", prohibited)
    monkeypatch.setattr(overview.shelly_store, "write", prohibited)
    before = snapshot(lab.root)
    response = client.get("/api/homelab/overview")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    sources = response.json()["sources"]
    assert sources["computers"]["state"] == sources["devices"]["state"] == "available"
    assert sources["computers"]["items"] == [
        {"id": "node-host-1", "name": "Lab host", "kind": "host", "role": "standalone", "availability": "unknown"},
        {"id": "node-peer-2", "name": "Workshop server", "kind": "computer", "role": "member", "availability": "unknown"}]
    assert sources["devices"]["items"] == [
        {"id": stable_id("homepower", "lamp"), "name": "Desk lamp", "kind": "smart_device", "room": "Office", "availability": "unknown"},
        {"id": stable_id("shelly", "legacy-heater"), "name": "Heater", "kind": "smart_device", "room": None, "availability": "unknown"}]
    assert sources["ai"] == {"state": "not_checked", "selection": None, "detail": overview.AI_DETAIL}
    assert all(private not in response.text for private in ("PRIVATE", "192.168", "peer_trust", "future_field", "online"))
    assert snapshot(lab.root) == before
    prohibited.assert_not_called()
    lab.inspect.assert_not_called()


@pytest.mark.parametrize("endpoint", ["overview", "proxmox/inspect"])
@pytest.mark.parametrize("mode", ["pin-locked", "stale-cookie", "expired-cookie", "lan-pin-off", "remote-http",
    "bearer", "peer", "proxy", "wrong-host", "cross-origin", "null-origin", "cross-site", "duplicate-origin"])
def test_actual_browser_denials_precede_any_private_read_or_probe(lab, monkeypatch, mode, endpoint):
    remote = mode in {"lan-pin-off", "remote-http"}
    client, token = lab.browser(pin_on=mode not in {"lan-pin-off", "wrong-host"}, remote=remote,
        secure=mode == "lan-pin-off", cookie=mode not in {"pin-locked", "lan-pin-off", "wrong-host"})
    if mode == "stale-cookie": S.revoke_session_token(token)
    if mode == "expired-cookie": S._active_sessions[token]["expiry"] = 0
    if mode == "bearer": client.headers["Authorization"] = "Bearer PRIVATE-NATIVE-TOKEN"
    if mode == "peer": client.headers["X-TLI-Peer-Signature"] = "PRIVATE-PEER"
    if mode == "proxy": client.headers["X-Forwarded-For"] = "127.0.0.1"
    if mode == "wrong-host": client.headers["Host"] = "elsewhere.example.test"
    if mode == "cross-origin": client.headers["Origin"] = "https://elsewhere.example.test"
    if mode == "null-origin": client.headers["Origin"] = "null"
    if mode == "cross-site": client.headers["Sec-Fetch-Site"] = "cross-site"
    if mode == "duplicate-origin": client.headers.update([("Origin", str(client.base_url).rstrip("/")), ("Origin", str(client.base_url).rstrip("/"))])
    read = Mock(side_effect=AssertionError("No read before admission"))
    monkeypatch.setattr(overview, "metadata", read)
    response = (client.get("/api/homelab/overview") if endpoint == "overview" else
                client.post("/api/homelab/proxmox/inspect", content=b"invalid PRIVATE", headers={"Content-Type": "application/json"}))
    assert response.status_code == (401 if mode in {"pin-locked", "stale-cookie", "expired-cookie"} else 403), response.text
    assert response.headers["cache-control"] == "no-store" and "PRIVATE" not in response.text
    read.assert_not_called()
    lab.inspect.assert_not_called()


@pytest.mark.parametrize("damaged,unavailable", [("node_config.json", "computers"), ("mesh_directory.json", "computers"),
    ("shelly_registry.json", "devices"), ("home_power/devices.json", "devices"), ("intelligence/device_context.json", "both")])
def test_damaged_source_is_unavailable_without_reset_or_partial_count(lab, damaged, unavailable):
    client, _ = lab.browser()
    (lab.root / damaged).write_text('{"PRIVATE-BROKEN":', encoding="utf-8")
    before = snapshot(lab.root)
    response = client.get("/api/homelab/overview")
    assert response.status_code == 200, response.text
    sources = response.json()["sources"]
    for area in ("computers", "devices"):
        assert sources[area]["state"] == ("unavailable" if unavailable in {"both", area} else "available")
        if unavailable in {"both", area}: assert sources[area]["items"] == []
    assert "PRIVATE" not in response.text and snapshot(lab.root) == before


def test_absent_host_and_uninitialized_homepower_are_not_created(lab, monkeypatch):
    client, _ = lab.browser()
    S.NODE_CONFIG_PATH.unlink()
    monkeypatch.setattr(home_power, "_RUNTIME", None)
    before = snapshot(lab.root)
    response = client.get("/api/homelab/overview")
    assert response.status_code == 200
    assert response.json()["sources"]["computers"]["state"] == "unavailable"
    assert response.json()["sources"]["devices"]["state"] == "unavailable"
    assert snapshot(lab.root) == before


def test_only_same_vendor_address_and_relay_are_deduplicated(lab):
    client, _ = lab.browser()
    lab.write(lab.root / "home_power" / "devices.json", {"devices": [
        {"device_id": "other-vendor", "vendor": "hue", "name": "Bridge", "ip": "192.168.1.50", "relay": 0},
        {"device_id": "other-relay", "vendor": "shelly", "name": "Second relay", "ip": "192.168.1.51", "relay": 0}]})
    response = client.get("/api/homelab/overview")
    assert response.status_code == 200
    assert len(response.json()["sources"]["devices"]["items"]) == 4


def test_non_shelly_driver_targets_keep_registered_identities_and_shelly_deduplication(lab):
    client, _ = lab.browser()
    custom = {"vendor": "generic_http", "ip": "http://192.168.1.50/control",
              "extra": {"url_on": "http://192.168.1.50/control?token=PRIVATE-ON",
                        "url_off": "http://192.168.1.50/control?token=PRIVATE-OFF"}}
    lab.write(lab.root / "home_power" / "devices.json", {"devices": [
        {**custom, "device_id": "custom-1", "name": "Rack light"},
        {**custom, "device_id": "custom-2", "name": "Rack fan"},
        {"device_id": "vendor-target", "vendor": "custom_driver", "name": "Lab accessory", "ip": "device://rack:1"},
        {"device_id": "lamp", "vendor": "shelly", "name": "Lamp", "ip": "192.168.1.50:80", "relay": 0}]})
    before = snapshot(lab.root)
    response = client.get("/api/homelab/overview")
    assert response.status_code == 200, response.text
    devices = response.json()["sources"]["devices"]
    assert devices["state"] == "available"
    assert [row["id"] for row in devices["items"]] == [
        stable_id("homepower", "custom-1"), stable_id("homepower", "custom-2"),
        stable_id("homepower", "vendor-target"), stable_id("homepower", "lamp"), stable_id("shelly", "legacy-heater")]
    assert all(row["availability"] == "unknown" for row in devices["items"])
    assert "PRIVATE" not in response.text and "192.168" not in response.text and "device://" not in response.text
    assert snapshot(lab.root) == before


@pytest.mark.parametrize("phase", ["metadata", "node", "mesh", "homepower", "shelly", "timestamp"])
@pytest.mark.parametrize("error", [False, True])
def test_revocation_and_error_at_every_read_stops_disclosure_and_later_reads(lab, monkeypatch, phase, error):
    client, token = lab.browser(pin_on=True, cookie=True)
    touched = []
    entries = [("metadata", overview, "metadata"), ("node", S, "read_node_config"), ("mesh", S, "load_mesh_directory"),
               ("homepower", lab.runtime, "load_devices"), ("shelly", overview.shelly_store, "read"), ("timestamp", S, "now_iso")]
    for name, owner, attr in entries:
        original = getattr(owner, attr)
        def call(*args, _name=name, _original=original, **kwargs):
            touched.append(_name)
            value = _original(*args, **kwargs)
            if _name == phase:
                S.revoke_session_token(token)
                if error: raise RuntimeError("PRIVATE-SOURCE-ERROR")
            return value
        monkeypatch.setattr(owner, attr, call)
    response = client.get("/api/homelab/overview")
    assert response.status_code == 401, response.text
    assert touched[-1] == phase
    assert "Lab host" not in response.text and "PRIVATE" not in response.text and "sources" not in response.json()
    assert response.headers["cache-control"] == "no-store"


def test_pin_off_on_off_cycle_during_read_retires_open_local_authority(lab, monkeypatch):
    client, _ = lab.browser()
    original = overview.metadata
    def cycle():
        value = original()
        lab.pin["enabled"] = True
        S.revoke_all_sessions()
        lab.pin["enabled"] = False
        return value
    monkeypatch.setattr(overview, "metadata", cycle)
    forbidden = Mock(side_effect=AssertionError("No next private read"))
    monkeypatch.setattr(S, "read_node_config", forbidden)
    response = client.get("/api/homelab/overview")
    assert response.status_code == 401 and "sources" not in response.json()
    forbidden.assert_not_called()


def test_a_transient_security_check_failure_is_latched_even_if_store_catches_it(lab, monkeypatch):
    client, _ = lab.browser()
    original = S.load_pin_config
    once = [True]
    def unavailable_once():
        if once[0]:
            once[0] = False
            raise RuntimeError("PRIVATE-SECURITY-ERROR")
        return original()
    def swallowing_store(*, check):
        monkeypatch.setattr(S, "load_pin_config", unavailable_once)
        try: check()
        except Exception: pass
        return []
    monkeypatch.setattr(lab.runtime, "load_devices", swallowing_store)
    next_read = Mock(side_effect=AssertionError("Cannot continue after any check failure"))
    monkeypatch.setattr(overview.shelly_store, "read", next_read)
    response = client.get("/api/homelab/overview")
    assert response.status_code == 503 and "PRIVATE" not in response.text and "sources" not in response.json()
    assert response.headers["cache-control"] == "no-store"
    next_read.assert_not_called()


@pytest.mark.parametrize("phase", ["node", "mesh", "homepower", "shelly"])
def test_access_is_rechecked_after_each_registry_lock_acquisition(lab, monkeypatch, phase):
    client, token = lab.browser(pin_on=True, cookie=True)
    locks = {"node": (S, "_NODE_CONFIG_LOCK", S, "read_node_config"),
             "mesh": (S, "MESH_DIRECTORY_LOCK", S, "load_mesh_directory"),
             "homepower": (lab.runtime, "_lock", lab.runtime._stores["devices"], "read"),
             "shelly": (overview.shelly_store, "LOCK", overview.shelly_store, "_chain")}
    owner, field, reader, method = locks[phase]
    original = getattr(owner, field)
    class RevokeOnAcquire:
        def __enter__(self):
            result = original.__enter__()
            S.revoke_session_token(token)
            return result
        def __exit__(self, *args):
            return original.__exit__(*args)
    monkeypatch.setattr(owner, field, RevokeOnAcquire())
    forbidden = Mock(side_effect=AssertionError("No private read after waiting for the lock"))
    monkeypatch.setattr(reader, method, forbidden)
    response = client.get("/api/homelab/overview")
    assert response.status_code == 401 and "sources" not in response.json()
    forbidden.assert_not_called()


@pytest.mark.parametrize("endpoint", ["overview", "proxmox/inspect"])
def test_final_serialization_cannot_disclose_after_revocation(lab, monkeypatch, endpoint):
    client, token = lab.browser(pin_on=True, cookie=True)
    original = routes.JSONResponse
    def serialize(*args, **kwargs):
        response = original(*args, **kwargs)
        S.revoke_session_token(token)
        return response
    monkeypatch.setattr(routes, "JSONResponse", serialize)
    response = (client.get("/api/homelab/overview") if endpoint == "overview" else
                client.post("/api/homelab/proxmox/inspect", json=PAYLOAD))
    assert response.status_code == 401
    assert not {"sources", "resources"} & set(response.json())
    assert response.headers["cache-control"] == "no-store"


def test_inspection_gets_exact_payload_in_worker_thread_without_saving(lab):
    client, _ = lab.browser()
    threads = []
    def inspect(payload, check):
        check()
        assert payload == PAYLOAD
        threads.append(threading.current_thread().name)
        return {"resources": [], "actions_performed": False}
    lab.inspect.side_effect = inspect
    before = snapshot(lab.root)
    response = client.post("/api/homelab/proxmox/inspect", json=PAYLOAD)
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert threads == ["AnyIO worker thread"]
    assert "PRIVATE" not in response.text and snapshot(lab.root) == before


@pytest.mark.parametrize("body", [b"PRIVATE-not-json", b"[]", b"null", b'{"token_secret":"PRIVATE"}',
    json.dumps({**PAYLOAD, "extra": "PRIVATE"}).encode(), json.dumps({**PAYLOAD, "token_secret": 12}).encode(),
    json.dumps({**PAYLOAD, "token_secret": "\ud800"}).encode(),
    b'{"origin":"PRIVATE","origin":"duplicate","token_id":"x","token_secret":"x","certificate_sha256":""}',
    b'{"origin":NaN,"token_id":"x","token_secret":"PRIVATE","certificate_sha256":""}'])
def test_malformed_or_duplicate_request_is_rejected_without_echo(lab, body):
    client, _ = lab.browser()
    response = client.post("/api/homelab/proxmox/inspect", content=body, headers={"Content-Type": "application/json"})
    assert response.status_code == 422 and "PRIVATE" not in response.text, response.text
    assert response.headers["cache-control"] == "no-store"
    lab.inspect.assert_not_called()


@pytest.mark.parametrize("headers,status", [({"Content-Type": "text/plain"}, 415),
    ({"Content-Type": "application/json", "Content-Length": "8193"}, 413),
    ({"Content-Type": "application/json", "Content-Length": "bad"}, 400),
    ({"Content-Type": "application/json", "Content-Length": "9" * 100}, 400)])
def test_request_header_limits(lab, headers, status):
    client, _ = lab.browser()
    response = client.post("/api/homelab/proxmox/inspect", content=json.dumps(PAYLOAD), headers=headers)
    assert response.status_code == status and response.headers["cache-control"] == "no-store"
    lab.inspect.assert_not_called()


@pytest.mark.parametrize("failure", ["revoke", "revoke-error", "unexpected-error", "security-unavailable"])
def test_inspection_final_and_error_paths_preserve_original_browser(lab, monkeypatch, failure):
    client, token = lab.browser(pin_on=True, cookie=True)
    def inspect(payload, check):
        if failure.startswith("revoke"): S.revoke_session_token(token)
        if failure == "security-unavailable":
            monkeypatch.setattr(S, "load_pin_config", Mock(side_effect=RuntimeError("PRIVATE-SECURITY")))
        if failure.endswith("error"): raise RuntimeError("PRIVATE-INSPECTION-ERROR")
        return {"resources": [{"name": "PRIVATE-GUEST"}]}
    lab.inspect.side_effect = inspect
    response = client.post("/api/homelab/proxmox/inspect", json=PAYLOAD)
    assert response.status_code == (401 if failure.startswith("revoke") else 503), response.text
    assert "PRIVATE" not in response.text and "resources" not in response.json()
    assert response.headers["cache-control"] == "no-store"


def streamed_request(chunks, *, hook=None, delay=0):
    index = [0]
    async def receive():
        if delay: await asyncio.sleep(delay)
        current = index[0]
        index[0] += 1
        if hook: hook(current)
        return {"type": "http.request", "body": chunks[current], "more_body": current < len(chunks) - 1}
    request = Request({"type": "http", "method": "POST", "path": "/api/homelab/proxmox/inspect",
                       "headers": [(b"content-type", b"application/json")]}, receive)
    return request, index


def test_chunked_body_is_bounded_without_content_length():
    request, count = streamed_request([b"x" * 4096, b"x" * 4097, b"must not read"])
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes._payload(request, lambda: None))
    assert error.value.status_code == 413 and count[0] == 2


def test_body_read_deadline_bounds_an_idle_sender(monkeypatch):
    monkeypatch.setattr(routes, "MAX_BODY_SECONDS", 0.02)
    request, _ = streamed_request([json.dumps(PAYLOAD).encode()], delay=0.2)
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes._payload(request, lambda: None))
    assert error.value.status_code == 408


def test_elapsed_and_revocation_during_body_read_stop_later_chunks(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(routes, "_now", lambda: clock[0])
    def late(index): clock[0] += routes.MAX_BODY_SECONDS + 1
    request, count = streamed_request([b"{", b"must not read"], hook=late)
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes._payload(request, lambda: None))
    assert error.value.status_code == 408 and count[0] == 1
    request, count = streamed_request([b"{", b"must not read"], hook=late)
    admitted = clock[0]
    def revoked():
        if clock[0] > admitted: raise HTTPException(401, "Revoked")
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes._payload(request, revoked))
    assert error.value.status_code == 401 and count[0] == 1


def test_effective_main_routes_retain_real_browser_admission(app, lab):
    lab.browser(pin_on=True)
    main_client = TestClient(app, base_url="http://localhost:8000", client=("127.0.0.1", 1234),
                             headers={"Origin": "http://localhost:8000"})
    try:
        assert main_client.get("/api/homelab/overview").status_code == 401
        assert main_client.post("/api/homelab/proxmox/inspect", json=PAYLOAD).status_code == 401
    finally:
        main_client.close()
    lab.inspect.assert_not_called()
