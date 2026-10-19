"""Real registry storage and HTTP boundaries; temporary files, no live devices."""
import copy
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

import license
import shelly_store as store
import tli_state as S
from routers import home_power
from routers import shelly_routes as routes


IP = "192.0.2.10"
ROWS = [{"ip": IP, "relay": 1, "id": "original-id", "device_id": "persistent-id",
         "name": "Reading lamp", "aliases": ["desk light"], "custom": {"nested": [1, True, None]}}]
EDIT = {"devices": [{"ip": IP, "relay": 1, "name": "Updated lamp"}]}


@pytest.fixture
def house(monkeypatch, tmp_path):
    path = tmp_path / "data" / "shelly_registry.json"
    path.parent.mkdir()
    monkeypatch.setattr(S, "SHELLY_REGISTRY_PATH", path)
    monkeypatch.setattr(store, "_SEEN", set())
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "pin.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    S.save_pin_config("a" * 64, "b" * 64)
    token = S.create_session_token("registry-owner")
    monkeypatch.setattr(home_power, "get_runtime", lambda: SimpleNamespace(load_devices=lambda: []))
    monkeypatch.setattr(license, "has_feature", lambda *args: True)
    monkeypatch.setattr(license, "get_active_tier", lambda: "pro")
    app = FastAPI(); app.include_router(routes.router)
    client = TestClient(app, base_url="https://testserver", headers={"Origin": "https://testserver",
                        "Cookie": "tli_session=" + token}, raise_server_exceptions=False)
    def seed(rows=ROWS):
        raw = json.dumps(rows, ensure_ascii=False).encode("utf-8")
        path.write_bytes(raw)
        return raw
    def revoke():
        S.revoke_session_token(token)
    yield SimpleNamespace(path=path, seed=seed, client=client, revoke=revoke, app=app, token=token)
    client.close()


def assert_denied(call, status=503):
    with pytest.raises(HTTPException) as caught:
        call()
    assert caught.value.status_code == status
    if status not in (401, 403):
        assert caught.value.headers["Cache-Control"] == "no-store"


def no_staging(house):
    assert list(house.path.parent.glob(".tli-shelly-*.tmp")) == []


def test_missing_registry_is_read_only_empty_and_first_save_works(house):
    assert S.load_shelly_registry() == []
    assert house.client.get("/homeauto/devices").json() == {"devices": []}
    assert not house.path.exists()
    response = house.client.post("/homeauto/devices", json=EDIT)
    assert response.status_code == 200
    assert response.json() == {"ok": True, "count": 1, "devices": EDIT["devices"]}
    assert S.load_shelly_registry() == EDIT["devices"]
    no_staging(house)


@pytest.mark.parametrize("rows", [
    [{"ip": IP}], [{"host": "lamp.local", "relay": None}],
    [{"ip": "HTTP://Lamp.Local/", "aliases": "Desk", "room": None}],
    [{"host": "lamp.local.", "ip": "https://LAMP.local", "relay": 255, "name": ""}],
    [{"ip": "[2001:db8::1]:8080", "relay": 0, "future": {"array": [False, 1.25]}}],
    ROWS,
])
def test_compatible_legacy_rows_read_and_roundtrip_without_normalization(house, rows):
    before = house.seed(rows)
    assert S.load_shelly_registry() == rows
    assert house.path.read_bytes() == before
    S.save_shelly_registry(rows)
    assert S.load_shelly_registry() == rows
    no_staging(house)


def test_merge_preserves_ids_relays_unknown_fields_and_incoming_metadata(house):
    other = {"ip": IP, "relay": 0, "id": "other", "label": "Other", "custom": ["untouched"]}
    house.seed([other, *ROWS])
    edit = copy.deepcopy(EDIT); edit["merge"] = True
    edit["devices"][0].update(room="Office", new_vendor_field={"channel": "one"})
    response = house.client.post("/homeauto/devices", json=edit)
    assert response.status_code == 200, response.text
    rows = S.load_shelly_registry()
    assert rows[0] == other
    assert rows[1] == {**ROWS[0], **edit["devices"][0]}
    assert response.json() == {"ok": True, "count": 2, "devices": rows}


