"""Private printer access and owned scans, without any real device or process."""
import asyncio
import json
import re
import subprocess
import tempfile
from functools import partial
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.datastructures import UploadFile

import companion_auth
import tli_state as S
from routers import printers, printshop


_REAL_PRINT_WINDOWS = printshop._print_windows
_REAL_SCAN_WIA = printshop._scan_wia
PRIVATE_ENDPOINTS = [
    ("GET", "/api/printers", {}),
    ("GET", "/api/printers/context", {}),
    ("GET", "/api/printers/health", {}),
    ("GET", "/api/printers/supplies", {}),
    ("GET", "/api/printers/snmp/community", {}),
    ("POST", "/api/printers/snmp/community", {"json": {"default_community": "fixture"}}),
    ("POST", "/api/printers/ip_override", {"json": {"printer_name": "Fixture", "ip": "192.0.2.30"}}),
    ("POST", "/api/printers/test_print", {}),
    ("POST", "/api/printers/open_add", {}),
    ("POST", "/api/printers/open_scan", {}),
    ("POST", "/api/printers/discover", {}),
    ("GET", "/printshop/printers", {}),
    ("GET", "/printshop/scanners", {}),
    ("POST", "/printshop/print", {"data": {"printer": "Fixture"}, "files": {"file": ("fixture.pdf", b"fixture document", "application/pdf")}}),
    ("POST", "/printshop/scan", {"data": {"scanner_id": "fixture-scanner"}}),
    ("GET", "/printshop/scan/fixture-token", {}),
    ("DELETE", "/printshop/scan/fixture-token", {}),
]


@pytest.fixture
def printing(app, monkeypatch, tmp_path):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "log_debug", Mock())
    monkeypatch.setattr(printshop, "_scan_store", {})
    monkeypatch.setattr(printshop, "PLATFORM", "Windows")
    monkeypatch.setattr(printers, "platform", SimpleNamespace(system=lambda: "Windows"))
    monkeypatch.setattr(printers, "SNMP_CFG_PATH", tmp_path / "snmp.json")
    monkeypatch.setattr(printers, "_SUPPLIES_CACHE", {})
    pin = {"enabled": False}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(pin))
    temporary = tmp_path / "temporary"
    temporary.mkdir()
    monkeypatch.setattr(printshop, "tempfile", SimpleNamespace(
        NamedTemporaryFile=partial(tempfile.NamedTemporaryFile, dir=temporary),
        mkdtemp=partial(tempfile.mkdtemp, dir=temporary),
    ))
    process = Mock(side_effect=AssertionError("A real printer process must never run"))
    for module in (printers, printshop):
        monkeypatch.setattr(module, "subprocess", SimpleNamespace(run=process, Popen=process))
    hardware = {}
    for module, names in (
        (printshop, ("_list_printers", "_list_scanners", "_print_windows", "_print_cups", "_scan_wia", "_scan_sane")),
        (printers, ("_ps_json", "_cups_list_printers", "_windows_job_counts", "_cups_job_counts",
                    "_print_text_windows_default_printer", "_print_text_cups", "_open_windows_scan_app",
                    "_open_scan_posix", "_open_add_printer_posix", "_ping", "_snmp_walk")),
    ):
        for name in names:
            boundary = Mock(side_effect=AssertionError("Unconfigured hardware boundary: " + name))
            monkeypatch.setattr(module, name, boundary)
            hardware[name] = boundary
    clients = []

    def browser(*, pin_enabled=False, remote=False, owner=None):
        pin["enabled"] = pin_enabled
        origin = "https://192.0.2.10:8443" if remote else "http://localhost:8000"
        client = TestClient(app, base_url=origin,
                            client=("192.0.2.20" if remote else "127.0.0.1", 12345),
                            headers={"Origin": origin, "Sec-Fetch-Site": "same-origin"})
        token = S.create_session_token(owner) if owner else None
        if token:
            client.headers["Cookie"] = "tli_session=" + token
        clients.append(client)
        return client, token

    def acquire(scanner, path, resolution, color):
        Path(path).write_bytes(b"fixture private scan")

    yield SimpleNamespace(browser=browser, hardware=hardware, process=process, root=tmp_path,
                          temporary=temporary, pin=pin, acquire=acquire)
    for client in clients:
        client.close()


