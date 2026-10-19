"""License bootstrap, browser authority and preserved settings in temporary roots."""
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import license as L
import license_store as store
import tli_state as S
from routers import license_routes as routes

VALID = {"valid": True, "tier": "pro", "licensee": "PRIVATE LICENSEE", "issued_at": "2026-01-01T00:00:00Z",
         "expires_at": "2099-01-01T00:00:00Z", "node_bound": True, "error": None}
SAVED = {"key": "PRIVATE OLD KEY", "future": {"retain": [1, True, None]}}
PRIVATE = [("GET", "/license/details", None), ("POST", "/license/activate", {"key": "NEW PRIVATE KEY"}),
           ("DELETE", "/license/deactivate", None)]


@pytest.fixture
def house(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "LICENSE_FILE", tmp_path / "tli_license.json")
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "pin.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(store, "_SEEN", set())
    monkeypatch.setattr(L, "BETA_MODE", False)
    monkeypatch.setattr(L, "_cache_unavailable", False)
    monkeypatch.setattr(L, "_cached_result", dict(VALID))
    S.save_pin_config("a" * 64, "b" * 64)
    node = Mock(return_value=SimpleNamespace(node_id="PRIVATE NODE ID"))
    validate = Mock(return_value=dict(VALID))
    log = Mock()
    monkeypatch.setattr(S, "load_node_config", node)
    monkeypatch.setattr(L, "validate_key", validate)
    monkeypatch.setattr(S, "log_debug", log)
    app = FastAPI(); app.include_router(routes.router)
    clients = []
    def browser(mode="pin-local"):
        local = mode not in {"pin-https", "pin-off-lan", "remote-http"}
        origin = "http://localhost:8000" if local else ("http" if mode == "remote-http" else "https") + "://192.0.2.5:8443"
        if mode in {"open-local", "pin-off-lan"}:
            monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
        client = TestClient(app, base_url=origin, client=("127.0.0.1" if local else "192.0.2.8", 40000),
                            headers={"Origin": origin}, raise_server_exceptions=False)
        token = None if mode in {"anonymous", "open-local", "pin-off-lan"} else S.create_session_token("owner")
        if token: client.headers["Cookie"] = "tli_session=" + token
        if mode == "revoked": S.revoke_session_token(token)
        if mode == "expired": S._active_sessions[token]["expiry"] = 0
        if mode == "cross-origin": client.headers["Origin"] = "https://unrelated.invalid"
        if mode == "same-site": client.headers["Sec-Fetch-Site"] = "same-site"
        if mode == "proxy": client.headers["X-Forwarded-For"] = "127.0.0.1"
        if mode == "peer": client.headers["X-TLI-Peer-Signature"] = "synthetic"
        if mode == "bearer": client.headers["Authorization"] = "Bearer paired-credential"
        clients.append(client)
        return client, token
    def seed(value=SAVED):
        raw = json.dumps(value).encode(); S.LICENSE_FILE.write_bytes(raw); return raw
    yield SimpleNamespace(path=S.LICENSE_FILE, seed=seed, browser=browser, node=node, validate=validate, log=log)
    for client in clients: client.close()


def request(client, item):
    method, path, body = item
    return client.request(method, path, **({"json": body} if body is not None else {}))


def denied(call, status=503):
    with pytest.raises(HTTPException) as caught: call()
    assert caught.value.status_code == status


def no_staging(house):
    assert not list(house.path.parent.glob(".tli-license-*.tmp"))


@pytest.mark.parametrize("beta", [False, True])
def test_public_bootstrap_has_exact_minimal_shape_and_no_private_reads(house, monkeypatch, beta):
    monkeypatch.setattr(L, "BETA_MODE", beta)
    load = Mock(side_effect=AssertionError("bootstrap cannot read saved key"))
    monkeypatch.setattr(S, "load_license", load)
    client, _ = house.browser("anonymous")
    result = client.get("/license/status")
    assert result.status_code == 200 and result.headers["cache-control"] == "no-store"
    assert set(result.json()) == {"tier", "valid", "beta", "features"}
    assert result.json()["tier"] == "pro" and result.json()["valid"] is True
    assert result.json()["beta"] is beta
    assert "PRIVATE" not in result.text
    load.assert_not_called(); house.node.assert_not_called(); house.validate.assert_not_called()


