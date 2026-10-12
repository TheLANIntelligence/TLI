"""Desktop launch timing with synthetic processes; no real backend or browser."""
from types import SimpleNamespace

import pytest

import host_control as H
import host_launcher as L
import runtime_preflight as preflight


class Clock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        assert 0 < seconds <= 1, "Readiness checks must remain responsive."
        self.now += seconds


@pytest.fixture
def desktop(tmp_path, monkeypatch):
    root = tmp_path / "Synthetic TLI installation"
    root.mkdir()
    clock = Clock()
    monkeypatch.setattr(L, "time", SimpleNamespace(monotonic=clock.monotonic, sleep=clock.sleep))
    settings = {"host": "127.0.0.1", "port": 8000, "https": False}
    monkeypatch.setattr(L.startup_config, "resolve", lambda *_args, **_kwargs: {"effective_next": settings})
    monkeypatch.setattr(L, "verify_release", lambda *_args: None)
    opened, spawned, progress = [], [], []
    child = {"pid": 123456, "created_at": 1700000000.25, "script": "main.py"}

    def spawn(actual_root, actual_settings):
        assert actual_root == root and actual_settings == settings
        spawned.append(clock.now)
        return dict(child)

    monkeypatch.setattr(L, "spawn_backend", spawn)
    monkeypatch.setattr(L, "child_alive", lambda *_args: bool(spawned))
    monkeypatch.setattr(L.webbrowser, "open", lambda url: opened.append((clock.now, url)))
    return SimpleNamespace(root=root, clock=clock, settings=settings, spawned=spawned,
                           opened=opened, child=child, progress=progress,
                           report=lambda message: progress.append((clock.now, message)))


def test_default_launch_waits_through_realistic_model_warmup_and_reports_progress(desktop, monkeypatch):
    """The reported regression loaded AI for 53 seconds before HTTP could bind."""
    def inspect(*_args):
        if not desktop.spawned:
            return "stopped", "No listener."
        if desktop.clock.now < 55:
            return "starting", "Owned backend is loading the selected model."
        return "running", "Owned backend proved its identity."

    monkeypatch.setattr(L, "inspect_backend", inspect)
    result = L.launch(desktop.root, progress=desktop.report)

    assert result["backend_state"] == "running"
    assert len(desktop.spawned) == 1
    assert 55 <= desktop.clock.now < 57
    assert desktop.opened == [(desktop.clock.now, "http://127.0.0.1:8000")]
    assert desktop.progress and desktop.progress[0][0] == 0
    assert all(isinstance(message, str) and message.strip() for _, message in desktop.progress)
    assert any(0 < timestamp < 45 for timestamp, _ in desktop.progress)
    assert any(45 <= timestamp < 55 for timestamp, _ in desktop.progress)


@pytest.mark.parametrize("initially_starting", [False, True])
def test_child_exit_fails_promptly_without_automatic_respawn(desktop, monkeypatch, initially_starting):
    def inspect(*_args):
        if not initially_starting and not desktop.spawned:
            return "stopped", "No listener."
        return ("starting", "Owned backend is starting.") if desktop.clock.now < 1 else ("stopped", "Owned backend exited.")

    monkeypatch.setattr(L, "inspect_backend", inspect)
    monkeypatch.setattr(L, "child_alive", lambda *_args: desktop.clock.now < 1)

    with pytest.raises(H.HostControlError) as failure:
        L.launch(desktop.root, progress=desktop.report)

    assert failure.value.status == 503
    assert "exit" in failure.value.detail.lower() or "stopped" in failure.value.detail.lower()
    assert "backend.log" in failure.value.detail
    assert 1 <= desktop.clock.now < 5
    assert len(desktop.spawned) == (0 if initially_starting else 1)
    assert not desktop.opened


def test_foreign_listener_is_not_adopted_or_replaced(desktop, monkeypatch):
    reason = "The saved port is occupied, but this TLI installation could not be verified."
    monkeypatch.setattr(L, "inspect_backend", lambda *_args: ("unavailable", reason))

    with pytest.raises(H.HostControlError, match="could not be verified"):
        L.launch(desktop.root, progress=desktop.report)

    assert not desktop.spawned and not desktop.opened
    assert desktop.clock.now == 0
    assert not H.path_for(desktop.root, "desktop-child.json").exists()


