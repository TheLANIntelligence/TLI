"""Private legacy USB/ARP observations with real sessions and synthetic probes."""
import io
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import tli_state as S
from routers import device_routes as routes


PATHS = ["/devices/usb/list", "/devices/usb/info", "/devices/usb/raw",
         "/devices/usb/detail", "/devices/usb", "/devices/scan"]
SERVICES = ["devices_usb_list", "devices_usb_info", "devices_usb_raw",
            "devices_usb_detail", "devices_usb", "devices_scan"]
MOUNT = {"DriveLetter": "E", "FileSystemLabel": "PRIVATE backup", "FileSystem": "NTFS",
         "DriveType": "Fixed", "Size": 4096}
DEVICE = {"Name": "PRIVATE receiver", "InstanceId": "USB\\PRIVATE", "Status": "OK"}


def completed(stdout="", returncode=0, stderr=""):
    return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)


def output(cmd):
    command = cmd[-1]
    if cmd == ["arp", "-a"]:
        return completed("192.0.2.20 aa-bb-cc-dd-ee-ff dynamic\n")
    if "Select-Object Number" in command:
        return completed(json.dumps({"Number": 3, "FriendlyName": "PRIVATE SSD"}))
    if "Get-Partition -DiskNumber" in command:
        return completed(json.dumps("E"))
    if "Get-Volume" in command:
        return completed(json.dumps(MOUNT))
    if "Format-List" in command:
        return completed("PRIVATE raw USB output", stderr="PRIVATE diagnostics")
    return completed(json.dumps(DEVICE))