@pytest.mark.parametrize("item", PRIVATE)
@pytest.mark.parametrize("mode", ["anonymous", "pin-off-lan", "revoked", "expired", "cross-origin", "same-site", "proxy", "peer", "bearer", "remote-http"])
def test_private_routes_deny_before_any_saved_read_validation_or_write(house, monkeypatch, item, mode):
    before = house.seed(); client, _ = house.browser(mode)
    load = Mock(side_effect=AssertionError("private read before admission")); save = Mock()
    monkeypatch.setattr(S, "load_license", load); monkeypatch.setattr(S, "save_license", save)
    result = request(client, item)
    assert result.status_code == (401 if mode in {"anonymous", "revoked", "expired"} else 403), result.text
    assert result.headers["cache-control"] == "no-store"
    assert "PRIVATE" not in result.text
    load.assert_not_called(); save.assert_not_called(); house.node.assert_not_called(); house.validate.assert_not_called()
    assert house.path.read_bytes() == before and L.get_active_tier() == "pro"


@pytest.mark.parametrize("mode", ["open-local", "pin-local", "pin-https"])
@pytest.mark.parametrize("item", PRIVATE)
def test_supported_browser_contract_and_metadata_preservation(house, item, mode):
    house.seed(); client, _ = house.browser(mode)
    assert S.load_license() == SAVED
    result = request(client, item)
    assert result.status_code == 200, result.text
    assert result.headers["cache-control"] == "no-store"
    data = result.json()
    if item[1] == "/license/details":
        assert set(data) == {"tier", "valid", "beta", "features", "licensee", "issued_at", "expires_at", "node_bound", "node_id"}
        assert data["licensee"] == VALID["licensee"] and "key" not in data
        assert S.load_license() == SAVED
    elif item[1] == "/license/activate":
        assert data["valid"] is True and data["node_id"] == "PRIVATE NODE ID"
        assert S.load_license() == {**SAVED, "key": "NEW PRIVATE KEY"}
        assert L.get_active_tier() == "pro"
    else:
        assert data == {"tier": "free", "valid": False, "message": "License removed"}
        assert S.load_license() == {"future": SAVED["future"]} and L.get_active_tier() == "free"
    assert "PRIVATE LICENSEE" not in str(house.log.call_args_list)
    assert "PRIVATE KEY" not in str(house.log.call_args_list)
    no_staging(house)


@pytest.mark.parametrize("item", PRIVATE[1:])
def test_mutation_requires_origin_even_with_live_cookie(house, item):
    before = house.seed(); client, _ = house.browser(); del client.headers["Origin"]
    assert request(client, item).status_code == 403
    assert house.path.read_bytes() == before


def test_invalid_key_does_not_change_store_or_live_cache(house):
    before = house.seed(); client, _ = house.browser()
    house.validate.return_value = {**VALID, "valid": False, "error": "Invalid license key"}
    result = request(client, PRIVATE[1])
    assert result.status_code == 400 and result.json()["detail"] == "Invalid license key"
    assert house.path.read_bytes() == before and L.get_active_tier() == "pro"
    house.log.assert_not_called(); no_staging(house)


@pytest.mark.parametrize("key,status", [(" ", 400), ("PRIVATE" * store.MAX_KEY_BYTES, 422)], ids=["empty", "oversized"])
def test_empty_or_oversized_activation_is_bounded_before_validation(house, key, status):
    before = house.seed(); client, _ = house.browser()
    result = client.post("/license/activate", json={"key": key})
    assert result.status_code == status and house.path.read_bytes() == before
    assert result.headers["cache-control"] == "no-store" and "PRIVATE" not in result.text
    house.validate.assert_not_called()


@pytest.mark.parametrize("body", [{}, {"key": {"PRIVATE": "KEY"}}, {"key": None}, ["PRIVATE KEY"]], ids=["missing", "object", "null", "list"])
def test_invalid_activation_bodies_never_echo_secret_input(house, body):
    before = house.seed(); client, _ = house.browser()
    result = client.post("/license/activate", json=body)
    assert result.status_code == 422 and "PRIVATE" not in result.text
    assert result.headers["cache-control"] == "no-store"
    assert house.path.read_bytes() == before and L.get_active_tier() == "pro"
    house.validate.assert_not_called()