def test_host_only_record_and_equivalent_address_keep_identity(house):
    old = {"host": "LAMP.local.", "relay": 1, "id": "legacy", "custom": {"keep": True}}
    house.seed([old])
    response = house.client.post("/homeauto/devices", json={"devices": [{"ip": "http://lamp.local/", "name": "Renamed"}]})
    assert response.status_code == 200, response.text
    assert S.load_shelly_registry() == [{**old, "ip": "http://lamp.local/", "name": "Renamed"}]


def test_explicit_http_default_port_keeps_existing_identity_and_metadata(house):
    house.seed()
    response = house.client.post("/homeauto/devices", json={"merge": True,
        "devices": [{"ip": IP + ":80", "relay": 1, "name": "Updated"}]})
    assert response.status_code == 200, response.text
    assert S.load_shelly_registry() == [{**ROWS[0], "ip": IP + ":80", "name": "Updated"}]
    assert response.json()["count"] == 1


def test_nondefault_ports_remain_distinct_targets(house):
    rows = [*ROWS, {"ip": IP + ":8080", "relay": 1, "id": "nondefault"}]
    house.seed(rows)
    assert S.load_shelly_registry() == rows


@pytest.mark.parametrize("field", ["id", "device_id"])
def test_existing_identity_cannot_be_replaced(house, field):
    before = house.seed()
    edit = copy.deepcopy(EDIT); edit["devices"][0][field] = "replacement"
    assert house.client.post("/homeauto/devices", json=edit).status_code == 409
    assert house.path.read_bytes() == before
    no_staging(house)


BAD_DOCUMENTS = [b"", b"[", b"null", b"{}", b"[false]", b"[{}]", b"\xff",
    b'[{"ip":"192.0.2.10","ip":"192.0.2.11"}]',
    b'[{"ip":"192.0.2.10","custom":{"a":1,"a":2}}]',
    b'[{"ip":"192.0.2.10","custom":NaN}]', b'[{"ip":"192.0.2.10","custom":Infinity}]',
    b'[{"ip":"192.0.2.10","custom":1e999}]',
    b'[{"ip":"192.0.2.10","name":"\\ud800"}]', b" " * (store.MAX_BYTES + 1)]


@pytest.mark.parametrize("raw", BAD_DOCUMENTS, ids=["empty", "truncated", "null", "object", "bad-row", "no-address", "bad-utf8",
    "duplicate-key", "nested-duplicate", "nan", "infinity", "overflow", "unicode", "oversized"])
def test_damaged_documents_are_never_empty_or_overwritten(house, raw):
    house.path.write_bytes(raw)
    assert_denied(S.load_shelly_registry)
    assert_denied(lambda: S.save_shelly_registry([]))
    for response in (house.client.get("/homeauto/devices"), house.client.post("/homeauto/devices", json=EDIT)):
        assert response.status_code == 503
        assert response.headers["cache-control"] == "no-store"
        assert "devices" not in response.json()
    assert house.path.read_bytes() == raw
    no_staging(house)


BAD_ROWS = [
    [{"ip": ""}], [{"ip": 17}], [{"ip": "user@lamp.local"}], [{"ip": "file:///tmp/a"}],
    [{"ip": "lamp.local/relay/0"}], [{"ip": "lamp.local?turn=on"}], [{"ip": "lamp.local#x"}],
    [{"ip": "lamp.local:99999"}], [{"ip": "lamp local"}], [{"ip": "lamp\\relay"}],
    [{"ip": IP, "host": "192.0.2.11"}], [{"ip": IP, "relay": True}],
    [{"ip": IP, "relay": "1"}], [{"ip": IP, "relay": -1}], [{"ip": IP, "relay": 256}],
    [{"ip": IP, "aliases": [None]}], [{"ip": IP, "name": 2}], [{"ip": IP, "id": ""}],
    [{"ip": IP}, {"ip": "http://192.0.2.10/", "relay": 0}],
    [{"ip": IP}, {"ip": "http://192.0.2.10:80/", "relay": 0}],
    [{"ip": IP, "id": "same"}, {"ip": "192.0.2.11", "device_id": "SAME"}],
    [{"ip": f"lamp-{i}.local"} for i in range(store.MAX_ROWS + 1)],
]


