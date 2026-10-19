"""Legacy source stays intact; only browser-authorized built-ins can run."""
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

import tli_state as S
from routers import tool_routes as tools, hub_routes as hub
from ai import intent_engine, diagnostics


@pytest.fixture
def boundary(tmp_path, monkeypatch):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    source = scripts / "saved.py"
    source.write_text("# Private saved source\nprint('never executed')\n", encoding="utf-8")
    index = tmp_path / "tools_index.json"
    index.write_text(json.dumps({"saved-script": {"id": "saved-script", "name": "Saved source", "language": "py", "script_path": str(source), "custom": "keep"}}), encoding="utf-8")
    packages = tmp_path / "hub_packages"
    packages.mkdir()
    (packages / "script_saved-script.json").write_text(json.dumps({"shell": "powershell", "code": "# Stored Hub source"}), encoding="utf-8")
    (tmp_path / "hub_installed.json").write_text(json.dumps([{"id": "saved-script", "name": "Saved Hub script", "type": "script"}]), encoding="utf-8")
    monkeypatch.setattr(S, "SCRIPTS_DIR", scripts)
    monkeypatch.setattr(S, "TOOLS_INDEX_PATH", index)
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "_active_sessions", {})
    pin = {"enabled": False}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(pin))
    denied = Mock(side_effect=AssertionError("No external process or model request is allowed"))
    monkeypatch.setattr(tools.subprocess, "run", denied)
    monkeypatch.setattr(tools.requests, "post", denied)
    monkeypatch.setattr(tools.requests, "get", denied)
    app = FastAPI()
    app.include_router(tools.router)
    app.include_router(hub.router)
    clients = []

    def browser(mode="open-local"):
        remote = mode in {"pin-https", "anonymous-lan", "http-lan"}
        pin["enabled"] = mode not in {"open-local", "anonymous-lan", "stale-local"}
        base = "https://tli.example.test:8443" if remote and mode != "http-lan" else "http://localhost:8000"
        api = TestClient(app, base_url=base, client=("192.0.2.20" if remote else "127.0.0.1", 12345), headers={"Origin": base})
        token = None
        if mode not in {"open-local", "anonymous-lan", "pin-anonymous"}:
            token = S.create_session_token("local")
            api.cookies.set("tli_session", token)
        if mode == "stale-local":
            S.revoke_session_token(token)
        clients.append(api)
        return api, token

    yield SimpleNamespace(browser=browser, app=app, root=tmp_path, source=source, index=index, denied=denied, pin=pin)
    for api in clients:
        api.close()


PRIVATE = [
    ("GET", "/tools/list", None), ("GET", "/tools/list_scripts", None),
    ("GET", "/tools/scripts/saved-script/source", None),
    ("GET", "/hub/packages/saved-script/source", None),
    ("POST", "/tools/run", {"tool_id": "sys_snapshot"}),
    ("POST", "/tools/run", {"tool_id": "saved-script"}),
    ("POST", "/tools/generate_script", {"task_description": "Never generate"}),
    ("DELETE", "/tools/delete_script/saved-script", None),
]


@pytest.mark.parametrize("method,path,body", PRIVATE)
@pytest.mark.parametrize("mode", ["pin-anonymous", "anonymous-lan", "http-lan", "stale-local"])
def test_private_tools_require_browser_authority_before_source_or_handler(boundary, monkeypatch, mode, method, path, body):
    api, _ = boundary.browser(mode)
    read = Mock(side_effect=AssertionError("Denied requests must not read private sources"))
    monkeypatch.setattr(tools, "list_tools", read)
    monkeypatch.setattr(tools, "read_tool_source", read)
    monkeypatch.setattr(hub, "read_hub_source", read)
    monkeypatch.setitem(tools.BUILTIN_TOOLS, "sys_snapshot", {"handler": read})
    response = api.request(method, path, **({"json": body} if body is not None else {}))
    assert response.status_code in (401, 403), response.text
    read.assert_not_called()
    boundary.denied.assert_not_called()


