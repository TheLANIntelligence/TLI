"""Desktop launch timing with synthetic processes; no real backend or browser."""
from types import SimpleNamespace

import pytest

import host_control as H
import host_launcher as L


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