@pytest.mark.parametrize("rows", BAD_ROWS)
def test_invalid_saved_shapes_are_preserved_and_invalid_new_rows_do_not_replace(house, rows):
    raw = house.seed(rows)
    assert_denied(S.load_shelly_registry)
    assert house.path.read_bytes() == raw
    before = house.seed()
    assert_denied(lambda: S.save_shelly_registry(rows), 422)
    assert house.path.read_bytes() == before
    no_staging(house)


@pytest.mark.parametrize("extra", [{"bad": object()}, {"bad": float("inf")}, {"bad": {1: "a", "1": "b"}}, {"bad": (1, 2)}])
def test_non_json_metadata_cannot_be_silently_changed_on_write(house, extra):
    before = house.seed()
    assert_denied(lambda: S.save_shelly_registry([{**ROWS[0], **extra}]), 422)
    assert house.path.read_bytes() == before


@pytest.mark.parametrize("payload", [{"devices": None}, {"devices": [False]}, {"devices": [{"ip": 1}]},
    {"devices": [{"ip": "http://user@lamp.local"}]}, {"devices": [{"ip": IP, "relay": True}]},
    {"devices": [{"ip": IP, "relay": 1}, {"ip": "http://192.0.2.10/", "relay": 1}]}])
def test_invalid_http_edits_preserve_original_bytes(house, payload):
    before = house.seed()
    response = house.client.post("/homeauto/devices", json=payload)
    assert response.status_code in (409, 422), response.text
    assert house.path.read_bytes() == before
    no_staging(house)


def test_observed_file_disappearance_is_unavailable_not_new_empty_state(house):
    house.seed(); assert S.load_shelly_registry() == ROWS
    house.path.unlink()
    assert_denied(S.load_shelly_registry)
    assert_denied(lambda: S.save_shelly_registry([]))
    assert not house.path.exists()


@pytest.mark.parametrize("kind", ["directory", "hardlink", "symlink", "broken-symlink", "parent-symlink", "case-alias"])
def test_linked_or_ambiguous_artifacts_are_never_followed_or_replaced(house, tmp_path, monkeypatch, kind):
    outside = tmp_path / "outside.json"; outside.write_text(json.dumps(ROWS), encoding="utf-8")
    before = outside.read_bytes()
    if kind == "directory": house.path.mkdir()
    elif kind == "hardlink": os.link(outside, house.path)
    elif kind in {"symlink", "broken-symlink", "parent-symlink"}:
        try:
            if kind == "parent-symlink":
                parent = tmp_path / "linked"; parent.symlink_to(house.path.parent, target_is_directory=True)
                house.path = parent / house.path.name
                monkeypatch.setattr(S, "SHELLY_REGISTRY_PATH", house.path)
            else: house.path.symlink_to(outside if kind == "symlink" else tmp_path / "missing")
        except OSError as exc:
            pytest.skip("Creating synthetic symlinks requires OS support: " + str(exc))
    else: house.path.with_name(house.path.name.upper()).write_bytes(before)
    assert_denied(S.load_shelly_registry)
    assert_denied(lambda: S.save_shelly_registry([]))
    assert outside.read_bytes() == before
    no_staging(house)


def test_reparse_attribute_on_parent_is_rejected(house, monkeypatch):
    house.seed(); original = Path.lstat
    def lstat(path, *args, **kwargs):
        info = original(path, *args, **kwargs)
        if path == house.path.parent:
            values = {name: getattr(info, name) for name in dir(info) if name.startswith("st_")}
            values["st_file_attributes"] = values.get("st_file_attributes", 0) | 0x400
            return SimpleNamespace(**values)
        return info
    monkeypatch.setattr(Path, "lstat", lstat)
    assert_denied(S.load_shelly_registry)
    assert_denied(lambda: S.save_shelly_registry([]))


