"""Background printer helpers must not create Windows console windows.

Every subprocess boundary is replaced here; these tests never discover, print,
scan, ping, or open an application on the host.
"""
from __future__ import annotations

import subprocess
from types import SimpleNamespace

import pytest

from routers import printers, printshop


@pytest.fixture
def processes(monkeypatch):
    calls = []
    replies = []

    def invoke(command, **kwargs):
        calls.append((command, kwargs))
        if replies:
            return replies.pop(0)
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    for module in (printers, printshop):
        monkeypatch.setattr(module, "subprocess", SimpleNamespace(run=invoke, Popen=invoke))
        monkeypatch.setattr(module, "hidden_process_kwargs", lambda: {"creationflags": 0x08000000})
    monkeypatch.setattr(printers, "platform", SimpleNamespace(system=lambda: "Windows"))
    return calls, replies


def assert_hidden(call, timeout):
    command, options = call
    assert command[0] in ("powershell", "ping")
    assert options == {
        "capture_output": True, "text": True, "timeout": timeout,
        "creationflags": 0x08000000,
    }


def test_printer_json_helper_keeps_output_and_errors(processes):
    calls, replies = processes
    replies.append(subprocess.CompletedProcess([], 0, '{"printers": []}', ""))
    assert printers._ps_json("Get-Printer", timeout_s=7) == {"printers": []}
    assert_hidden(calls[-1], 7)
    assert calls[-1][0][-1] == "Get-Printer"
    replies.append(subprocess.CompletedProcess([], 1, "", "printer query failed"))
    with pytest.raises(RuntimeError, match="printer query failed"):
        printers._ps_json("Get-Printer")


def test_scan_app_hides_wrapper_and_preserves_visible_destination(processes):
    calls, _ = processes
    printers._open_windows_scan_app()
    assert_hidden(calls[-1], 8)
    script = calls[-1][0][-1]
    assert "Microsoft.WindowsScan" in script
    assert "WindowStyle" not in script


def test_requested_printer_settings_remains_visible(processes):
    calls, _ = processes
    assert printers.open_add_printer(check=lambda: None) == {"ok": True}
    assert calls == [(["explorer.exe", "ms-settings:printers"], {"close_fds": True})]


def test_printer_discovery_hides_console_before_powershell_starts(processes, monkeypatch):
    calls, _ = processes
    monkeypatch.setattr(printers, "get_printers", lambda **kwargs: [{"name": "Sample"}])
    assert printers.discover_printers(check=lambda: None) == [{"name": "Sample"}]
    assert calls[0][0][0] == "powershell"
    assert calls[0][1] == {"close_fds": True, "creationflags": 0x08000000}


def test_printer_ping_preserves_reachability_result(processes):
    calls, replies = processes
    assert printers._ping("192.0.2.8", timeout_s=2) is True
    assert_hidden(calls[-1], 2)
    assert calls[-1][0] == ["ping", "-n", "1", "192.0.2.8"]
    replies.append(subprocess.CompletedProcess([], 1, "", ""))
    assert printers._ping("192.0.2.8") is False


def test_printshop_enumeration_keeps_default_and_scanner_metadata(processes):
    calls, replies = processes
    replies.extend([
        subprocess.CompletedProcess([], 0, "Sample\n", ""),
        subprocess.CompletedProcess([], 0, '{"Name":"Sample","PrinterStatus":"Normal"}', ""),
    ])
    assert printshop._printers_powershell() == [{
        "name": "Sample", "default": True, "source": "powershell",
        "virtual": False, "status": "Normal",
    }]
    assert_hidden(calls[0], 8)
    assert_hidden(calls[1], 12)
    replies.append(subprocess.CompletedProcess([], 0, '{"id":"sample-scanner","name":"Sample"}', ""))
    assert printshop._scanners_wia() == [{"id": "sample-scanner", "name": "Sample", "source": "wia"}]
    assert_hidden(calls[-1], 12)


def test_print_job_hides_both_shell_and_background_print_handler(processes):
    calls, replies = processes
    printshop._print_windows("C:/sample.pdf", "Sample", 2, False, "long")
    assert_hidden(calls[-1], 90)
    script = calls[-1][0][-1]
    assert '-Verb PrintTo -ArgumentList $pn -WindowStyle Hidden -Wait' in script
    assert "TwoSidedLongEdge" in script
    assert "NumberOfCopies = 2" in script
    replies.append(subprocess.CompletedProcess([], 1, "", "print failed"))
    with pytest.raises(RuntimeError, match="print failed"):
        printshop._print_windows("C:/sample.pdf", "Sample", 1, True)


def test_scan_job_hides_shell_and_reports_driver_failure(processes, tmp_path):
    calls, replies = processes
    replies.append(subprocess.CompletedProcess([], 1, "", "PowerShell wrapper\nScanner offline"))
    with pytest.raises(RuntimeError, match="^Scanner offline$"):
        printshop._scan_wia("sample-scanner", str(tmp_path / "scan.png"), 300, "gray")
    assert_hidden(calls[-1], 120)
    assert "sample-scanner" in calls[-1][0][-1]
    assert not (tmp_path / "scan.png").exists()
