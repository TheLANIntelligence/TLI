"""Stop/status truthfulness with synthetic process generations only."""
import json
import sys
from types import SimpleNamespace

import pytest

import host_control as H
import host_control_cli as CLI
import host_launcher as L


@pytest.fixture
def owned(tmp_path, monkeypatch):
    root = tmp_path / "TLI installation"
    root.mkdir()
    H.installation(root, create=True)
    child = {"pid": 123456, "created_at": 1700000000.25, "script": "main.py"}
    settings = {"host": "127.0.0.1", "port": 8000, "https": False}
    request = H.path_for(root, "stop-backend.json")
    monkeypatch.setattr(L.startup_config, "resolve", lambda *_args, **_kwargs: {"effective_next": settings})
    monkeypatch.setattr(L, "recorded_backend_children", lambda _root: [dict(child)])
    monkeypatch.setattr(L, "inspect_backend", lambda *_args: ("running", "Owned proof"))
    # Inspection succeeds before the stop request. Afterwards a boolean probe
    # cannot distinguish actual exit from access denied, which is the regression.
    monkeypatch.setattr(L, "child_alive", lambda *_args: not request.exists())
    return SimpleNamespace(root=root, child=child, settings=settings, request=request)


@pytest.mark.parametrize("explicit_child", [False, True])
def test_uninspectable_generation_after_stop_is_not_reported_as_stopped(owned, monkeypatch, explicit_child):
    monkeypatch.setattr(L, "process_generation_state",
                        lambda *_args: "unknown" if owned.request.exists() else "running")
    options = {"expected_child": owned.child} if explicit_child else {}
    with pytest.raises(H.HostControlError) as failure:
        L.stop_owned_backend(owned.root, wait_seconds=0, **options)
    assert failure.value.status == 503
    assert "confirmed" in failure.value.detail.lower()
    assert owned.request.exists()


def test_reviewed_generation_change_does_not_request_stop(owned, monkeypatch):
    monkeypatch.setattr(L, "process_generation_state", lambda *_args: "running")
    reviewed = {**owned.child, "created_at": owned.child["created_at"] - 1}
    with pytest.raises(H.HostControlError, match="generation changed"):
        L.stop_owned_backend(owned.root, expected_child=reviewed, wait_seconds=0)
    assert not owned.request.exists()


@pytest.mark.parametrize("explicit_child", [False, True])
def test_pid_reuse_proves_only_the_recorded_generation_exited(owned, monkeypatch, explicit_child):
    import psutil
    monkeypatch.setattr(L, "matches_process", lambda *_args: True)
    monkeypatch.setattr(psutil, "Process", lambda _pid: SimpleNamespace(
        create_time=lambda: owned.child["created_at"] + int(owned.request.exists())))
    options = {"expected_child": owned.child} if explicit_child else {}
    result = L.stop_owned_backend(owned.root, wait_seconds=0, **options)
    assert result["stopped"] is True
    assert owned.request.exists()
    assert L.process_generation_state(owned.root, owned.child) == "exited"


@pytest.mark.parametrize("state", ["running", "stopped", "unknown"])
def test_setup_status_reports_backend_separately_from_optional_helper(tmp_path, monkeypatch, capsys, state):
    root = tmp_path / "TLI installation"
    root.mkdir()
    calls = []
    snapshot = {"state": state, "message": "Synthetic backend status", "can_stop": state == "running"}

    def desktop_status(actual_root, *, issue_token):
        calls.append((actual_root, issue_token))
        return snapshot

    monkeypatch.setattr(CLI, "__file__", str(root / "backend" / "host_control_cli.py"))
    monkeypatch.setattr(sys, "argv", ["host_control_cli.py", "status"])
    monkeypatch.setattr(CLI.L, "desktop_status", desktop_status, raising=False)
    monkeypatch.setattr(CLI, "helper_running", lambda _root: False)
    monkeypatch.setattr(CLI.H, "config", lambda _root: H._fail("Phone start is not enabled."))
    CLI.main()
    result = json.loads(capsys.readouterr().out)
    assert result["backend"] == snapshot
    assert result["helper_running"] is False
    assert result["enabled"] is False
    assert calls == [(root, False)]
