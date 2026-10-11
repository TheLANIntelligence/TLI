"""Native desktop launcher protocol without starting a backend or browser."""
from io import StringIO
import json
from pathlib import Path

import pytest

import desktop_launcher as D
import host_control as H


def events(capsys):
    captured = capsys.readouterr()
    return [json.loads(line) for line in captured.out.splitlines()], captured.err


@pytest.fixture
def worker(monkeypatch):
    monkeypatch.setattr(D.L, "dependencies_ready", lambda root: True)
    monkeypatch.setattr(D.L.webbrowser, "open", lambda *args: pytest.fail("The worker must not open a browser."))
    monkeypatch.setattr(D.L, "launch", lambda *args, **kwargs: pytest.fail("Unexpected backend launch."))


def test_success_forwards_progress_and_the_verified_url(worker, monkeypatch, capsys):
    verified_url = "https://localhost:8123"

    def launch(root, *, open_browser, progress):
        assert root == Path(D.__file__).resolve().parent.parent
        assert open_browser is False
        progress("Checking whether TLI is already running...")
        progress("Loading café model…")
        # Incidental library output must not corrupt the JSON protocol.
        print("A library diagnostic")
        return {"backend_state": "running", "reason": "Verified", "url": verified_url}

    monkeypatch.setattr(D.L, "launch", launch)
    monkeypatch.setattr(D.L.startup_config, "resolve", lambda *args, **kwargs: pytest.fail("Do not reread the URL after verification."))

    assert D.main([]) == 0
    emitted, stderr = events(capsys)
    assert emitted == [
        {"event": "progress", "message": "Checking whether TLI is already running..."},
        {"event": "progress", "message": "Loading café model…"},
        {"event": "ready", "url": verified_url},
    ]
    assert "A library diagnostic" in stderr


def test_missing_dependencies_requests_setup_without_launch(worker, monkeypatch, capsys):
    monkeypatch.setattr(D.L, "dependencies_ready", lambda root: False)
    assert D.main([]) == 2
    emitted, stderr = events(capsys)
    assert len(emitted) == 1 and emitted[0]["event"] == "setup_required"
    assert emitted[0]["message"]
    assert not stderr


@pytest.mark.parametrize("error", [RuntimeError("Model failed to load."), H.HostControlError(409, "The port belongs to another installation.")])
def test_failure_reports_detail_once_without_dialog(worker, monkeypatch, capsys, error):
    def fail(root, *, open_browser, progress):
        progress("Starting TLI")
        raise error

    monkeypatch.setattr(D.L, "launch", fail)
    assert D.main([]) == 1
    emitted, stderr = events(capsys)
    assert emitted == [{"event": "progress", "message": "Starting TLI"}, {"event": "error", "message": str(error)}]
    assert not stderr


def test_root_is_code_location_not_environment_or_working_directory(worker, monkeypatch, tmp_path, capsys):
    fixed_root = tmp_path / "TLI with spaces"
    monkeypatch.setattr(D, "__file__", str(fixed_root / "backend" / "desktop_launcher.py"))
    monkeypatch.setenv("TLI_ROOT", str(tmp_path / "unrelated installation"))
    monkeypatch.chdir(tmp_path)
    visited = []

    def dependencies(root):
        visited.append(root)
        return True

    def launch(root, *, open_browser, progress):
        visited.append(root)
        assert open_browser is False
        return {"backend_state": "running", "url": "http://127.0.0.1:8000"}

    monkeypatch.setattr(D.L, "dependencies_ready", dependencies)
    monkeypatch.setattr(D.L, "launch", launch)
    assert D.main([]) == 0
    assert visited == [fixed_root.resolve(), fixed_root.resolve()]
    assert events(capsys)[0] == [{"event": "ready", "url": "http://127.0.0.1:8000"}]


@pytest.mark.parametrize("arguments", [["--root", "C:\\Other"], ["--stop"], ["command.exe"]])
def test_arguments_cannot_select_another_installation_or_action(worker, monkeypatch, capsys, arguments):
    monkeypatch.setattr(D.L, "dependencies_ready", lambda root: pytest.fail("Arguments must fail before setup checks."))
    assert D.main(arguments) == 1
    emitted, _ = events(capsys)
    assert len(emitted) == 1 and emitted[0]["event"] == "error"


@pytest.mark.parametrize("result", [{"backend_state": "starting"}, {"backend_state": "running"}])
def test_incomplete_launch_result_does_not_report_ready(worker, monkeypatch, capsys, result):
    monkeypatch.setattr(D.L, "launch", lambda *args, **kwargs: result)
    assert D.main([]) == 1
    emitted, _ = events(capsys)
    assert len(emitted) == 1 and emitted[0]["event"] == "error"


def test_protocol_configures_utf8_and_flushes(worker, monkeypatch):
    class Protocol(StringIO):
        def __init__(self):
            super().__init__()
            self.settings = None
            self.flushes = 0

        def reconfigure(self, **settings):
            self.settings = settings

        def flush(self):
            self.flushes += 1

    protocol = Protocol()
    monkeypatch.setattr(D.sys, "stdout", protocol)
    monkeypatch.setattr(D.L, "dependencies_ready", lambda root: False)
    assert D.main([]) == 2
    assert protocol.settings["encoding"] == "utf-8"
    assert protocol.settings["line_buffering"] is True
    assert protocol.flushes == 1
    assert json.loads(protocol.getvalue())["event"] == "setup_required"


def test_existing_backend_keeps_verified_settings_snapshot_and_opens_no_browser(monkeypatch, tmp_path, capsys):
    """Exercise the real lease/launch handoff with synthetic readiness only."""
    root = tmp_path / "Synthetic TLI"
    root.mkdir()
    monkeypatch.setattr(D, "__file__", str(root / "backend" / "desktop_launcher.py"))
    monkeypatch.setattr(D.L, "dependencies_ready", lambda root: True)
    saved = {"host": "0.0.0.0", "port": 8443, "https": True}
    reads = []

    def resolve(actual_root):
        assert actual_root == root
        reads.append(dict(saved))
        return {"effective_next": dict(saved)}

    def inspect(actual_root, settings):
        assert actual_root == root
        assert settings == {"host": "0.0.0.0", "port": 8443, "https": True}
        # A future launch preference can change while this launch is waiting.
        saved["port"] = 9443
        return "running", "Synthetic ownership proof accepted."

    monkeypatch.setattr(D.L.startup_config, "resolve", resolve)
    monkeypatch.setattr(D.L, "inspect_backend", inspect)
    monkeypatch.setattr(D.L, "verify_release", lambda *_args: None)
    monkeypatch.setattr(D.L, "spawn_backend", lambda *args: pytest.fail("An existing backend must be reused."))
    monkeypatch.setattr(D.L.webbrowser, "open", lambda *args: pytest.fail("Only the native UI opens the browser."))

    assert D.main([]) == 0
    emitted, _ = events(capsys)
    assert len(reads) == 1
    assert emitted[-1] == {"event": "ready", "url": "https://localhost:8443"}
    assert all(event["event"] == "progress" for event in emitted[:-1])
