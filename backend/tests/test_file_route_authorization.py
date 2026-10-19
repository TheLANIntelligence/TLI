"""File controls use real browser sessions and no real launch or Trash effects."""
import json
from pathlib import Path
import stat
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import file_operations
import tli_state as S
from routers import file_routes as files

REAL_OPERATION_REQUEST = file_operations.request


ROUTES = ["/open_path", "/open_reveal", "/fs/delete", "/file/operations/capabilities",
          "/file/organize", "/file/rename", "/file/undo"]


@pytest.fixture
def house(tmp_path, monkeypatch):
    selected = tmp_path / "user" / "private-file.txt"
    selected.parent.mkdir(); selected.write_text("preserved contents")
    monkeypatch.setattr(S, "BASE_DIR", str(tmp_path / "install"))
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(S, "VAULT_DIR", str(tmp_path / "vault"))
    monkeypatch.setattr(S, "_active_sessions", {})
    pin = {"enabled": True}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(pin))
    monkeypatch.setattr(files.platform, "system", lambda: "Windows")
    monkeypatch.setattr(files, "hidden_process_kwargs", lambda: {"creationflags": 0x08000000})
    monkeypatch.setattr(files, "_safe_delete_roots", lambda: [selected.parent])
    protected = Mock(return_value=False)
    monkeypatch.setattr(S, "is_protected_system_path", protected)
    launch, reveal, trash = Mock(), Mock(), Mock()
    monkeypatch.setattr(files.os, "startfile", launch, raising=False)
    monkeypatch.setattr(files.subprocess, "Popen", reveal)
    monkeypatch.setattr(files, "send2trash", trash)
    def service(kind, owner, payload, *, check, **kwargs):
        check()
        return {"ok": True, "private": str(selected)}
    operation = Mock(side_effect=service)
    monkeypatch.setattr(file_operations, "request", operation)
    app = FastAPI(); app.include_router(files.router)
    clients = []
    def browser(mode="pin-local"):
        remote = mode in {"pin-remote", "pin-off-lan", "remote-http"}
        pin["enabled"] = mode not in {"open-local", "pin-off-lan"}
        origin = ("http" if mode == "remote-http" else "https") + "://192.0.2.9:8443" if remote else "http://localhost:8000"
        client = TestClient(app, base_url=origin, client=("192.0.2.20" if remote else "127.0.0.1", 1234),
                            headers={"Origin": origin, "Sec-Fetch-Site": "same-origin"})
        clients.append(client)
        token = S.create_session_token("alice") if mode not in {"open-local", "pin-off-lan", "anonymous"} else None
        if token: client.headers["Cookie"] = "tli_session=" + token
        return client, lambda: S.revoke_session_token(token) if token else pin.update(enabled=True)
    yield SimpleNamespace(path=selected, root=tmp_path, browser=browser, app=app, pin=pin,
                          launch=launch, reveal=reveal, trash=trash, operation=operation, protected=protected)
    for client in clients: client.close()
    assert selected.read_text() == "preserved contents"


def submit(client, route, path):
    if route.endswith("capabilities"): return client.get(route)
    body = {"path": str(path)}
    if route.endswith("organize"): body.update(actions={"Documents": [path.name]}, confirm=False)
    if route.endswith("rename"): body.update(prefix="reviewed", confirm=False)
    if route.endswith("undo"): body = {"confirm": False}
    return client.post(route, json=body)


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("mode", ["anonymous", "pin-off-lan", "remote-http", "stale", "foreign-origin",
    "missing-origin", "proxy", "peer", "bearer", "fetch-site"])
