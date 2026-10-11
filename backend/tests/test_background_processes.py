"""Background commands keep their results without opening Windows consoles."""
import json
import shutil
import subprocess
import sys
from types import SimpleNamespace

import pytest

import process_utils
from builder import command_runner
from routers import games, hub_routes
import lan_discovery


@pytest.mark.parametrize("platform", ["win32", "linux", "darwin"])
def test_launch_flags_are_windows_only(monkeypatch, platform):
    monkeypatch.setattr(process_utils, "sys", SimpleNamespace(platform=platform))
    monkeypatch.setattr(subprocess, "CREATE_NO_WINDOW", 0x08000000, raising=False)
    expected = {"creationflags": 0x08000000} if platform == "win32" else {}
    assert process_utils.hidden_process_kwargs() == expected


@pytest.mark.skipif(sys.platform != "win32", reason="Windows console allocation")
def test_real_child_has_no_console_and_preserves_output_and_exit_status():
    code = (
        "import ctypes,json,sys; "
        "ctypes.windll.kernel32.GetConsoleWindow.restype=ctypes.c_void_p; "
        "print(json.dumps({'console':ctypes.windll.kernel32.GetConsoleWindow()})); "
        "print('captured error',file=sys.stderr); sys.exit(7)"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True,
                            text=True, timeout=10, **process_utils.hidden_process_kwargs())
    assert json.loads(result.stdout) == {"console": None}
    assert result.stderr.strip() == "captured error"
    assert result.returncode == 7


@pytest.mark.skipif(sys.platform != "win32" or not shutil.which("powershell"), reason="Windows PowerShell required")
def test_real_powershell_has_no_console_and_still_returns_json():
    script = '''Add-Type -Name ConsoleProbe -Namespace TliTests -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();'
[pscustomobject]@{console = [TliTests.ConsoleProbe]::GetConsoleWindow().ToInt64(); value = "captured"} | ConvertTo-Json -Compress
'''
    result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                            capture_output=True, text=True, timeout=20, **process_utils.hidden_process_kwargs())
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"console": 0, "value": "captured"}


def test_gpu_polling_keeps_measurements_and_cached_result(monkeypatch):
    monkeypatch.setattr(games, "_NVIDIA_CACHE", {"ts": 0.0})
    calls = []
    def query(command, **kwargs):
        calls.append(command)
        assert kwargs == {"stderr": subprocess.DEVNULL, "universal_newlines": True,
                          "timeout": 1.5, **process_utils.hidden_process_kwargs()}
        return "12, 512\n" if "--query-gpu=utilization.gpu,memory.used" in command else "123, 256\n"
    monkeypatch.setattr(games.subprocess, "check_output", query)
    expected = ({"gpu_util_percent": 12, "gpu_mem_used_mb": 512}, {123: 256})
    assert games._nvidia_query_cached() == expected
    assert games._nvidia_query_cached() == expected
    assert len(calls) == 2


def test_approved_builder_command_keeps_capture_and_timeout(monkeypatch, tmp_path):
    monkeypatch.delenv("TLI_BUILDER_ALLOW_SHELL", raising=False)
    def run(command, **kwargs):
        assert command == ["python", "--version"]
        assert kwargs == {"cwd": str(tmp_path.resolve()), "shell": False,
                          "capture_output": True, "text": True, "timeout": 17,
                          **process_utils.hidden_process_kwargs()}
        return SimpleNamespace(returncode=3, stdout="fixture output", stderr="fixture error")
    monkeypatch.setattr(command_runner.subprocess, "run", run)
    result = command_runner.run_approved_command(tmp_path, "python --version", approved=True, timeout_seconds=17)
    assert (result["exit_code"], result["stdout"], result["stderr"], result["timed_out"]) == (3, "fixture output", "fixture error", False)


@pytest.mark.parametrize("shell", ["powershell", "bash"])
def test_hub_script_runs_hidden_and_returns_result(monkeypatch, tmp_path, shell):
    monkeypatch.setattr(hub_routes, "_load_installed", lambda: [{"id": "fixture", "type": "script"}])
    monkeypatch.setattr(hub_routes, "_pkg_dir", lambda: tmp_path)
    (tmp_path / "script_fixture.json").write_text(json.dumps({"shell": shell, "code": "fixture text"}), encoding="utf-8")
    def run(command, **kwargs):
        assert command[0] == shell and command[-1] == "fixture text"
        assert kwargs == {"capture_output": True, "text": True, "timeout": 30,
                          **process_utils.hidden_process_kwargs()}
        return SimpleNamespace(returncode=2, stdout="fixture output", stderr="fixture error")
    monkeypatch.setattr(hub_routes.subprocess, "run", run)
    assert hub_routes.hub_run_script("fixture") == {"ok": False, "exit_code": 2,
        "stdout": "fixture output", "stderr": "fixture error", "shell": shell}


def test_firewall_helper_keeps_existing_rules_without_console(monkeypatch):
    monkeypatch.setattr(lan_discovery.platform, "system", lambda: "Windows")
    monkeypatch.setattr(lan_discovery.S, "server_port", lambda: 8443)
    calls = []
    def run(command, **kwargs):
        calls.append(command)
        assert kwargs == {"capture_output": True, "timeout": 5, **process_utils.hidden_process_kwargs()}
        return SimpleNamespace(returncode=1)
    monkeypatch.setattr(lan_discovery.subprocess, "run", run)
    lan_discovery._try_open_firewall()
    assert len(calls) == 2
    assert "localport=8443" in calls[0] and "localport=47474" in calls[1]