def test_unreadable_file_is_preserved(house, monkeypatch):
    before = house.seed(); original = os.open
    def blocked(path, *args, **kwargs):
        if Path(path) == house.path: raise PermissionError("synthetic read denial")
        return original(path, *args, **kwargs)
    monkeypatch.setattr(store.os, "open", blocked)
    assert_denied(S.load_shelly_registry)
    assert_denied(lambda: S.save_shelly_registry([]))
    assert house.path.read_bytes() == before


def test_expected_snapshot_conflict_never_overwrites_another_editor(house):
    house.seed(); snapshot = S.load_shelly_registry()
    other = [{**ROWS[0], "name": "External edit"}]; before = house.seed(other)
    assert_denied(lambda: S.save_shelly_registry([], expected=snapshot), 409)
    assert house.path.read_bytes() == before
    no_staging(house)


@pytest.mark.parametrize("phase", ["fsync", "replace-before", "replace-after"])
def test_uncertain_save_is_not_successful_and_never_retried(house, monkeypatch, phase):
    before = house.seed(); calls = []
    original = os.replace
    def replace(source, destination):
        calls.append((source, destination))
        if phase == "replace-after": original(source, destination)
        raise OSError("synthetic replacement interruption")
    if phase == "fsync":
        monkeypatch.setattr(store.os, "fsync", lambda _: (_ for _ in ()).throw(OSError("synthetic sync failure")))
    else: monkeypatch.setattr(store.os, "replace", replace)
    response = house.client.post("/homeauto/devices", json=EDIT)
    assert response.status_code == 503, response.text
    assert "ok" not in response.json()
    assert len(calls) == (0 if phase == "fsync" else 1)
    if phase == "replace-after": assert S.load_shelly_registry() == [{**ROWS[0], **EDIT["devices"][0]}]
    else: assert house.path.read_bytes() == before
    no_staging(house)


@pytest.mark.parametrize("change,status", [("valid", 409), ("damaged", 503), ("deleted", 503)])
def test_original_is_revalidated_after_fsync_before_replacement(house, monkeypatch, change, status):
    house.seed(); original = os.fsync; changed = b"[{"
    if change == "valid": changed = json.dumps([{**ROWS[0], "name": "External edit"}]).encode()
    def fsync(fd):
        original(fd)
        if change == "deleted": house.path.unlink()
        else: house.path.write_bytes(changed)
    monkeypatch.setattr(store.os, "fsync", fsync)
    response = house.client.post("/homeauto/devices", json=EDIT)
    assert response.status_code == status, response.text
    if change == "deleted": assert not house.path.exists()
    else: assert house.path.read_bytes() == changed
    no_staging(house)


@pytest.mark.parametrize("kind", ["same-size-corruption", "different-valid-data", "truncated"])
def test_staged_bytes_are_verified_even_when_inode_is_unchanged(house, monkeypatch, kind):
    before = house.seed(); original = os.fsync
    def fsync(fd):
        original(fd)
        size = os.fstat(fd).st_size
        changed = b"x" * size if kind == "same-size-corruption" else b"[]" if kind == "different-valid-data" else b""
        os.lseek(fd, 0, os.SEEK_SET); os.write(fd, changed); os.ftruncate(fd, len(changed))
    monkeypatch.setattr(store.os, "fsync", fsync)
    response = house.client.post("/homeauto/devices", json=EDIT)
    assert response.status_code == 503, response.text
    assert house.path.read_bytes() == before
    no_staging(house)