@pytest.mark.parametrize("method,path,kwargs", PRIVATE_ENDPOINTS,
                         ids=[method + " " + path for method, path, _ in PRIVATE_ENDPOINTS])
@pytest.mark.parametrize("mode", ["pin-anonymous", "pin-off-lan"])
def test_private_printer_routes_deny_before_hardware_or_config(printing, monkeypatch, mode, method, path, kwargs):
    client, _ = printing.browser(pin_enabled=mode == "pin-anonymous", remote=mode == "pin-off-lan")
    read = Mock(side_effect=AssertionError("Denied request must not read printer secrets"))
    monkeypatch.setattr(printers, "_load_snmp_cfg", read)

    response = client.request(method, path, **kwargs)

    assert response.status_code == (401 if mode == "pin-anonymous" else 403), response.text
    read.assert_not_called()
    printing.process.assert_not_called()
    for boundary in printing.hardware.values():
        boundary.assert_not_called()
    assert list(printing.temporary.iterdir()) == []


@pytest.mark.parametrize("name", ["test_print", "open_add", "open_scan", "discover"])
def test_legacy_get_actions_are_retired_without_host_dispatch(printing, name):
    client, _ = printing.browser(pin_enabled=True)
    response = client.get("/api/printers/" + name)
    assert response.status_code == 405
    assert response.headers["allow"] == "POST"
    printing.process.assert_not_called()
    for boundary in printing.hardware.values():
        boundary.assert_not_called()


@pytest.mark.parametrize("name,boundary", [
    ("test_print", "_print_text_windows_default_printer"),
    ("open_scan", "_open_windows_scan_app"),
    ("open_add", None),
    ("discover", None),
])
def test_authorized_bodyless_post_controls_preserve_ui_contract(printing, name, boundary):
    env = printing
    client, _ = env.browser(pin_enabled=True, owner="alice")
    env.process.side_effect = None
    env.process.return_value = SimpleNamespace(returncode=0)
    if boundary:
        env.hardware[boundary].side_effect = None
    env.hardware["_ps_json"].side_effect = None
    env.hardware["_ps_json"].return_value = {"printers": [{"Name": "Fixture printer"}]}

    response = client.post("/api/printers/" + name)

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    if name == "discover":
        assert response.json()[0]["name"] == "Fixture printer"
        env.process.assert_called_once()
    else:
        assert response.json() == {"ok": True}
        if boundary:
            env.hardware[boundary].assert_called_once()
        else:
            env.process.assert_called_once_with(["explorer.exe", "ms-settings:printers"], close_fds=True)


def test_private_printer_config_edits_preserve_unrelated_saved_fields(printing):
    env = printing
    printers.SNMP_CFG_PATH.write_text(json.dumps({
        "default_community": "fixture-default", "custom": {"preserve": True},
        "printers": {"Fixture": {"hostname": "fixture-host", "custom": "keep"}},
    }), encoding="utf-8")
    client, _ = env.browser()
    result = client.post("/api/printers/snmp/community", json={"printer_name": "Fixture", "community": "fixture-private"})
    assert result.status_code == 200, result.text
    result = client.post("/api/printers/ip_override", json={"printer_name": "Fixture", "ip": "192.0.2.30"})
    assert result.status_code == 200, result.text
    result = client.get("/api/printers/snmp/community")
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    assert result.json()["cfg"] == {
        "default_community": "fixture-default", "custom": {"preserve": True},
        "printers": {"Fixture": {"hostname": "fixture-host", "custom": "keep",
                                    "community": "fixture-private", "ip": "192.0.2.30"}},
    }
    env.process.assert_not_called()