def test_denied_browser_never_probes_launches_trashes_or_opens_review(house, monkeypatch, route, mode):
    client, revoke = house.browser(mode)
    if mode == "stale": revoke(); house.pin["enabled"] = False
    if mode == "foreign-origin": client.headers["Origin"] = "https://foreign.invalid"
    if mode == "missing-origin":
        del client.headers["Origin"]
        # Read-only capability GET may omit Origin by the shared contract.
        if route.endswith("capabilities"): client.headers["Sec-Fetch-Site"] = "cross-site"
    if mode == "proxy": client.headers["Forwarded"] = "for=127.0.0.1"
    if mode == "peer": client.headers["X-TLI-Peer-Signature"] = "synthetic"
    if mode == "bearer": client.headers["Authorization"] = "Bearer tlic_synthetic"
    if mode == "fetch-site": client.headers["Sec-Fetch-Site"] = "cross-site"
    original = Path.exists
    def exists(path):
        if path == house.path: pytest.fail("Denied request probed selected path")
        return original(path)
    monkeypatch.setattr(Path, "exists", exists)
    response = submit(client, route, house.path)
    assert response.status_code == (401 if mode in {"anonymous", "stale"} else 403), response.text
    assert response.headers["cache-control"] == "no-store"
    for mock in (house.launch, house.reveal, house.trash, house.operation, house.protected): mock.assert_not_called()
    assert "private-file" not in response.text


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("mode", ["open-local", "pin-local", "pin-remote"])
def test_supported_browser_contracts_still_work_with_captured_authority(house, route, mode):
    client, _ = house.browser(mode)
    response = submit(client, route, house.path)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    if route == "/open_path": house.launch.assert_called_once_with(str(house.path))
    elif route == "/open_reveal":
        house.reveal.assert_called_once_with(["explorer.exe", "/select,", str(house.path)], shell=False, creationflags=0x08000000)
    elif route == "/fs/delete": house.trash.assert_called_once_with(str(house.path))
    elif not route.endswith("capabilities"):
        assert callable(house.operation.call_args.kwargs["check"])
        assert house.operation.call_args.args[1] == ("local" if mode == "open-local" else "alice")


@pytest.mark.parametrize("route", ["/open_path", "/open_reveal", "/fs/delete"])
@pytest.mark.parametrize("failure", [False, True])
def test_slow_path_probe_rechecks_before_effect_or_private_error(house, monkeypatch, route, failure):
    client, revoke = house.browser()
    original = Path.exists
    def exists(path):
        result = original(path)
        if path == house.path:
            revoke()
            if failure: raise OSError("PRIVATE path probe error")
        return result
    monkeypatch.setattr(Path, "exists", exists)
    response = submit(client, route, house.path)
    assert response.status_code == 401, response.text
    assert response.headers["cache-control"] == "no-store"
    assert "PRIVATE" not in response.text and "private-file" not in response.text
    for mock in (house.launch, house.reveal, house.trash): mock.assert_not_called()


@pytest.mark.parametrize("route", ["/open_path", "/open_reveal", "/fs/delete"])
@pytest.mark.parametrize("failure", [False, True])
def test_revocation_after_dispatch_never_repeats_or_discloses_result(house, route, failure):
    client, revoke = house.browser()
    effect = house.launch if route == "/open_path" else house.reveal if route == "/open_reveal" else house.trash
    def dispatched(*a, **k):
        revoke()
        if failure: raise OSError("PRIVATE dispatcher error after submission")
    effect.side_effect = dispatched
    response = submit(client, route, house.path)
    assert response.status_code == 401 and response.headers["cache-control"] == "no-store"
    assert "PRIVATE" not in response.text and "private-file" not in response.text
    effect.assert_called_once()


def test_trash_rechecks_after_waiting_for_mutation_lock(house, monkeypatch):
    client, revoke = house.browser()
    class Lock:
        def __enter__(self): revoke()
        def __exit__(self, *a): pass
    monkeypatch.setattr(files, "FILE_MUTATION_LOCK", Lock())
    response = submit(client, "/fs/delete", house.path)
    assert response.status_code == 401
    house.protected.assert_not_called(); house.trash.assert_not_called()