def test_unreadable_original_preserves_bytes_and_invalidates_stale_entitlement(house, monkeypatch):
    before = house.seed(); client, _ = house.browser(); original = os.open
    def open_file(path, *args, **kwargs):
        if Path(path) == house.path: raise PermissionError("PRIVATE FAILURE")
        return original(path, *args, **kwargs)
    monkeypatch.setattr(store.os, "open", open_file)
    for item in PRIVATE:
        result = request(client, item)
        assert result.status_code == 503 and "PRIVATE" not in result.text
    assert house.path.read_bytes() == before
    denied(L.get_active_tier); house.validate.assert_not_called(); no_staging(house)


BAD_DOCUMENTS = [b"", b"{", b"[]", b"null", b"false", b"\xff", b'{"key":1}',
    b'{"key":"one","key":"two"}', b'{"future":{"a":1,"a":2}}',
    b'{"future":NaN}', b'{"future":Infinity}', b'{"future":1e999}',
    b'{"key":"\\ud800"}', b" " * (store.MAX_BYTES + 1), json.dumps({"key": "x" * (store.MAX_KEY_BYTES + 1)}).encode()]


@pytest.mark.parametrize("raw", BAD_DOCUMENTS, ids=["empty", "truncated", "list", "null", "bool", "utf8", "key-type", "duplicate", "nested-duplicate", "nan", "infinity", "overflow", "surrogate", "oversize", "key-oversize"])
def test_damaged_optional_license_is_preserved_and_never_overwritten_or_granted(house, raw):
    house.path.write_bytes(raw); client, _ = house.browser()
    denied(S.load_license); denied(lambda: S.save_license({}))
    for item in PRIVATE:
        result = request(client, item)
        assert result.status_code == 503, result.text
        assert "PRIVATE" not in result.text and result.headers["cache-control"] == "no-store"
    assert house.path.read_bytes() == raw
    denied(L.get_active_tier)
    status = client.get("/license/status")
    assert status.status_code == 503 and set(status.json()) == {"detail"}
    house.validate.assert_not_called(); no_staging(house)


def test_missing_is_empty_without_creation_and_observed_disappearance_is_not(house):
    assert S.load_license() == {} and not house.path.exists()
    house.seed(); S.load_license(); house.path.unlink()
    denied(S.load_license); denied(lambda: S.save_license({}))
    assert not house.path.exists()