@pytest.mark.parametrize("mode", ["open-local", "pin-local", "pin-https-lan"])
def test_authorized_multipart_print_and_owned_scan_lifecycle(printing, mode):
    env = printing
    client, _ = env.browser(pin_enabled=mode != "open-local", remote=mode == "pin-https-lan",
                            owner="alice" if mode != "open-local" else None)
    printed_paths = []

    def print_document(path, *options):
        printed_paths.append(Path(path))
        assert Path(path).read_bytes() == b"reviewed fixture document"
        assert options == ("Fixture printer", 2, False, "long", 125, "landscape", "high")

    env.hardware["_print_windows"].side_effect = print_document
    response = client.post("/printshop/print", files={"file": ("sample.pdf", b"reviewed fixture document", "application/pdf")},
                           data={"printer": "Fixture printer", "copies": "2", "color": "false", "duplex": "long",
                                 "scale": "125", "orientation": "landscape", "quality": "high"})
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "sent"
    assert response.headers["cache-control"] == "no-store"
    assert len(printed_paths) == 1 and not printed_paths[0].exists()

    env.hardware["_scan_wia"].side_effect = env.acquire
    response = client.post("/printshop/scan", data={"scanner_id": "chosen-scanner", "resolution": "600", "color_mode": "gray"})
    assert response.status_code == 200, response.text
    token = response.json()["token"]
    record = printshop._scan_store[token]
    assert record.owner == ("alice" if mode != "open-local" else "local")
    assert env.hardware["_scan_wia"].call_args.args == ("chosen-scanner", record.path, 600, "gray")
    downloaded = client.get("/printshop/scan/" + token)
    assert downloaded.status_code == 200, downloaded.text
    assert downloaded.content == b"fixture private scan"
    assert downloaded.headers["cache-control"] == "no-store"
    assert downloaded.headers["content-type"] == "image/png"
    assert "attachment" in downloaded.headers["content-disposition"]
    assert client.delete("/printshop/scan/" + token).json() == {"status": "deleted"}
    assert token not in printshop._scan_store
    assert not Path(record.path).exists()


def test_scan_tokens_are_owner_scoped_and_same_owner_can_reopen(printing):
    env = printing
    alice, _ = env.browser(pin_enabled=True, owner="alice")
    env.hardware["_scan_wia"].side_effect = env.acquire
    token = alice.post("/printshop/scan", data={"scanner_id": "fixture"}).json()["token"]
    record = printshop._scan_store[token]
    bob, _ = env.browser(pin_enabled=True, owner="bob")
    for method in ("GET", "DELETE"):
        response = bob.request(method, "/printshop/scan/" + token)
        assert response.status_code == 404
        assert b"fixture private scan" not in response.content
    assert Path(record.path).read_bytes() == b"fixture private scan"
    assert printshop._scan_store[token] is record
    alice_again, _ = env.browser(pin_enabled=True, owner="alice")
    assert alice_again.get("/printshop/scan/" + token).content == b"fixture private scan"


@pytest.mark.parametrize("method", ["GET", "DELETE"])
def test_legacy_unowned_scan_records_and_files_are_preserved(printing, method):
    old = printing.root / "legacy.png"
    old.write_bytes(b"preexisting unowned scan")
    entry = (str(old), "image/png")
    printshop._scan_store["legacy"] = entry
    client, _ = printing.browser()
    assert client.request(method, "/printshop/scan/legacy").status_code == 404
    assert printshop._scan_store["legacy"] is entry
    assert old.read_bytes() == b"preexisting unowned scan"


@pytest.mark.parametrize("attempt", ["bearer-and-cookie", "cross-origin", "proxy", "revoked-cookie"])
def test_printer_controls_require_live_browser_authority(printing, attempt):
    env = printing
    client, token = env.browser(pin_enabled=True, remote=attempt == "bearer-and-cookie", owner="alice")
    headers = {}
    if attempt == "bearer-and-cookie":
        origin = str(client.base_url).rstrip("/")
        invitation, _ = companion_auth.create_pairing("alice", origin, "f" * 64)
        device = companion_auth.redeem_pairing(invitation, origin, "f" * 64, "Fixture phone", "test")
        headers["Authorization"] = "Bearer " + device["credential"]
    elif attempt == "cross-origin":
        headers["Origin"] = "https://unrelated.example.test"
    elif attempt == "proxy":
        headers["Forwarded"] = "for=127.0.0.1"
    else:
        S.revoke_session_token(token)
    response = client.post("/api/printers/test_print", headers=headers)
    assert response.status_code == (401 if attempt == "revoked-cookie" else 403)
    env.hardware["_print_text_windows_default_printer"].assert_not_called()


