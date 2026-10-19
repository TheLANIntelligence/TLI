from __future__ import annotations

import sys

import pytest

import tli_state as S
from builder.command_runner import run_approved_command


@pytest.fixture()
def pin_required(monkeypatch):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})


@pytest.mark.parametrize(
    ("method", "path", "json_body"),
    [
        ("get", "/api/builder/status", None),
        ("post", "/api/builder/run-command", {"command": "python --version", "approved": True}),
        ("post", "/update/check", None),
        ("post", "/update/settings", {"update_url": "http://127.0.0.1/manifest.json"}),
        ("post", "/device/nickname", {"nickname": "FOX"}),
        ("post", "/system/node/name", {"name": "FOX"}),
        ("post", "/system/lm_studio/test", {"url": "http://127.0.0.1:1234/v1"}),
        ("post", "/system/lm_studio/url", {"url": "http://127.0.0.1:1234/v1"}),
    ],
)
def test_sensitive_routes_require_session_when_pin_enabled(client, pin_required, method, path, json_body):
    request = getattr(client, method)
    kwargs = {}
    if json_body is not None:
        kwargs["json"] = json_body

    if path.startswith("/system/lm_studio/") or path in {"/device/nickname", "/system/node/name"}:
        # Exercise PIN admission using an actual same-origin browser transport;
        # unsupported HTTP remote/proxy transport is separately forbidden.
        res = request("https://testserver" + path, headers={"Origin": "https://testserver"}, **kwargs)
    else:
        res = request(path, **kwargs)

    assert res.status_code == 401


def test_emergency_pin_reset_requires_unlocked_browser(tmp_path, monkeypatch):
    """An anonymous reset must not bypass the PIN or overwrite security state."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers import system_routes
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "pin.json")
    S.save_pin_config("a" * 64, "b" * 64)
    before = S.PIN_CONFIG_FILE.read_bytes()
    app = FastAPI()
    app.include_router(system_routes.router)
    with TestClient(app, base_url="https://localhost", headers={"Origin": "https://localhost"}) as browser:
        assert browser.post("/system/pin/emergency-reset").status_code == 401
    assert S.PIN_CONFIG_FILE.read_bytes() == before


def test_builder_command_runner_blocks_shell_operators(tmp_path):
    with pytest.raises(ValueError, match="Shell operators are blocked"):
        run_approved_command(tmp_path, "python --version & echo unsafe", approved=True)


def test_builder_command_runner_allows_simple_commands(tmp_path):
    result = run_approved_command(tmp_path, f"{sys.executable} --version", approved=True)

    assert result["exit_code"] == 0
    assert result["approved"] is True
    assert "Python" in (result["stdout"] + result["stderr"])