@pytest.mark.parametrize("kind", ["hardlink", "symlink", "broken-symlink", "parent-symlink", "case-alias", "directory", "zero-file-inode", "zero-parent-inode"])
def test_ambiguous_or_linked_license_files_are_preserved(house, tmp_path, monkeypatch, kind):
    outside = tmp_path / "outside.json"; outside.write_text(json.dumps(SAVED)); before = outside.read_bytes()
    if kind == "hardlink": os.link(outside, house.path)
    elif kind in {"symlink", "broken-symlink", "parent-symlink"}:
        try:
            if kind == "parent-symlink":
                linked = tmp_path / "linked"; linked.symlink_to(tmp_path, target_is_directory=True)
                monkeypatch.setattr(S, "LICENSE_FILE", linked / "license.json")
            else: house.path.symlink_to(outside if kind == "symlink" else tmp_path / "absent")
        except OSError as error: pytest.skip(str(error))
    elif kind == "case-alias": house.path.with_name(house.path.name.upper()).write_bytes(before)
    elif kind == "directory": house.path.mkdir()
    else:
        house.seed(); original = Path.lstat
        target = house.path if kind == "zero-file-inode" else house.path.parent
        def lstat(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            if path == target:
                values = {name: getattr(info, name) for name in dir(info) if name.startswith("st_")}
                values["st_ino"] = 0
                return SimpleNamespace(**values)
            return info
        monkeypatch.setattr(Path, "lstat", lstat)
    denied(S.load_license); denied(lambda: S.save_license({}))
    assert outside.read_bytes() == before


@pytest.mark.parametrize("phase,item", [(phase, item) for item in PRIVATE for phase in ["read", "node", "validation", "fsync"]
    if not (item[1] == "/license/deactivate" and phase in {"node", "validation"})
    and not (item[1] == "/license/details" and phase == "fsync")])
def test_revocation_before_commit_does_not_write_or_revoke_other_users_entitlements(house, monkeypatch, phase, item):
    before = house.seed(); client, token = house.browser()
    def revoke(): S.revoke_session_token(token)
    if phase == "read":
        original = S.load_license
        def read(): value = original(); revoke(); return value
        monkeypatch.setattr(S, "load_license", read)
    elif phase == "node": house.node.side_effect = lambda: (revoke(), SimpleNamespace(node_id="PRIVATE NODE ID"))[1]
    elif phase == "validation": house.validate.side_effect = lambda *args, **kwargs: (revoke(), dict(VALID))[1]
    else:
        original = os.fsync
        def fsync(fd): original(fd); revoke()
        monkeypatch.setattr(store.os, "fsync", fsync)
    result = request(client, item)
    assert result.status_code == 401, result.text
    assert "PRIVATE" not in result.text and house.path.read_bytes() == before
    assert L.get_active_tier() == "pro"
    no_staging(house)


@pytest.mark.parametrize("item", PRIVATE[1:])
def test_completed_change_updates_cache_before_revoked_response(house, monkeypatch, item):
    house.seed(); client, token = house.browser(); original = os.replace
    def replace(source, destination):
        original(source, destination); S.revoke_session_token(token)
    monkeypatch.setattr(store.os, "replace", replace)
    result = request(client, item)
    assert result.status_code == 401 and "PRIVATE" not in result.text
    saved = S.load_license()
    if item[1] == "/license/deactivate": assert "key" not in saved and L.get_active_tier() == "free"
    else: assert saved["key"] == "NEW PRIVATE KEY" and L.get_active_tier() == "pro"
    assert saved["future"] == SAVED["future"]
    house.log.assert_not_called(); no_staging(house)


@pytest.mark.parametrize("item", PRIVATE[1:])
def test_revocation_during_postcommit_log_retains_actual_cache_and_saved_result(house, item):
    house.seed(); client, token = house.browser()
    house.log.side_effect = lambda *args, **kwargs: S.revoke_session_token(token)
    result = request(client, item)
    assert result.status_code == 401 and "PRIVATE" not in result.text
    saved = S.load_license()
    assert saved["future"] == SAVED["future"]
    if item[1] == "/license/deactivate": assert "key" not in saved and L.get_active_tier() == "free"
    else: assert saved["key"] == "NEW PRIVATE KEY" and L.get_active_tier() == "pro"
    assert house.log.call_count == 1; no_staging(house)


def test_original_changed_during_validation_blocks_overwrite_and_invalidates_old_cache(house):
    house.seed(); client, _ = house.browser()
    external = {"key": "EXTERNAL KEY", "future": {"external": True}}
    def validate(*args, **kwargs): house.seed(external); return dict(VALID)
    house.validate.side_effect = validate
    result = request(client, PRIVATE[1])
    assert result.status_code == 409 and S.load_license() == external
    denied(L.get_active_tier); no_staging(house)


@pytest.mark.parametrize("phase", ["initial-read", "stored-validation", "final-original-read"])
def test_real_state_failure_is_retained_when_error_recheck_also_loses_authority(house, monkeypatch, phase):
    before = house.seed(); client, token = house.browser()
    def revoke(): S.revoke_session_token(token)
    if phase == "initial-read":
        house.path.write_bytes(b"{")
        original = S.load_license
        def load():
            try: return original()
            finally: revoke()
        monkeypatch.setattr(S, "load_license", load)
    elif phase == "stored-validation":
        def validate(*args, **kwargs):
            revoke(); raise RuntimeError("PRIVATE VALIDATION FAILURE")
        house.validate.side_effect = validate
    else:
        sync, decode = os.fsync, store._decode
        def fsync(fd): sync(fd); house.path.write_bytes(b"{")
        def decode_saved(raw):
            try: return decode(raw)
            except HTTPException:
                if raw == b"{": revoke()
                raise
        monkeypatch.setattr(store.os, "fsync", fsync)
        monkeypatch.setattr(store, "_decode", decode_saved)
    result = request(client, PRIVATE[1] if phase == "final-original-read" else PRIVATE[0])
    assert result.status_code == 401 and "PRIVATE" not in result.text
    assert house.path.read_bytes() == (before if phase == "stored-validation" else b"{")
    denied(L.get_active_tier); no_staging(house)


@pytest.mark.parametrize("phase", ["fsync", "replace-before", "replace-after"])
@pytest.mark.parametrize("item", PRIVATE[1:])
def test_uncertain_storage_failure_never_claims_success_or_keeps_stale_grants(house, monkeypatch, phase, item):
    before = house.seed(); client, _ = house.browser(); original = os.replace; calls = []
    def replace(source, destination):
        calls.append(True)
        if phase == "replace-after": original(source, destination)
        raise OSError("PRIVATE FAILURE TEXT")
    if phase == "fsync": monkeypatch.setattr(store.os, "fsync", lambda fd: (_ for _ in ()).throw(OSError("PRIVATE SYNC FAILURE")))
    else: monkeypatch.setattr(store.os, "replace", replace)
    result = request(client, item)
    assert result.status_code == 503 and "PRIVATE" not in result.text
    assert "message" not in result.json() and "tier" not in result.json()
    assert len(calls) == (0 if phase == "fsync" else 1)
    if phase == "fsync": assert L.get_active_tier() == "pro"
    else: denied(L.get_active_tier)
    if phase != "replace-after": assert house.path.read_bytes() == before
    elif item[1] == "/license/deactivate": assert "key" not in S.load_license()
    else: assert S.load_license()["key"] == "NEW PRIVATE KEY"
    no_staging(house)


@pytest.mark.parametrize("change,status", [("valid", 409), ("damage", 503), ("stage", 503), ("gone", 503)])
def test_changes_during_fsync_are_preserved_without_cache_publication(house, monkeypatch, change, status):
    before = house.seed(); client, _ = house.browser(); original = os.fsync
    changed = json.dumps({**SAVED, "future": {"external": True}}).encode() if change == "valid" else b"{"
    def fsync(fd):
        original(fd)
        if change == "stage":
            size = os.fstat(fd).st_size; os.lseek(fd, 0, 0); os.write(fd, b"x" * size)
        elif change == "gone": house.path.unlink()
        else: house.path.write_bytes(changed)
    monkeypatch.setattr(store.os, "fsync", fsync)
    result = request(client, PRIVATE[1])
    assert result.status_code == status, result.text
    if change == "stage": assert L.get_active_tier() == "pro"
    else: denied(L.get_active_tier)
    if change == "gone": assert not house.path.exists()
    else: assert house.path.read_bytes() == (before if change == "stage" else changed)
    no_staging(house)


@pytest.mark.parametrize("beta", [False, True])
def test_optional_corrupt_license_bootstrap_is_unavailable_without_crashing_or_reset(house, monkeypatch, beta):
    monkeypatch.setattr(L, "BETA_MODE", beta)
    raw = b"{PRIVATE CORRUPT LICENSE"; house.path.write_bytes(raw)
    result = L.bootstrap_cache(S.load_license, "PRIVATE NODE ID")
    assert result == {"available": False, "valid": False} and house.path.read_bytes() == raw
    denied(L.get_status)
    if beta: assert L.get_active_tier() == "pro" and L.has_feature("free", "vault") is True
    else: denied(L.get_active_tier)
    house.validate.assert_not_called()


def test_checked_details_reconciles_readable_store_after_uncertain_commit(house):
    house.seed(); L.mark_cache_unavailable(); client, _ = house.browser()
    result = client.get("/license/details")
    assert result.status_code == 200 and result.json()["valid"] is True
    assert L.get_active_tier() == "pro"


def test_details_validation_failure_cannot_retain_old_privilege_or_expose_error(house):
    house.seed(); client, _ = house.browser()
    house.validate.side_effect = RuntimeError("PRIVATE KEY VALIDATION ERROR")
    result = client.get("/license/details")
    assert result.status_code == 503 and "PRIVATE" not in result.text
    assert result.headers["cache-control"] == "no-store"
    denied(L.get_active_tier)


def test_beta_key_removal_keeps_existing_beta_access(house, monkeypatch):
    house.seed(); monkeypatch.setattr(L, "BETA_MODE", True); client, _ = house.browser()
    removed = client.delete("/license/deactivate")
    assert removed.status_code == 200 and removed.json()["valid"] is False
    status = client.get("/license/status").json()
    assert status["tier"] == "pro" and status["valid"] is True and status["beta"] is True
    assert all(status["features"].values())
    details = client.get("/license/details").json()
    assert details["licensee"] == "Beta" and details["node_id"] == "PRIVATE NODE ID"
    house.validate.assert_not_called()


def test_activation_waiting_for_lock_rechecks_before_reads(house, monkeypatch):
    house.seed(); client, token = house.browser(); read = Mock(wraps=S.load_license)
    monkeypatch.setattr(S, "load_license", read)
    started = Event()
    def request_started(): started.set(); return request(client, PRIVATE[1])
    with ThreadPoolExecutor(max_workers=1) as pool:
        with store.LOCK:
            task = pool.submit(request_started)
            assert started.wait(5)
            S.revoke_session_token(token)
        result = task.result(5)
    assert result.status_code == 401
    read.assert_not_called(); house.validate.assert_not_called()
