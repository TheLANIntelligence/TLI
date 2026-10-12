"""Automatic release discovery without network, real sleeps or auto-installation."""
import io
import json
import threading

import pytest

import auto_update as U


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(U.S, "BASE_DIR", str(tmp_path))
    monkeypatch.setattr(U.S, "DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(U.S, "TLI_VERSION", "1.4.0-beta")
    monkeypatch.setattr(U, "_SETTINGS_FILE", tmp_path / "data/update_settings.json")
    for name, value in {"_state": U.UpdateState.IDLE, "_info": {}, "_error": "", "_ready_path": "",
                        "_progress": 0, "_checked_at": None, "_checking": False, "_last_attempt": None,
                        "_last_check_error": "", "_settings_revision": 0, "_auto_thread": None,
                        "_auto_stop": threading.Event(), "_auto_wake": threading.Event()}.items():
        monkeypatch.setattr(U, name, value)
    monkeypatch.setattr(U, "_platform_name", lambda: "windows")
    monkeypatch.setattr(U, "apply", lambda: pytest.fail("An automatic check must never download or install"))
    monkeypatch.setattr(U, "_open_url", lambda *a: pytest.fail("Unexpected release request"))


def response(version="1.5.0"):
    return io.BytesIO(json.dumps({"version": version, "updater": "guided-v1",
        "download_url": "https://example.test/release.zip", "sha256": "a" * 64}).encode())


def test_default_enabled_discovers_release_without_a_download(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(U, "_open_url", lambda url, timeout: calls.append(url) or response())
    result = U.check(automatic=True)
    assert result["state"] == "available" and result["latest_version"] == "1.5.0"
    assert result["current_version"] == "1.4.0-beta"
    assert calls == [U.DEFAULT_UPDATE_URL]
    assert not (tmp_path / "data/updates").exists()


@pytest.mark.parametrize("url,enabled", [(U.DEFAULT_UPDATE_URL, False), ("", True)])
def test_disabled_checks_or_empty_source_never_contact_network(url, enabled):
    U.save_settings(url, enabled)
    assert U.check(automatic=True)["state"] == "idle"
    assert U._automatic_delay() == U.AUTO_CHECK_INTERVAL
    assert U._last_attempt is None


def test_failed_background_check_is_quiet_and_preserves_known_release(monkeypatch):
    monkeypatch.setattr(U, "_open_url", lambda *a: response())
    U.check(automatic=True)
    known = dict(U._info)
    def unavailable(*args):
        assert U.get_status()["state"] == "available"
        raise OSError("offline")
    monkeypatch.setattr(U, "_open_url", unavailable)
    status = U.check(automatic=True)
    assert status["state"] == "available" and U._info == known
    assert status["error"] == ""
    assert "offline" in status["last_check_error"]
    assert U._automatic_delay() > U.AUTO_CHECK_INTERVAL - 5
    monkeypatch.setattr(U, "_open_url", lambda *a: response("1.6.0"))
    status = U.check(automatic=True)
    assert status["latest_version"] == "1.6.0" and status["last_check_error"] == ""


def test_startup_network_failure_does_not_create_an_error_banner(monkeypatch):
    def unavailable(*args):
        raise OSError("offline")
    monkeypatch.setattr(U, "_open_url", unavailable)
    assert U.check(automatic=True)["state"] == "idle"
    assert U.get_status()["last_check_error"]
    assert U.check()["state"] == "error"  # Explicit Check still reports its failure.


def test_manual_checks_share_six_hour_throttle_and_preference_changes_wake_worker(monkeypatch):
    now = [1000]
    monkeypatch.setattr(U.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(U, "_open_url", lambda *a: response())
    U.check()
    assert U._automatic_delay() == 6 * 60 * 60
    now[0] += U.AUTO_CHECK_INTERVAL - 1
    assert U._automatic_delay() == 1
    now[0] += 1
    assert U._automatic_delay() == 0
    U.save_settings(U.DEFAULT_UPDATE_URL, False)
    assert U._auto_wake.is_set() and U._automatic_delay() == U.AUTO_CHECK_INTERVAL
    U._auto_wake.clear()
    U.save_settings(U.DEFAULT_UPDATE_URL, True)
    assert U._auto_wake.is_set() and U._automatic_delay() == 0


@pytest.mark.parametrize("change", ["disable", "new_source", "shutdown"])
def test_late_response_cannot_override_changed_preference_or_shutdown(monkeypatch, change):
    def late(*args):
        if change == "shutdown":
            U.stop_auto_check()
        else:
            U.save_settings("https://new.example/release.json" if change == "new_source" else U.DEFAULT_UPDATE_URL,
                            change != "disable")
        return response()
    monkeypatch.setattr(U, "_open_url", late)
    result = U.check(automatic=True)
    assert result["state"] == "idle" and result["latest_version"] is None
    assert U._checking is False


def test_active_preparation_wins_over_inflight_background_result(monkeypatch):
    selected = {"version": "1.5.0", "can_prepare": True}
    monkeypatch.setattr(U, "_state", U.UpdateState.AVAILABLE)
    monkeypatch.setattr(U, "_info", selected)
    def late(*args):
        # User starts downloading the already-reviewed 1.5.0 during this request.
        U._state = U.UpdateState.DOWNLOADING
        return response("1.6.0")
    monkeypatch.setattr(U, "_open_url", late)
    result = U.check(automatic=True)
    assert result["state"] == "downloading" and result["latest_version"] == "1.5.0"
    assert U._info is selected


def test_periodic_loop_checks_after_startup_and_again_six_hours_later(monkeypatch):
    now, calls, waits = [1000], [], []
    monkeypatch.setattr(U.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(U, "_open_url", lambda *a: calls.append(now[0]) or response())
    class Stop:
        stopped = False
        def is_set(self):
            return self.stopped
        def wait(self, seconds):
            waits.append(seconds)
            now[0] += seconds
            return False
    stop = Stop()
    class Wake:
        def clear(self):
            pass
        def wait(self, seconds):
            waits.append(seconds)
            now[0] += seconds
            if len(calls) == 2:
                stop.stopped = True
    U._automatic_loop(stop, Wake())
    assert waits == [5, 21600, 21600]
    assert calls == [1005, 22605]


def test_worker_is_singleton_and_shutdown_interrupts_its_wait(monkeypatch):
    created = []
    class Thread:
        def __init__(self, **kwargs):
            created.append(kwargs)
        def start(self):
            pass
        def is_alive(self):
            return True
    monkeypatch.setattr(U.threading, "Thread", Thread)
    U.auto_check_on_startup()
    U.auto_check_on_startup()
    assert len(created) == 1 and created[0]["daemon"] is True
    stop, wake = created[0]["args"]
    U.stop_auto_check()
    assert stop.is_set() and wake.is_set()
    U.auto_check_on_startup()
    assert len(created) == 2 and not U._auto_stop.is_set()


def test_worker_cancelled_during_startup_delay_never_checks():
    stop = threading.Event()
    stop.set()
    U._automatic_loop(stop, threading.Event())
    assert U._last_attempt is None