@pytest.mark.parametrize("replacement", [False, True])
def test_staging_changed_during_original_revalidation_is_not_committed(house, monkeypatch, replacement):
    before = house.seed(); original = store._snapshot; altered = []
    def snapshot(path, check=None):
        value = original(path, check)
        staged = list(house.path.parent.glob(".tli-shelly-*.tmp"))
        if staged and not altered:
            altered.append(staged[0])
            if replacement:
                other = house.path.parent / "foreign.tmp"; other.write_bytes(b"[]")
                os.replace(other, staged[0])
            else: staged[0].write_bytes(b"[]")
        return value
    monkeypatch.setattr(store, "_snapshot", snapshot)
    response = house.client.post("/homeauto/devices", json=EDIT)
    assert response.status_code == 503, response.text
    assert house.path.read_bytes() == before and len(altered) == 1
    if replacement:
        assert altered[0].read_bytes() == b"[]"  # Do not delete another writer's replacement.
    else: no_staging(house)


@pytest.mark.parametrize("phase", ["read", "validate", "fsync", "replace", "replace-error"])
def test_real_browser_revocation_stops_commit_or_withholds_completed_result(house, monkeypatch, phase):
    before = house.seed()
    if phase == "read":
        original = S.load_shelly_registry
        def read():
            value = original(); house.revoke(); return value
        monkeypatch.setattr(S, "load_shelly_registry", read)
    elif phase == "validate":
        original = store.validate
        def validate(rows, **kwargs):
            value = original(rows, **kwargs)
            if kwargs.get("status") == 422: house.revoke()
            return value
        monkeypatch.setattr(store, "validate", validate)
    elif phase == "fsync":
        original = os.fsync
        def fsync(fd): original(fd); house.revoke()
        monkeypatch.setattr(store.os, "fsync", fsync)
    else:
        original = os.replace
        def replace(source, destination):
            original(source, destination); house.revoke()
            if phase == "replace-error": raise OSError("completed, response lost")
        monkeypatch.setattr(store.os, "replace", replace)
    response = house.client.post("/homeauto/devices", json=EDIT)
    assert response.status_code == 401, response.text
    assert "Updated lamp" not in response.text and "devices" not in response.json()
    if phase.startswith("replace"):
        assert json.loads(house.path.read_bytes()) == [{**ROWS[0], **EDIT["devices"][0]}]
    else: assert house.path.read_bytes() == before
    no_staging(house)


def test_revocation_wins_over_saved_data_decode_error(house, monkeypatch):
    house.seed(); original = store._decode
    def decode(raw):
        house.revoke()
        raise store.unavailable()
    monkeypatch.setattr(store, "_decode", decode)
    response = house.client.get("/homeauto/devices")
    assert response.status_code == 401
    assert "saved" not in response.text.lower()
    monkeypatch.setattr(store, "_decode", original)
    assert S.load_shelly_registry() == ROWS


def test_revocation_during_implicit_relay_lookup_wins_over_saved_data_error(house, monkeypatch):
    before = house.seed()
    def load():
        house.revoke()
        raise HTTPException(503, "PRIVATE INVENTORY ERROR")
    monkeypatch.setattr(home_power, "get_runtime", lambda: SimpleNamespace(load_devices=load))
    response = house.client.post("/homeauto/devices", json={"devices": [{"ip": "192.0.2.11", "name": "New lamp"}]})
    assert response.status_code == 401, response.text
    assert "PRIVATE INVENTORY" not in response.text
    assert house.path.read_bytes() == before
    no_staging(house)


def test_two_concurrent_merges_are_serialized_without_losing_either_edit(house, monkeypatch):
    house.seed(); entered, release = Event(), Event(); original = os.fsync
    count = 0
    def fsync(fd):
        nonlocal count
        original(fd); count += 1
        if count == 1:
            entered.set()
            assert release.wait(5), "test failed to release the first staged save"
    monkeypatch.setattr(store.os, "fsync", fsync)
    other = TestClient(house.app, base_url="https://testserver", headers={"Origin": "https://testserver",
                       "Cookie": "tli_session=" + house.token}, raise_server_exceptions=False)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(house.client.post, "/homeauto/devices", json={"merge": True, "devices": [{"ip": "192.0.2.11", "relay": 0}]})
        try:
            assert entered.wait(5)
            second = pool.submit(other.post, "/homeauto/devices", json={"merge": True, "devices": [{"ip": "192.0.2.12", "relay": 0}]})
        finally: release.set()
        assert first.result(5).status_code == 200
        assert second.result(5).status_code == 200
    other.close()
    rows = S.load_shelly_registry()
    assert len(rows) == 3 and rows[0] == ROWS[0]
    assert {row["ip"] for row in rows} == {IP, "192.0.2.11", "192.0.2.12"}
    assert count == 2
    no_staging(house)