@pytest.fixture
def house(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "pin.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    S.save_pin_config("a" * 64, "b" * 64)
    monkeypatch.setattr(routes.platform, "system", lambda: "Windows")
    monkeypatch.setattr(routes, "hidden_process_kwargs", lambda: {"creationflags": 0x08000000})
    run = Mock(side_effect=lambda cmd, **kwargs: output(cmd))
    mesh = Mock(return_value={"private-node": {"ip": "192.0.2.20", "display_name": "PRIVATE host", "is_host": True}})
    monkeypatch.setattr(routes.subprocess, "run", run)
    monkeypatch.setattr(S, "load_mesh_directory", mesh)
    app = FastAPI(); app.include_router(routes.router)
    clients = []
    def browser(mode="pin-local"):
        local = mode not in {"pin-https", "pin-off-lan", "remote-http"}
        origin = "http://localhost:8000" if local else ("http" if mode == "remote-http" else "https") + "://192.0.2.5:8443"
        if mode in {"open-local", "pin-off-lan"}:
            monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
        client = TestClient(app, base_url=origin, client=("127.0.0.1" if local else "192.0.2.8", 40000),
                            headers={"Origin": origin}, raise_server_exceptions=False)
        token = None if mode in {"anonymous", "open-local", "pin-off-lan"} else S.create_session_token("owner")
        if token: client.headers["Cookie"] = "tli_session=" + token
        if mode == "revoked": S.revoke_session_token(token)
        if mode == "expired": S._active_sessions[token]["expiry"] = 0
        if mode == "cross-origin": client.headers["Origin"] = "https://unrelated.invalid"
        if mode == "same-site": client.headers["Sec-Fetch-Site"] = "same-site"
        if mode == "proxy": client.headers["X-Forwarded-For"] = "127.0.0.1"
        if mode == "peer": client.headers["X-TLI-Peer-Signature"] = "synthetic"
        if mode == "bearer": client.headers["Authorization"] = "Bearer paired-device-credential"
        if mode == "duplicate-authorization": client.headers.update([("Authorization", "Bearer first"), ("Authorization", "Bearer second")])
        clients.append(client)
        return client, token
    def lose(token, kind):
        if kind == "revoke": S.revoke_session_token(token)
        elif kind == "pin-change": monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
        else:
            def unavailable(): raise HTTPException(503, "Security configuration unavailable")
            monkeypatch.setattr(S, "load_pin_config", unavailable)
    yield SimpleNamespace(browser=browser, lose=lose, run=run, mesh=mesh)
    for client in clients: client.close()


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("mode", ["anonymous", "pin-off-lan", "revoked", "expired", "cross-origin", "same-site",
                                  "proxy", "peer", "bearer", "duplicate-authorization", "remote-http"])
def test_private_observations_deny_before_any_probe_or_mesh_read(house, path, mode):
    client, _ = house.browser(mode)
    result = client.get(path)
    assert result.status_code == (401 if mode in {"anonymous", "revoked", "expired"} else 403), result.text
    assert result.headers["cache-control"] == "no-store" and "PRIVATE" not in result.text
    house.run.assert_not_called(); house.mesh.assert_not_called()


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("mode", ["open-local", "pin-local", "pin-https"])
def test_supported_browser_observations_preserve_payload_and_hidden_probe_contract(house, path, mode):
    client, _ = house.browser(mode)
    result = client.get(path)
    assert result.status_code == 200, result.text
    assert result.headers["cache-control"] == "no-store"
    value = result.json()
    if path == "/devices/usb":
        assert value["count"] == 1 and value["devices"][0]["name"] == "PRIVATE SSD (PRIVATE backup)"
        assert value["devices"][0]["mount_path"] == "E:\\"
        assert value["storage_mounts"][0]["label"] == MOUNT["FileSystemLabel"]
    elif path == "/devices/usb/raw":
        assert value["ok"] is True and value["stdout"] == "PRIVATE raw USB output"
    elif path == "/devices/scan":
        assert value["arp_scan_ok"] is True
        assert value["arp_table"][0]["mesh_device"]["display_name"] == "PRIVATE host"
        assert house.run.call_args.args[0] == ["arp", "-a"]
    else:
        assert value["devices"] == [{"name": DEVICE["Name"], "instance_id": DEVICE["InstanceId"], "status": "OK"}]
    for call in house.run.call_args_list:
        assert call.kwargs["creationflags"] == 0x08000000 and call.kwargs["shell"] is False


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("kind,status", [("revoke", 401), ("pin-change", 401), ("security-unavailable", 503)])
@pytest.mark.parametrize("failure", [False, True], ids=["returned", "failed"])
def test_probe_completion_or_error_cannot_disclose_or_start_followups_after_access_loss(house, path, kind, status, failure):
    client, token = house.browser()
    def run(cmd, **kwargs):
        house.lose(token, kind)
        if failure: raise OSError("PRIVATE probe failed")
        return output(cmd)
    house.run.side_effect = run
    result = client.get(path)
    assert result.status_code == status and "PRIVATE" not in result.text
    assert result.headers["cache-control"] == "no-store" and house.run.call_count == 1


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("phase", ["admission", "probe-completion"])
def test_pin_off_on_off_cannot_restore_original_observation_authority(house, monkeypatch, path, phase):
    client, _ = house.browser("open-local")
    def cycle():
        monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
        S.revoke_all_sessions()
        monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
        S.revoke_all_sessions()
    if phase == "admission":
        def load(): cycle(); return {"enabled": False}
        monkeypatch.setattr(S, "load_pin_config", load)
    else:
        def run(cmd, **kwargs): cycle(); return output(cmd)
        house.run.side_effect = run
    result = client.get(path)
    assert result.status_code == 401 and "PRIVATE" not in result.text
    assert result.headers["cache-control"] == "no-store"
    assert house.run.call_count == (0 if phase == "admission" else 1)


@pytest.mark.parametrize("path,service", zip(PATHS, SERVICES))
@pytest.mark.parametrize("failure", [False, True], ids=["returned", "failed"])
def test_final_service_response_or_error_rechecks_original_authority(house, monkeypatch, path, service, failure):
    client, token = house.browser()
    def observed(*, check):
        S.revoke_session_token(token)
        if failure: raise RuntimeError("PRIVATE processing error")
        return {"private": "PRIVATE observation"}
    monkeypatch.setattr(routes, service, observed)
    result = client.get(path)
    assert result.status_code == 401 and "PRIVATE" not in result.text
    house.run.assert_not_called(); house.mesh.assert_not_called()


def test_work_waiting_before_probe_rechecks_before_os_dispatch(house, monkeypatch):
    client, token = house.browser(); entered = Event(); release = Event(); original = routes._probe
    def waiting(cmd, timeout, check):
        entered.set(); assert release.wait(5)
        return original(cmd, timeout, check)
    monkeypatch.setattr(routes, "_probe", waiting)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(client.get, "/devices/usb")
        try:
            assert entered.wait(5)
            S.revoke_session_token(token)
        finally: release.set()
        result = pending.result(5)
    assert result.status_code == 401
    house.run.assert_not_called()


@pytest.mark.parametrize("failure", [False, True], ids=["returned", "failed"])
def test_lost_access_during_mesh_read_stops_arp_probe(house, failure):
    client, token = house.browser()
    def load():
        S.revoke_session_token(token)
        if failure: raise OSError("PRIVATE registry read failure")
        return {"private": {"ip": "192.0.2.20"}}
    house.mesh.side_effect = load
    result = client.get("/devices/scan")
    assert result.status_code == 401 and "PRIVATE" not in result.text
    house.run.assert_not_called()


@pytest.mark.parametrize("boundary", [1, 2, 3])
def test_usb_inventory_stops_before_next_disk_or_partition_probe(house, boundary):
    client, token = house.browser(); calls = []
    def run(cmd, **kwargs):
        calls.append(cmd)
        result = output(cmd)
        if "Select-Object Number" in cmd[-1]:
            result = completed(json.dumps([{"Number": 3, "FriendlyName": "PRIVATE first"},
                                           {"Number": 4, "FriendlyName": "PRIVATE second"}]))
        if len(calls) == boundary: S.revoke_session_token(token)
        return result
    house.run.side_effect = run
    result = client.get("/devices/usb")
    assert result.status_code == 401 and "PRIVATE" not in result.text
    assert len(calls) == boundary


def test_revocation_on_failed_initial_usb_query_prevents_removable_fallback(house):
    client, token = house.browser()
    house.run.side_effect = lambda *args, **kwargs: (S.revoke_session_token(token), completed(returncode=1))[1]
    assert client.get("/devices/usb").status_code == 401
    assert house.run.call_count == 1


@pytest.mark.parametrize("failure", [False, True], ids=["returned", "failed"])
def test_macos_stat_probe_loss_stops_next_mount_and_hides_results(house, monkeypatch, failure):
    client, token = house.browser()
    monkeypatch.setattr(routes.platform, "system", lambda: "Darwin")
    house.run.return_value = completed("/dev/first on /Volumes/PRIVATE-one (apfs)\n/dev/second on /Volumes/PRIVATE-two (apfs)\n")
    house.run.side_effect = None
    def statvfs(path):
        S.revoke_session_token(token)
        if failure: raise OSError("PRIVATE volume error")
        return SimpleNamespace(f_blocks=10, f_frsize=4096)
    stat = Mock(side_effect=statvfs)
    monkeypatch.setattr(routes.os, "statvfs", stat, raising=False)
    result = client.get("/devices/usb")
    assert result.status_code == 401 and "PRIVATE" not in result.text
    assert stat.call_count == 1 and house.run.call_count == 1


@pytest.mark.parametrize("phase", ["open", "read", "read-error"])
def test_linux_mount_reader_stops_and_closes_on_revocation(house, monkeypatch, phase):
    client, token = house.browser()
    monkeypatch.setattr(routes.platform, "system", lambda: "Linux")
    class Mounts(io.StringIO):
        reads = 0
        def __next__(self):
            self.reads += 1
            S.revoke_session_token(token)
            if phase == "read-error": raise OSError("PRIVATE read failed")
            return super().__next__()
    stream = Mounts("/dev/first /media/PRIVATE-one ext4\n/dev/second /media/PRIVATE-two ext4\n")
    def open_mounts(*args, **kwargs):
        assert args[0] == "/proc/mounts"
        if phase == "open": S.revoke_session_token(token)
        return stream
    monkeypatch.setattr(routes, "open", open_mounts, raising=False)
    result = client.get("/devices/usb")
    assert result.status_code == 401 and "PRIVATE" not in result.text
    assert stream.closed and stream.reads == (0 if phase == "open" else 1)
    house.run.assert_not_called()


@pytest.mark.parametrize("number", ["3; PRIVATE", True, -1, None])
def test_partition_followup_accepts_only_nonnegative_integer_disk_numbers(house, number):
    client, _ = house.browser()
    def run(cmd, **kwargs):
        if "Select-Object Number" in cmd[-1]:
            return completed(json.dumps({"Number": number, "FriendlyName": "PRIVATE disk"}))
        return output(cmd)
    house.run.side_effect = run
    result = client.get("/devices/usb")
    assert result.status_code == 200 and result.json()["count"] == 1
    assert house.run.call_count == 2
    assert not any("Get-Partition -DiskNumber" in call.args[0][-1] for call in house.run.call_args_list)


@pytest.mark.parametrize("system,raw,expected", [
    ("Linux", "Bus 001 Device 002: ID abcd:1234 PRIVATE receiver\n", {"name": "PRIVATE receiver", "vendor_id": "abcd"}),
    ("Darwin", json.dumps({"SPUSBDataType": [{"_name": "PRIVATE receiver", "vendor_id": "abcd", "product_id": "1234", "manufacturer": "Vendor"}]}),
     {"name": "PRIVATE receiver", "vendor_id": "abcd", "product_id": "1234", "manufacturer": "Vendor"})])
def test_other_platform_usb_snapshot_shapes_remain_compatible(house, monkeypatch, system, raw, expected):
    client, _ = house.browser(); monkeypatch.setattr(routes.platform, "system", lambda: system)
    house.run.side_effect = None; house.run.return_value = completed(raw)
    result = client.get("/devices/usb/list")
    assert result.status_code == 200 and result.json()["devices"] == [expected]
    assert house.run.call_count == 1
