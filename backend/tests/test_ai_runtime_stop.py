"""Owned-handle shutdown checks; no real process is created or stopped."""
from types import SimpleNamespace

import pytest

from ai import ai_manager as manager


class Child:
    def __init__(self, *, running=True, handle=12345):
        self._handle = handle
        self.running = running
        self.calls = []

    @property
    def pid(self):
        pytest.fail("A numeric PID must never authorize runtime cleanup")

    def poll(self):
        self.calls.append("poll")
        return None if self.running else 0

    def terminate(self):
        self.calls.append("terminate_handle")
        self.running = False

    def wait(self, timeout):
        self.calls.append(("wait_handle", timeout))
        if self.running:
            raise manager.subprocess.TimeoutExpired("owned-runtime", timeout)
        return 0


class Kernel:
    def __init__(self, child):
        self.child = child
        self.calls = []
        self.assignment = True
        self.query = True
        self.member = True
        self.termination = True
        self.limits = True

    def CreateJobObjectW(self, *args):
        self.calls.append("create_job")
        return 9001

    def SetInformationJobObject(self, job, kind, info, size):
        self.calls.append(("limits", job, kind, info._obj.Basic.Flags, size))
        return self.limits

    def CloseHandle(self, handle):
        self.calls.append(("close", handle))
        return True

    def AssignProcessToJobObject(self, job, handle):
        self.calls.append(("assign", job, handle))
        return self.assignment

    def IsProcessInJob(self, handle, job, value):
        self.calls.append(("membership", handle, job))
        value._obj.value = self.member
        return self.query

    def TerminateJobObject(self, job, status):
        self.calls.append(("terminate_owned_job", job))
        if self.termination:
            self.child.running = False
        return self.termination


@pytest.fixture
def runtime(monkeypatch):
    child = Child()
    kernel = Kernel(child)
    monkeypatch.setattr(manager, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(manager, "_win32_job", 9001)
    monkeypatch.setattr(manager, "_windows_job_api", lambda: kernel)
    monkeypatch.setattr(manager.subprocess, "run", lambda *a, **kw: pytest.fail("No taskkill, shell, or PID lookup"))
    return child, kernel


def test_runtime_assignment_uses_retained_handle_and_records_exact_process(runtime):
    child, kernel = runtime
    assert manager._assign_to_win32_job(child) == (child, 9001)
    assert kernel.calls == [("assign", 9001, 12345)]


@pytest.mark.parametrize("state", ["exited", "missing_handle", "rejected"])
def test_unknown_or_failed_assignment_never_records_tree_authority(runtime, state):
    child, kernel = runtime
    if state == "exited": child.running = False
    elif state == "missing_handle": child._handle = None
    else: kernel.assignment = False
    assert manager._assign_to_win32_job(child) is None
    assert not any(call[0] == "terminate_owned_job" for call in kernel.calls)


def test_owned_tree_stops_only_after_matching_job_membership(runtime):
    child, kernel = runtime
    manager._stop_windows_runtime(child, (child, 9001))
    assert kernel.calls == [("membership", 12345, 9001), ("terminate_owned_job", 9001)]
    assert child.calls == [("wait_handle", 5)]


@pytest.mark.parametrize("unknown", ["missing_binding", "different_process", "different_job", "not_member", "query_failed", "job_stop_failed"])
def test_uncertain_tree_ownership_falls_back_only_to_original_process_handle(runtime, unknown):
    child, kernel = runtime
    binding = (child, 9001)
    if unknown == "missing_binding": binding = None
    elif unknown == "different_process": binding = (Child(), 9001)
    elif unknown == "different_job": binding = (child, 9999)
    elif unknown == "not_member": kernel.member = False
    elif unknown == "query_failed": kernel.query = False
    else: kernel.termination = False
    manager._stop_windows_runtime(child, binding)
    assert child.calls[-3:] == ["poll", "terminate_handle", ("wait_handle", 5)]
    if unknown != "job_stop_failed":
        assert not any(call[0] == "terminate_owned_job" for call in kernel.calls)


def test_exited_child_never_targets_a_reused_pid(runtime):
    child, kernel = runtime
    child.running = False
    manager._stop_windows_runtime(child)
    assert child.calls == ["poll", ("wait_handle", 5)]
    assert kernel.calls == []


def test_exit_between_poll_and_termination_keeps_original_handle(runtime, monkeypatch):
    child, kernel = runtime
    def exited_poll():
        child.running = False
        return None  # The original process exits immediately after this result.
    monkeypatch.setattr(child, "poll", exited_poll)
    manager._stop_windows_runtime(child)
    assert child.calls == ["terminate_handle", ("wait_handle", 5)]
    assert kernel.calls == []


@pytest.mark.parametrize("handle", [None, 0, -1])
def test_missing_retained_handle_fails_closed_without_any_termination(runtime, handle):
    child, kernel = runtime
    child._handle = handle
    with pytest.raises(RuntimeError, match="handle is unavailable"):
        manager._stop_windows_runtime(child, (child, 9001))
    assert child.calls == [] and kernel.calls == []


def test_unconfirmed_process_exit_is_reported(runtime, monkeypatch):
    child, kernel = runtime
    monkeypatch.setattr(child, "terminate", lambda: None)
    with pytest.raises(manager.subprocess.TimeoutExpired):
        manager._stop_windows_runtime(child)
    assert kernel.calls == []


@pytest.mark.parametrize("accepted", [True, False])
def test_job_setup_requires_checked_kill_on_close_configuration(runtime, monkeypatch, accepted):
    _, kernel = runtime
    kernel.limits = accepted
    monkeypatch.setattr(manager, "_win32_job", None)
    manager._setup_win32_job()
    assert manager._win32_job == (9001 if accepted else None)
    assert kernel.calls[1][1:4] == (9001, 9, 0x2000)
    assert (("close", 9001) in kernel.calls) is (not accepted)


def test_launch_records_binding_for_the_exact_popen_instance(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    model = tmp_path / "model.gguf"
    runtime.write_text("synthetic")
    model.write_text("synthetic")
    instance = manager.BundledAIManager(manager.BundledAIConfig(tmp_path, runtime, model))
    process = Child()
    monkeypatch.setattr(manager.subprocess, "Popen", lambda *a, **kw: process)
    bindings = []
    def assign(value):
        bindings.append(value)
        return value, 9001
    monkeypatch.setattr(manager, "_assign_to_win32_job", assign)
    monkeypatch.setattr(manager, "_is_port_open", lambda *a: False)
    monkeypatch.setattr(instance, "preset", lambda *a: {})
    monkeypatch.setattr(instance, "is_healthy", lambda: True)
    instance._transition = True
    assert instance._start_runtime()
    assert bindings == [process] and instance._proc_job_binding == (process, 9001)