@pytest.mark.parametrize("stage", ["system", "roots", "final-path"])
def test_trash_rechecks_private_validation_before_submission(house, monkeypatch, stage):
    client, revoke = house.browser()
    if stage == "system": house.protected.side_effect = lambda *a: (revoke(), False)[1]
    elif stage == "roots": monkeypatch.setattr(files, "_is_protected_path", lambda *a: (revoke(), None)[1])
    else:
        original = files._trash_snapshot
        calls = 0
        def snapshot(*args):
            nonlocal calls
            result = original(*args); calls += 1
            if calls == 2: revoke()
            return result
        monkeypatch.setattr(files, "_trash_snapshot", snapshot)
    assert submit(client, "/fs/delete", house.path).status_code == 401
    house.trash.assert_not_called()


@pytest.mark.parametrize("field", ["BASE_DIR", "DATA_DIR", "VAULT_DIR"])
@pytest.mark.parametrize("scope", ["inside", "root", "ancestor"])
def test_trash_preserves_relocated_tli_state_and_its_containing_folders(house, monkeypatch, field, scope):
    root = house.path.parent / "relocated" / "tli-state"
    root.mkdir(parents=True)
    saved = root / "keep.json"; saved.write_text("saved state")
    monkeypatch.setattr(S, field, str(root))
    selected = saved if scope == "inside" else root if scope == "root" else root.parent
    client, _ = house.browser()
    response = submit(client, "/fs/delete", selected)
    assert response.status_code == 403, response.text
    assert saved.read_text() == "saved state"
    house.trash.assert_not_called()


@pytest.mark.parametrize("kind", ["symlink", "reparse"])
@pytest.mark.parametrize("parent", [False, True])
def test_linked_selection_or_parent_cannot_redirect_trash(house, monkeypatch, kind, parent):
    client, _ = house.browser()
    original = Path.lstat
    selected = house.path.parent if parent else house.path
    def info(path):
        value = original(path)
        if path != selected: return value
        return SimpleNamespace(st_mode=stat.S_IFLNK if kind == "symlink" else value.st_mode,
            st_file_attributes=0x400 if kind == "reparse" else 0)
    monkeypatch.setattr(Path, "lstat", info)
    response = submit(client, "/fs/delete", house.path)
    assert response.status_code == 409, response.text
    house.trash.assert_not_called()


def test_changed_target_identity_before_trash_preserves_selection(house, monkeypatch):
    client, _ = house.browser()
    original = files._trash_snapshot
    calls = 0
    def snapshot(*a):
        nonlocal calls
        result = original(*a); calls += 1
        return result if calls == 1 else (*result, ("changed",))
    monkeypatch.setattr(files, "_trash_snapshot", snapshot)
    assert submit(client, "/fs/delete", house.path).status_code == 409
    house.trash.assert_not_called()


@pytest.mark.parametrize("route", ["/file/organize", "/file/rename", "/file/undo"])
@pytest.mark.parametrize("failure", [False, True])
def test_route_service_guard_masks_late_private_receipt_and_error(house, route, failure):
    client, revoke = house.browser()
    def service(*a, check, **k):
        check(); revoke()
        if failure: raise OSError("PRIVATE operation receipt")
        return {"private": str(house.path)}
    house.operation.side_effect = service
    response = submit(client, route, house.path)
    assert response.status_code == 401 and "private-file" not in response.text and "PRIVATE" not in response.text
    house.operation.assert_called_once()


@pytest.mark.parametrize("system", ["Darwin", "Linux"])
def test_open_uses_explicit_argument_list_and_hidden_shell_wrapper(house, monkeypatch, system):
    monkeypatch.setattr(files.platform, "system", lambda: system)
    client, _ = house.browser()
    assert submit(client, "/open_path", house.path).status_code == 200
    house.launch.assert_not_called()
    house.reveal.assert_called_once_with(["open" if system == "Darwin" else "xdg-open", str(house.path)],
                                        shell=False, creationflags=0x08000000)