@pytest.mark.parametrize("mode", ["open-local", "pin-local", "pin-https"])
def test_sources_are_plaintext_and_nonbuiltin_mutations_retired_without_changes(boundary, mode):
    api, _ = boundary.browser(mode)
    before = {p: p.read_bytes() for p in boundary.root.rglob("*") if p.is_file()}
    rows = api.get("/tools/list").json()["tools"]
    saved = next(row for row in rows if row["id"] == "saved-script")
    assert saved["executable"] is False and saved["kind"] == "script"
    assert len([row for row in rows if row["executable"]]) == 7
    for path in ["/tools/scripts/saved-script/source", "/hub/packages/saved-script/source"]:
        result = api.get(path)
        assert result.status_code == 200, result.text
        assert result.json()["execution_allowed"] is False
        assert "source" in result.json()["contents"]
        assert result.headers["cache-control"] == "no-store"
    for method, path, body in [
        ("POST", "/tools/run", {"tool_id": "saved-script"}),
        ("POST", "/tools/run", {"tool_id": "unknown"}),
        ("POST", "/tools/generate_script", {"script_name": "saved", "language": "py"}),
        ("DELETE", "/tools/delete_script/saved-script", None),
        ("POST", "/hub/packages/saved-script/run", None),
    ]:
        result = api.request(method, path, **({"json": body} if body else {}))
        assert result.status_code == 410, result.text
        assert result.headers["cache-control"] == "no-store"
    assert {p: p.read_bytes() for p in boundary.root.rglob("*") if p.is_file()} == before
    boundary.denied.assert_not_called()


@pytest.mark.parametrize("headers", [{"Origin": "null"}, {"Origin": "https://other.example.test"}, {"X-TLI-Peer-Signature": "untrusted"}, {"Authorization": "Bearer device-token"}, {"X-Forwarded-For": "127.0.0.1"}])
def test_device_credentials_and_cross_origin_requests_cannot_run_builtins(boundary, monkeypatch, headers):
    api, _ = boundary.browser("pin-local")
    handler = Mock()
    monkeypatch.setitem(tools.BUILTIN_TOOLS, "sys_snapshot", {"handler": handler})
    result = api.post("/tools/run", headers=headers, json={"tool_id": "sys_snapshot"})
    assert result.status_code == 403
    handler.assert_not_called()


@pytest.mark.parametrize("tool_id,params", [
    ("sys_top_processes", {"limit": 0}), ("sys_top_processes", {"limit": 101}),
    ("sys_top_processes", {"limit": True}), ("sys_top_processes", {"limit": "5"}),
    ("sys_snapshot", {"command": "anything"}),
    ("net_connectivity_diag", {"hosts": []}), ("net_connectivity_diag", {"hosts": ["localhost"] * 11}),
    ("net_connectivity_diag", {"hosts": ["-f"]}), ("net_connectivity_diag", {"hosts": ["127.0.0.1 & echo x"]}),
    ("net_connectivity_diag", {"hosts": ["https://example.test"]}), ("net_connectivity_diag", {"hosts": [None]}),
])
def test_typed_parameters_reject_unbounded_or_command_like_input(boundary, monkeypatch, tool_id, params):
    api, _ = boundary.browser()
    handler = Mock()
    monkeypatch.setitem(tools.BUILTIN_TOOLS, tool_id, {"handler": handler})
    assert api.post("/tools/run", json={"tool_id": tool_id, "params": params}).status_code == 422
    handler.assert_not_called()
    boundary.denied.assert_not_called()


def test_revocation_during_builtin_withholds_result_and_stops_following_targets(boundary, monkeypatch):
    api, token = boundary.browser("pin-local")
    def run(*args, **kwargs):
        S.revoke_session_token(token)
        return {"ok": True}
    ping = Mock(side_effect=run)
    monkeypatch.setattr(tools, "_run_subprocess", ping)
    result = api.post("/tools/run", json={"tool_id": "net_connectivity_diag", "params": {"hosts": ["localhost", "::1"]}})
    assert result.status_code == 401
    assert "output" not in result.json()
    ping.assert_called_once()


