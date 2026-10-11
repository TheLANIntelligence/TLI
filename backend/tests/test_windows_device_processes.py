"""Device and tool subprocesses stay headless while retaining their UI results."""
from __future__ import annotations

import asyncio
import json
import subprocess
from types import SimpleNamespace

import pytest

from routers import device_routes, tool_routes


NO_WINDOW = 0x08000000


@pytest.fixture
def headless_windows(monkeypatch):
    # Mock the shared helper's platform boundary so these integration checks run
    # on non-Windows CI too. No operating-system command is actually launched.
    monkeypatch.setattr(device_routes.platform, "system", lambda: "Windows")
    for module in (device_routes, tool_routes):
        monkeypatch.setattr(module, "hidden_process_kwargs", lambda: {"creationflags": NO_WINDOW})


def _completed(stdout="", stderr="", returncode=0):
    return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)


def _capture(monkeypatch, results):
    calls = []
    remaining = iter(results)

    def run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        assert kwargs["creationflags"] == NO_WINDOW
        assert kwargs["capture_output"] is True
        assert kwargs["text"] is True
        result = next(remaining)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(subprocess, "run", run)
    return calls


def test_usb_mount_inventory_and_disk_names_remain_available(monkeypatch, headless_windows):
    calls = _capture(monkeypatch, [
        _completed(json.dumps({"DriveLetter": "E", "FileSystemLabel": "Backup",
                               "FileSystem": "NTFS", "DriveType": "Fixed", "Size": 4096})),
        _completed(json.dumps({"Number": 3, "FriendlyName": "Portable SSD"})),
        _completed(json.dumps("E")),
    ])

    result = device_routes.devices_usb()

    assert result["devices"] == [{
        "name": "Portable SSD (Backup)", "is_storage": True, "mount_path": "E:\\",
        "volume_label": "Backup", "fs_type": "NTFS", "size_bytes": 4096,
        "drive_type": "Fixed",
    }]
    assert result["count"] == 1
    assert [kwargs["timeout"] for _, kwargs in calls] == [10, 10, 5]
    assert "Get-Disk" in calls[0][0][-1]
    assert "Get-Partition -DiskNumber 3" in calls[2][0][-1]


def test_removable_mount_fallback_is_also_hidden(monkeypatch, headless_windows):
    calls = _capture(monkeypatch, [
        _completed(stderr="USB query unavailable", returncode=1),
        _completed(json.dumps([{"DriveLetter": "F", "FileSystemLabel": "Camera",
                                "FileSystem": "FAT32", "Size": 2048}])),
    ])

    assert device_routes.detect_removable_mounts() == [{
        "mount_path": "F:\\", "label": "Camera", "fs_type": "FAT32",
        "size_bytes": 2048, "drive_type": "Removable",
    }]
    assert [kwargs["timeout"] for _, kwargs in calls] == [10, 5]
    assert "Removable" in calls[1][0][-1]


def test_usb_snapshot_keeps_parsing_captured_json(monkeypatch, headless_windows):
    calls = _capture(monkeypatch, [_completed(json.dumps({
        "Name": "USB receiver", "InstanceId": "USB\\sample", "Status": "OK",
    }))])

    assert device_routes.usb_basic_snapshot()["devices"] == [{
        "name": "USB receiver", "instance_id": "USB\\sample", "status": "OK",
    }]
    assert calls[0][1]["timeout"] == 40
    assert calls[0][1]["shell"] is False


@pytest.mark.parametrize("module", [device_routes, tool_routes])
def test_failed_background_command_keeps_output_and_exit_code(monkeypatch, headless_windows, module):
    calls = _capture(monkeypatch, [_completed("partial output", "diagnostic", 7)])

    assert module._run_subprocess(["sample-command"], timeout=9) == {
        "ok": False, "returncode": 7, "stdout": "partial output", "stderr": "diagnostic",
    }
    assert calls[0] == (["sample-command"], {
        "capture_output": True, "text": True, "timeout": 9,
        "shell": False, "creationflags": NO_WINDOW,
    })


@pytest.mark.parametrize("module", [device_routes, tool_routes])
def test_background_command_timeout_still_returns_error(monkeypatch, headless_windows, module):
    _capture(monkeypatch, [subprocess.TimeoutExpired(["sample-command"], 9)])

    result = module._run_subprocess(["sample-command"], timeout=9)

    assert result["ok"] is False
    assert "timed out" in result["error"]
    if module is device_routes:
        assert result["cmd"] == ["sample-command"]


def test_network_tools_use_hidden_processes_and_keep_results(monkeypatch, headless_windows):
    monkeypatch.setattr(tool_routes, "psutil", None)
    calls = _capture(monkeypatch, [_completed("adapter details"), _completed(returncode=0)])

    assert tool_routes.builtin_net_snapshot()["raw_output"] == "adapter details"
    result = tool_routes.builtin_net_connectivity_diag({"hosts": ["127.0.0.1"]})

    assert result["tests"] == [{"host": "127.0.0.1", "ok": True}]
    assert calls[0][0] == ["ipconfig"]
    assert calls[1][0] == ["ping", "-n", "2", "127.0.0.1"]
    assert [kwargs["timeout"] for _, kwargs in calls] == [15, 8]


@pytest.mark.parametrize("language,executable", [
    ("ps1", "powershell.exe"), ("bat", "cmd.exe"), ("py", None),
])
def test_script_tool_is_hidden_and_returns_captured_result(
    monkeypatch, headless_windows, tmp_path, language, executable,
):
    script = tmp_path / f"sample.{language}"
    script.write_text("# Never executed by this test", encoding="utf-8")
    monkeypatch.setattr(tool_routes, "get_tool", lambda _: {
        "script_path": str(script), "language": language,
    })
    monkeypatch.setattr(tool_routes.S, "SCRIPTS_DIR", tmp_path)
    calls = _capture(monkeypatch, [_completed("", "script diagnostic\n", 2)])

    result = asyncio.run(tool_routes.tools_run_for_ui(
        tool_routes.SimpleToolRunRequest(tool_id="sample"), _session="test-user",
    ))

    assert result == {"output": "script diagnostic", "exit_code": 2}
    assert calls[0][0][0] == (executable or tool_routes.sys.executable)
    assert calls[0][0][-1] == str(script)
    assert calls[0][1]["cwd"] == str(tmp_path)
    assert calls[0][1]["shell"] is False