def test_timeout_preserves_owned_startup_and_retry_waits_without_duplicate(desktop, monkeypatch):
    def inspect(*_args):
        if not desktop.spawned:
            return "stopped", "No listener."
        if desktop.clock.now < 10:
            return "starting", "Owned backend remains alive."
        return "running", "Owned backend proved its identity."

    monkeypatch.setattr(L, "inspect_backend", inspect)
    with pytest.raises(H.HostControlError) as failure:
        L.launch(desktop.root, wait_seconds=3, progress=desktop.report)

    assert failure.value.status == 503
    message = failure.value.detail.lower()
    assert "still" in message and ("start" in message or "running" in message)
    assert "tli_start.bat" in message
    assert not desktop.opened
    assert len(desktop.spawned) == 1
    assert H.read_json(H.path_for(desktop.root, "desktop-child.json")) == desktop.child

    result = L.launch(desktop.root, progress=desktop.report)
    assert result["backend_state"] == "running"
    assert len(desktop.spawned) == 1 and len(desktop.opened) == 1
    assert H.read_json(H.path_for(desktop.root, "desktop-child.json")) == desktop.child


@pytest.mark.parametrize("open_browser", [True, False])
def test_running_owned_backend_is_reused_immediately(desktop, monkeypatch, open_browser):
    monkeypatch.setattr(L, "inspect_backend", lambda *_args: ("running", "Owned backend proved its identity."))

    result = L.launch(desktop.root, open_browser=open_browser, progress=desktop.report)

    assert result["backend_state"] == "running" and not desktop.spawned
    assert desktop.clock.now == 0
    assert len(desktop.opened) == int(open_browser)


def test_stale_owned_backend_is_not_opened_or_automatically_replaced(desktop, monkeypatch):
    monkeypatch.setattr(L, "inspect_backend", lambda *_args: ("running", "Owned proof"))
    def stale(*_args):
        H._fail("Restart TLI to load this release.")
    monkeypatch.setattr(L, "verify_release", stale)
    with pytest.raises(H.HostControlError, match="Restart TLI"):
        L.launch(desktop.root)
    assert not desktop.spawned and not desktop.opened


@pytest.mark.parametrize("state,source,on_disk,status", [
    ("matched", "current", "current", 200),
    ("restart_required", "old", "current", 200),
    ("matched", "old", "old", 200),
    ("unknown", None, None, 200),
    ("matched", "current", "current", 302),
])
def test_release_gate_requires_current_loaded_and_disk_identity(tmp_path, monkeypatch, state, source, on_disk, status):
    import json
    import release_identity
    monkeypatch.setattr(release_identity, "ReleaseIdentity", lambda _root: SimpleNamespace(loaded={"source_id": "current"}))
    calls = []
    class Connection:
        def __init__(self, host, port, **kwargs):
            assert host == "127.0.0.1" and port == 8123 and kwargs["timeout"] == 5
        def request(self, method, path, headers):
            calls.append((method, path))
        def getresponse(self):
            raw = json.dumps({"release": {"compatibility": {"state": state}, "source_id": source, "on_disk": {"source_id": on_disk}}}).encode()
            return SimpleNamespace(status=status, read=lambda limit: raw)
        def close(self):
            calls.append("closed")
    monkeypatch.setattr(L.http.client, "HTTPConnection", Connection)
    settings = {"host": "0.0.0.0", "port": 8123, "https": False}
    if state == "matched" and source == on_disk == "current" and status == 200:
        L.verify_release(tmp_path, settings)
    else:
        with pytest.raises(H.HostControlError, match="No process was stopped or replaced"):
            L.verify_release(tmp_path, settings)
    assert calls == [("GET", "/api/diagnostics/version"), "closed"]


def test_runtime_probe_skips_source_installation_and_other_platforms(tmp_path, monkeypatch):
    monkeypatch.setattr(L.subprocess, "run", lambda *_args, **_kwargs: pytest.fail("No bundled runtime should execute"))
    monkeypatch.setattr(L.sys, "platform", "win32")
    L.check_packaged_runtime(tmp_path)
    runtime = tmp_path / "backend/ai/runtime/llama_server.exe"
    runtime.parent.mkdir(parents=True)
    runtime.write_bytes(b"synthetic")
    monkeypatch.setattr(L.sys, "platform", "darwin")
    L.check_packaged_runtime(tmp_path)