@pytest.mark.parametrize("parent", [False, True])
def test_trash_requires_a_file_identity_for_selection_and_parents(house, monkeypatch, parent):
    client, _ = house.browser()
    original = Path.lstat
    selected = house.path.parent if parent else house.path
    def info(path):
        value = original(path)
        if path != selected: return value
        return SimpleNamespace(st_mode=value.st_mode, st_ino=0, st_file_attributes=0)
    monkeypatch.setattr(Path, "lstat", info)
    response = submit(client, "/fs/delete", house.path)
    assert response.status_code == 409 and "identity is unavailable" in response.text
    house.trash.assert_not_called()


@pytest.mark.parametrize("route", ["/file/scan", "/files/scan", "/files/apply_rules", "/files/insight"])
@pytest.mark.parametrize("failure", [False, True])
def test_shallow_file_reads_recheck_private_path_errors(house, monkeypatch, route, failure):
    client, revoke = house.browser()
    def expand(path):
        revoke()
        if failure: raise HTTPException(404, "PRIVATE missing file path")
        return str(house.path.parent)
    monkeypatch.setattr(files, "expand_base_path", expand)
    response = client.post(route, json={"path": str(house.path.parent), "root": str(house.path.parent), "rules": "group text"})
    assert response.status_code == 401 and response.headers["cache-control"] == "no-store"
    assert "PRIVATE" not in response.text and "private-file" not in response.text
    for mock in (house.launch, house.reveal, house.trash, house.operation): mock.assert_not_called()


@pytest.mark.parametrize("failure_status", [401, 503])
def test_real_http_move_keeps_partial_receipt_after_access_loss_without_replaying(house, monkeypatch, failure_status):
    # Real request guard, service and temporary file moves; no OS launch/Trash.
    monkeypatch.setattr(file_operations, "request", REAL_OPERATION_REQUEST)
    monkeypatch.setattr(file_operations, "_plans", {})
    record = house.root / "state" / "last_file_op.json"
    monkeypatch.setattr(S, "LAST_FILE_OP_PATH", record)
    home = house.root / "move-fixture"; home.mkdir()
    for name in ("one.txt", "two.txt"): (home / name).write_text(name)
    payload = {"path": str(home), "actions": {"Target": ["one.txt", "two.txt"]}, "confirm": False}
    client, revoke = house.browser()
    preview = client.post("/file/organize", json=payload)
    assert preview.status_code == 200 and preview.json()["can_execute"]
    payload.update(confirm=True, preview_id=preview.json()["preview_id"])
    calls = []
    original = file_operations._exclusive_move
    def moved(source, destination, expected, **kwargs):
        assert source.is_relative_to(home) and destination.is_relative_to(home)
        result = original(source, destination, expected, **kwargs)
        calls.append((source, destination))
        if failure_status == 401: revoke()
        else:
            def unavailable(): raise HTTPException(503, "Security state unavailable")
            monkeypatch.setattr(S, "load_pin_config", unavailable)
        return result
    monkeypatch.setattr(file_operations, "_exclusive_move", moved)
    response = client.post("/file/organize", json=payload)
    assert response.status_code == failure_status and response.headers["cache-control"] == "no-store"
    assert str(home) not in response.text and "one.txt" not in response.text
    assert not (home / "one.txt").exists()
    assert (home / "Target" / "one.txt").read_text() == "one.txt"
    assert (home / "two.txt").read_text() == "two.txt" and len(calls) == 1
    saved = json.loads(record.read_bytes())
    assert saved["status"] == "partial" and saved["receipt"]["moved_count"] == 1
    assert [row["status"] for row in saved["results"]] == ["moved", "not_attempted"]
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(house.pin))
    recovered, _ = house.browser()
    receipt = recovered.post("/file/organize", json=payload)
    assert receipt.status_code == 200 and receipt.json()["moved_count"] == 1
    assert receipt.json()["access_stopped"] and len(calls) == 1
    undo = recovered.post("/file/undo", json={"confirm": False, "operation_id": saved["id"]})
    assert undo.status_code == 200 and undo.json()["can_execute"]
    assert len(undo.json()["items"]) == 1 and len(calls) == 1