@pytest.mark.parametrize("stage", ["upload-read", "print-return", "scan-return", "inventory-return", "config-read"])
def test_revocation_blocks_followup_effects_and_private_results(printing, monkeypatch, stage):
    env = printing
    client, token = env.browser(pin_enabled=True, owner="alice")
    if stage == "upload-read":
        original = UploadFile.read

        async def read_and_revoke(upload, *args, **kwargs):
            result = await original(upload, *args, **kwargs)
            S.revoke_session_token(token)
            return result

        monkeypatch.setattr(UploadFile, "read", read_and_revoke)
        response = client.post("/printshop/print", data={"printer": "Fixture"}, files={"file": ("sample.pdf", b"private upload")})
        env.hardware["_print_windows"].assert_not_called()
    elif stage == "print-return":
        env.hardware["_print_windows"].side_effect = lambda *args: S.revoke_session_token(token)
        response = client.post("/printshop/print", data={"printer": "Fixture"}, files={"file": ("sample.pdf", b"private upload")})
        env.hardware["_print_windows"].assert_called_once()
    elif stage == "scan-return":
        def scan_and_revoke(*args):
            env.acquire(*args)
            S.revoke_session_token(token)

        env.hardware["_scan_wia"].side_effect = scan_and_revoke
        response = client.post("/printshop/scan", data={"scanner_id": "fixture"})
        assert printshop._scan_store == {}
    elif stage == "inventory-return":
        def list_and_revoke(*args, **kwargs):
            S.revoke_session_token(token)
            return {"printers": [{"Name": "private inventory"}]}

        env.hardware["_ps_json"].side_effect = list_and_revoke
        response = client.get("/api/printers/context")
        env.hardware["_windows_job_counts"].assert_not_called()
    else:
        def config_and_revoke():
            S.revoke_session_token(token)
            return {"default_community": "private community", "printers": {}}

        monkeypatch.setattr(printers, "_load_snmp_cfg", config_and_revoke)
        saved = Mock(side_effect=AssertionError("Revoked request must not save config"))
        monkeypatch.setattr(printers, "_save_snmp_cfg", saved)
        response = client.post("/api/printers/snmp/community", json={"default_community": "changed"})
        saved.assert_not_called()
    assert response.status_code == 401, response.text
    assert "private" not in response.text
    assert list(env.temporary.iterdir()) == []


@pytest.mark.parametrize("spec_version", ["2.0", "2.4"])
def test_scan_download_stops_between_chunks_and_cannot_use_pathsend(tmp_path, spec_version):
    path = tmp_path / "large.png"
    path.write_bytes(b"x" * (3 * printshop._AuthorizedScanResponse.chunk_size))
    live = [True]
    messages = []

    def check():
        if not live[0]:
            raise HTTPException(401, "Fixture session revoked")

    async def send(message):
        messages.append(message)
        if message["type"] == "http.response.body" and message.get("body"):
            live[0] = False

    request_received = False

    async def receive():
        nonlocal request_received
        if not request_received:
            request_received = True
            return {"type": "http.request", "body": b"", "more_body": False}
        # A real ASGI receive waits for a disconnect after the request ends.
        # Returning requests forever starves FileResponse's concurrent sender.
        await asyncio.Event().wait()
        raise AssertionError("The synthetic connection never disconnects")

    response = printshop._AuthorizedScanResponse(path, check=check, media_type="image/png")
    with pytest.raises(HTTPException) as error:
        asyncio.run(response({"type": "http", "method": "GET", "headers": [],
                              "asgi": {"version": "3.0", "spec_version": spec_version},
                              "extensions": {"http.response.pathsend": {}}}, receive, send))
    assert error.value.status_code == 401
    chunks = [message["body"] for message in messages if message["type"] == "http.response.body"]
    assert chunks == [b"x" * response.chunk_size]
    assert all(message["type"] != "http.response.pathsend" for message in messages)


def test_scan_missing_file_check_revalidates_before_disclosing_status(printing, monkeypatch):
    env = printing
    client, browser_token = env.browser(pin_enabled=True, owner="alice")
    env.hardware["_scan_wia"].side_effect = env.acquire
    scan_token = client.post("/printshop/scan", data={"scanner_id": "fixture"}).json()["token"]
    record = printshop._scan_store[scan_token]
    exists = Path.exists

    def exists_and_revoke(path):
        if str(path) == record.path:
            S.revoke_session_token(browser_token)
            return False
        return exists(path)

    monkeypatch.setattr(Path, "exists", exists_and_revoke)
    response = client.get("/printshop/scan/" + scan_token)
    assert response.status_code == 401
    assert "no longer available" not in response.text
    assert Path(record.path).read_bytes() == b"fixture private scan"


