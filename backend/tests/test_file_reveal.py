"""Host file-manager requests reveal selected paths without executing files."""
import pytest

import tli_state as S
from routers import file_routes


@pytest.fixture
def launches(monkeypatch):
    calls = []
    monkeypatch.setattr(file_routes.subprocess, "Popen", lambda args, **kwargs: calls.append((args, kwargs)))
    monkeypatch.setattr(file_routes.os, "startfile", lambda *args, **kwargs: pytest.fail("Must not open a file by association"), raising=False)
    monkeypatch.setattr(file_routes, "hidden_process_kwargs", lambda: {"creationflags": 0x08000000})
    return calls


@pytest.mark.parametrize("suffix", [".iso", ".exe", ".lnk", ".url", ".bat"])
def test_windows_reveals_file_without_executing_it(authed_client, tmp_path, monkeypatch, launches, suffix):
    selected = tmp_path / ("selected file, with spaces" + suffix)
    selected.write_text("test fixture", encoding="utf-8")
    monkeypatch.setattr(file_routes.platform, "system", lambda: "Windows")

    result = authed_client.post("/open_reveal", json={"path": str(selected)})

    assert result.status_code == 200 and result.json() == {"status": "ok"}
    assert launches == [(["explorer.exe", "/select,", str(selected)], {
        "shell": False, "creationflags": 0x08000000,
    })]


def test_windows_opens_folder_in_explorer(authed_client, tmp_path, monkeypatch, launches):
    folder = tmp_path / "folder, with spaces"
    folder.mkdir()
    monkeypatch.setattr(file_routes.platform, "system", lambda: "Windows")

    result = authed_client.post("/open_reveal", json={"path": str(folder)})

    assert result.status_code == 200
    assert launches == [(["explorer.exe", str(folder)], {
        "shell": False, "creationflags": 0x08000000,
    })]


@pytest.mark.parametrize("platform", ["Darwin", "Linux"])
@pytest.mark.parametrize("directory", [False, True])
def test_other_hosts_use_file_manager_not_selected_file(authed_client, tmp_path, monkeypatch, launches, platform, directory):
    selected = tmp_path / "selected.app"
    selected.mkdir() if directory else selected.write_text("fixture", encoding="utf-8")
    monkeypatch.setattr(file_routes.platform, "system", lambda: platform)
    monkeypatch.setattr(file_routes, "hidden_process_kwargs", lambda: {})

    result = authed_client.post("/open_reveal", json={"path": str(selected)})

    assert result.status_code == 200
    expected = ["open", "-R", str(selected)] if platform == "Darwin" else [
        "xdg-open", str(selected if directory else selected.parent),
    ]
    assert launches == [(expected, {"shell": False})]


@pytest.mark.parametrize("path", [None, "", 123, "relative.txt", "../relative.txt", "https://example.test",
                                 "file:///C:/Windows", "shell:AppsFolder", "bad\x00path",
                                 "\\\\?\\C:\\Windows", "\\\\.\\PhysicalDrive0"])
def test_non_filesystem_inputs_cannot_launch(authed_client, launches, path):
    result = authed_client.post("/open_reveal", json={"path": path})

    assert result.status_code == 400
    assert launches == []


def test_stale_scan_path_reports_not_found(authed_client, tmp_path, launches):
    result = authed_client.post("/open_reveal", json={"path": str(tmp_path / "removed.iso")})

    assert result.status_code == 404
    assert "Path not found" in result.json()["detail"]
    assert launches == []


def test_file_manager_launch_error_is_visible(authed_client, tmp_path, monkeypatch, launches):
    def failed_launch(*args, **kwargs):
        raise OSError("File manager unavailable")

    monkeypatch.setattr(file_routes.subprocess, "Popen", failed_launch)
    result = authed_client.post("/open_reveal", json={"path": str(tmp_path)})

    assert result.status_code == 500
    assert "Could not open the host file manager" in result.json()["detail"]


def test_real_app_uses_authenticated_reveal_route(app, client, tmp_path, monkeypatch, launches):
    route = next(route for route in app.routes if getattr(route, "path", None) == "/open_reveal")
    assert route.endpoint is file_routes.open_reveal
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})

    result = client.post("/open_reveal", json={"path": str(tmp_path)})

    assert result.status_code == 401
    assert launches == []