@pytest.fixture
def action_house(house, monkeypatch):
    from routers import actions_engine as actions
    driver = SimpleNamespace(turn_on=Mock(return_value={"ok": True}), turn_off=Mock(return_value={"ok": True}))
    monkeypatch.setattr(actions, "_CTX", {**actions._CTX, "data_dir": house.path.parent,
        "shelly_registry_path": house.path, "shelly_driver": driver, "home_power_runtime": None})
    monkeypatch.setattr(actions, "_INFLIGHT", set())
    monkeypatch.setattr("intelligence.devices.with_context", lambda rows: rows)
    house.app.include_router(actions.router)
    house.seed()
    draft = {"name": "Reading", "steps": [{"type": "shelly.switch", "device": "original-id", "value": "on"}]}
    saved = house.client.post("/actions/approve", json=draft)
    assert saved.status_code == 200, saved.text
    ident = saved.json()["action"]["id"]
    reviewed = house.client.get(f"/actions/{ident}/review")
    assert reviewed.status_code == 200 and reviewed.json()["available"] is True
    return house, actions, driver, draft, ident, reviewed.json()


@pytest.mark.parametrize("raw", [b"[", b"{}", json.dumps([*ROWS, False]).encode(),
    json.dumps([*ROWS, {"ip": "192.0.2.11", "relay": "invalid"}]).encode()])
def test_damaged_registry_blocks_real_action_preparation_and_old_review_dispatch(action_house, raw):
    house, actions, driver, draft, ident, reviewed = action_house
    action_path, receipts_path = actions._paths()
    old_actions, old_receipts = action_path.read_bytes(), receipts_path.read_bytes()
    house.path.write_bytes(raw)
    assert_denied(actions._read_shelly_registry)
    capabilities = house.client.get("/actions/capabilities")
    assert capabilities.status_code == 503
    for response in (house.client.post("/actions/preview", json=draft), house.client.get(f"/actions/{ident}/review")):
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["available"] is False and body["actions_performed"] is False
        assert body["steps"][0]["target"] is None
        assert "Saved Shelly registry data is unavailable" in body["errors"]["0"]
    result = house.client.post(f"/actions/run/{ident}", json={"request_id": "previous-review",
        "expected_revision": reviewed["revision"], "expected_targets": reviewed["target_revision"]})
    assert result.status_code == 409, result.text
    driver.turn_on.assert_not_called(); driver.turn_off.assert_not_called()
    assert house.path.read_bytes() == raw
    assert action_path.read_bytes() == old_actions and receipts_path.read_bytes() == old_receipts
    assert not actions._INFLIGHT


def test_action_registry_no_configuration_and_fresh_missing_path_stay_read_only_empty(house, monkeypatch):
    from routers import actions_engine as actions
    monkeypatch.setattr(actions, "_CTX", {**actions._CTX, "shelly_registry_path": None})
    assert actions._read_shelly_registry() == []
    monkeypatch.setitem(actions._CTX, "shelly_registry_path", house.path)
    assert actions._read_shelly_registry() == []
    assert not house.path.exists()


def test_action_registry_read_error_after_revocation_returns_original_denial(action_house, monkeypatch):
    house, actions, driver, draft, ident, reviewed = action_house
    before = house.path.read_bytes()
    def revoked_read(path, **kwargs):
        house.revoke()
        raise store.unavailable()
    monkeypatch.setattr(store, "read", revoked_read)
    result = house.client.get(f"/actions/{ident}/review")
    assert result.status_code == 401, result.text
    assert "Saved Shelly" not in result.text
    driver.turn_on.assert_not_called(); driver.turn_off.assert_not_called()
    assert house.path.read_bytes() == before