@pytest.mark.parametrize("operation", ["print", "scan", "open_scan"])
def test_revocation_withholds_private_driver_errors(printing, operation):
    env = printing
    client, token = env.browser(pin_enabled=True, owner="alice")

    def fail_and_revoke(*args):
        S.revoke_session_token(token)
        raise RuntimeError("private driver error")

    if operation == "print":
        env.hardware["_print_windows"].side_effect = fail_and_revoke
        response = client.post("/printshop/print", data={"printer": "Fixture"}, files={"file": ("sample.pdf", b"fixture")})
    elif operation == "scan":
        env.hardware["_scan_wia"].side_effect = fail_and_revoke
        response = client.post("/printshop/scan", data={"scanner_id": "fixture"})
    else:
        env.hardware["_open_windows_scan_app"].side_effect = fail_and_revoke
        response = client.post("/api/printers/open_scan")
    assert response.status_code == 401, response.text
    assert "private driver error" not in response.text
    assert list(env.temporary.iterdir()) == []


def test_supplies_revocation_stops_remaining_network_probes(printing, monkeypatch):
    env = printing
    client, token = env.browser(pin_enabled=True, owner="alice")
    monkeypatch.setattr(printers, "_SNMP_AVAILABLE", True)
    env.hardware["_ps_json"].side_effect = None
    env.hardware["_ps_json"].return_value = {
        "printers": [{"Name": "Fixture", "PortName": "fixture-port"}],
        "ports": [{"Name": "fixture-port", "PrinterHostAddress": "192.0.2.30"}],
    }

    def probe_and_revoke(*args, **kwargs):
        S.revoke_session_token(token)
        return {"fixture": "private supply data"}

    env.hardware["_snmp_walk"].side_effect = probe_and_revoke
    response = client.get("/api/printers/supplies")
    assert response.status_code == 401, response.text
    assert "private supply data" not in response.text
    env.hardware["_snmp_walk"].assert_called_once()
    assert printers._SUPPLIES_CACHE == {}


def _literal_assignment(script, variable):
    match = re.search(r"\$" + variable + r" = ('(?:[^']|'')*')", script)
    assert match, script
    return match.group(1)[1:-1].replace("''", "'")


def test_windows_print_names_and_paths_remain_literal_data(printing):
    name = "Printer 'quote' $(Write-Output sentinel) `tick \"double\""
    path = "C:\\fixture's\\$(Write-Output sentinel)`name.pdf"
    printing.process.side_effect = None
    printing.process.return_value = subprocess.CompletedProcess([], 0, "", "")

    _REAL_PRINT_WINDOWS(path, name, 1, True)

    script = printing.process.call_args.args[0][-1]
    assert _literal_assignment(script, "pn") == name
    literal = "'" + path.replace("'", "''") + "'"
    assert "Start-Process -FilePath " + literal + " -Verb PrintTo" in script
    assert '$pn = "' not in script


def test_wia_explicit_target_is_literal_and_missing_target_cannot_fall_back(printing):
    scanner = "missing 'scanner' $(Write-Output sentinel) `tick"
    path = str(printing.root / "owner's $(sentinel)`scan.png")
    printing.process.side_effect = None
    printing.process.return_value = subprocess.CompletedProcess([], 1, "", "The selected scanner is unavailable.")

    with pytest.raises(RuntimeError, match="selected scanner is unavailable"):
        _REAL_SCAN_WIA(scanner, path, 300, "color")

    script = printing.process.call_args.args[0][-1]
    assert _literal_assignment(script, "requestedId") == scanner
    assert "if ($requestedId -and -not $found) { throw 'The selected scanner is unavailable." in script
    assert "if (-not $requestedId) {" in script
    assert "if (-not $found) {\n        foreach" not in script
    assert ".SaveFile(" + printshop._ps_literal(str(Path(path).with_suffix(".bmp"))) + ")" in script
    assert "FromFile(" + printshop._ps_literal(str(Path(path).with_suffix(".bmp"))) + ")" in script
    assert not Path(path).exists()
    printing.process.assert_called_once()