def test_builtin_chat_uses_captured_authority_in_process_and_never_loopback(boundary, monkeypatch):
    handler = Mock(return_value={"hostname": "Authorized host"})
    monkeypatch.setitem(tools.BUILTIN_TOOLS, "sys_snapshot", {"handler": handler})
    result = intent_engine.execute_action("http://localhost:8000", {"type": "tool_run", "tool_id": "sys_snapshot"})
    assert result.success is False
    handler.assert_not_called()
    check = Mock()
    result = intent_engine.execute_action("http://localhost:8000", {"type": "tool_run", "tool_id": "sys_snapshot"}, check=check)
    assert result.success is True
    handler.assert_called_once_with({})
    assert check.call_count >= 3
    boundary.denied.assert_not_called()


def test_diagnostic_revocation_propagates_instead_of_continuing_private_checks():
    with pytest.raises(HTTPException) as error:
        diagnostics._check("Private read", lambda: (True, "not disclosed"), check=Mock(side_effect=HTTPException(401, "Revoked")))
    assert error.value.status_code == 401


@pytest.mark.parametrize("mode", ["pin-anonymous", "anonymous-lan", "http-lan", "stale-local"])
def test_full_diagnostic_route_denies_before_manager_registry_or_network(boundary, monkeypatch, mode):
    from ai import ai_routes
    boundary.app.include_router(ai_routes.router)
    manager = Mock(side_effect=AssertionError("No private state before admission"))
    monkeypatch.setattr(ai_routes.BundledAIManager, "get", manager)
    monkeypatch.setattr(ai_routes.S, "load_shelly_registry", manager)
    api, _ = boundary.browser(mode)
    assert api.get("/api/ai/diagnostics").status_code in (401, 403)
    manager.assert_not_called()
    boundary.denied.assert_not_called()


@pytest.mark.parametrize("authorized", [False, True])
def test_chat_initiation_binds_original_browser_to_builtin_dispatch(boundary, monkeypatch, authorized):
    from ai import ai_routes
    import home_conversation
    monkeypatch.setattr(home_conversation, "answer", lambda *_: None)
    monkeypatch.setattr(S, "load_shelly_registry", lambda: [])
    monkeypatch.setattr(ai_routes, "_log", lambda *_: None)
    handler = Mock(return_value={"hostname": "Authorized host"})
    monkeypatch.setitem(tools.BUILTIN_TOOLS, "sys_snapshot", {"handler": handler})

    @boundary.app.post("/test-chat")
    def chat(request: Request):
        return {"reply": ai_routes._route_action_intent(request, "Show me system info")}

    api, _ = boundary.browser("pin-local" if authorized else "pin-anonymous")
    result = api.post("/test-chat")
    assert result.status_code == (200 if authorized else 401)
    assert handler.call_count == int(authorized)
    if authorized:
        assert "Authorized host" in result.json()["reply"]
    else:
        assert "Authorized host" not in result.text
    boundary.denied.assert_not_called()


def test_full_diagnostic_rechecks_revocation_and_never_returns_private_report(boundary, monkeypatch):
    from ai import ai_routes
    boundary.app.include_router(ai_routes.router)
    monkeypatch.setattr(ai_routes.BundledAIManager, "get", lambda: SimpleNamespace(active_preset_id=None))
    monkeypatch.setattr(S, "load_shelly_registry", lambda: [])
    api, token = boundary.browser("pin-local")
    def report(**kwargs):
        kwargs["check"]()
        S.revoke_session_token(token)
        return {"private": "not disclosed"}
    monkeypatch.setattr(ai_routes, "run_full_diagnostic", report)
    result = api.get("/api/ai/diagnostics")
    assert result.status_code == 401
    assert "not disclosed" not in result.text