@pytest.mark.parametrize("outcome", ["success", "missing-dll", "start-error", "timeout"])
def test_windows_runtime_probe_is_fixed_hidden_bounded_and_explains_repair(tmp_path, monkeypatch, outcome):
    runtime = tmp_path / "backend/ai/runtime/llama_server.exe"
    runtime.parent.mkdir(parents=True)
    runtime.write_bytes(b"synthetic, never executed")
    monkeypatch.setattr(L.sys, "platform", "win32")
    monkeypatch.setattr(preflight, "hidden_process_kwargs", lambda: {"creationflags": 0x08000000})
    calls = []
    def run(command, **options):
        calls.append(command)
        assert command == [str(runtime), "--version"]
        assert options["cwd"] == str(runtime.parent)
        assert options["creationflags"] == 0x08000000 and options["timeout"] == 5
        assert options["stdin"] == L.subprocess.DEVNULL
        if outcome == "start-error":
            raise OSError("synthetic loader error")
        if outcome == "timeout":
            raise L.subprocess.TimeoutExpired(command, 5)
        return SimpleNamespace(returncode=0 if outcome == "success" else 0xC0000135)
    monkeypatch.setattr(L.subprocess, "run", run)
    if outcome == "success":
        L.check_packaged_runtime(tmp_path)
    else:
        with pytest.raises(H.HostControlError) as failure:
            L.check_packaged_runtime(tmp_path)
        assert failure.value.status == 503
        assert "Visual C++ v14" in failure.value.detail and "(x64)" in failure.value.detail
        assert "https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist/" in failure.value.detail
        assert "reopen TLI" in failure.value.detail
        expected = {"missing-dll": "3221225781 (0xC0000135)", "start-error": "synthetic loader error", "timeout": "within 5 seconds"}
        assert expected[outcome] in failure.value.detail
        assert "\n\n" in failure.value.detail
    assert len(calls) == 1


def test_failed_optional_runtime_still_opens_verified_backend_and_returns_warning(desktop, monkeypatch):
    def reject(_root):
        raise L.PackagedRuntimeUnavailable(503, "Synthetic runtime prerequisite is missing")
    monkeypatch.setattr(L, "check_packaged_runtime", reject)
    monkeypatch.setattr(L, "inspect_backend", lambda *_args: ("running", "Owned proof") if desktop.spawned else ("stopped", "No listener"))
    result = L.launch(desktop.root, progress=desktop.report)
    assert result["backend_state"] == "running"
    assert result["runtime_warning"] == "Synthetic runtime prerequisite is missing"
    assert len(desktop.spawned) == len(desktop.opened) == 1
    assert H.read_json(H.path_for(desktop.root, "desktop-child.json")) == desktop.child
    assert any("Local AI needs attention" in message for _, message in desktop.progress)


@pytest.mark.parametrize("state", ["running", "starting"])
def test_existing_backend_does_not_require_an_optional_runtime_probe(desktop, monkeypatch, state):
    states = iter([(state, "Owned process"), ("running", "Owned proof")])
    monkeypatch.setattr(L, "inspect_backend", lambda *_args: next(states))
    monkeypatch.setattr(L, "check_packaged_runtime", lambda *_args: pytest.fail("Existing workspace needs no AI runtime probe"))
    result = L.launch(desktop.root)
    assert result["backend_state"] == "running" and "runtime_warning" not in result
    assert not desktop.spawned and len(desktop.opened) == 1


def test_optional_runtime_warning_cannot_bypass_release_identity_failure(desktop, monkeypatch):
    monkeypatch.setattr(L, "inspect_backend", lambda *_args: ("running", "Owned proof") if desktop.spawned else ("stopped", "No listener"))
    def reject_runtime(_root):
        raise L.PackagedRuntimeUnavailable(503, "Optional AI unavailable")
    def reject_release(*_args):
        H._fail("Running release identity did not match", 409)
    monkeypatch.setattr(L, "check_packaged_runtime", reject_runtime)
    monkeypatch.setattr(L, "verify_release", reject_release)
    with pytest.raises(H.HostControlError, match="release identity"):
        L.launch(desktop.root)
    assert len(desktop.spawned) == 1 and not desktop.opened


def test_unrelated_preflight_error_is_never_downgraded_to_advisory(desktop, monkeypatch):
    monkeypatch.setattr(L, "inspect_backend", lambda *_args: ("stopped", "No listener"))
    def reject(_root):
        H._fail("Saved host state is corrupt", 503)
    monkeypatch.setattr(L, "check_packaged_runtime", reject)
    with pytest.raises(H.HostControlError, match="host state is corrupt"):
        L.launch(desktop.root)
    assert not desktop.spawned and not desktop.opened


def test_explicit_runtime_diagnostic_still_exits_unsuccessfully(monkeypatch, capsys):
    monkeypatch.setattr(L.sys, "argv", ["host_launcher.py", "--check-runtime"])
    def reject(_root):
        raise L.PackagedRuntimeUnavailable(503, "Optional AI runtime needs repair")
    monkeypatch.setattr(L, "check_packaged_runtime", reject)
    monkeypatch.setattr(L, "launch", lambda *_args, **_kwargs: pytest.fail("A diagnostic must not launch the host"))
    with pytest.raises(SystemExit) as result:
        L.main()
    assert result.value.code == 1
    assert "runtime needs repair" in capsys.readouterr().err
