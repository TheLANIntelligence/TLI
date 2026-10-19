"""Approvals persist; reservations and revocations cannot become fresh work."""
import copy
import json
from concurrent.futures import ThreadPoolExecutor

from fastapi import HTTPException
import pytest

import pihole_access_store as store
import pihole_receipts as receipts
import tli_state as S


@pytest.fixture
def saved(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", tmp_path)
    monkeypatch.setattr(store, "_SEEN", {})
    monkeypatch.setattr(store, "_UNCERTAIN", set())
    monkeypatch.setattr(receipts, "_SEEN", {})
    monkeypatch.setattr(receipts, "_UNCERTAIN", set())
    return tmp_path


def grant():
    return {"id": "a" * 32, "owner": "owner", "token_hash": "b" * 64, "pin_stamp": "c" * 64,
            "origin": "https://192.168.1.2:443", "tls_mode": "system_trust", "pin": "",
            "client": {"id": 4, "client": "192.168.1.40", "comment": None, "groups": [0],
                       "date_added": 1, "date_modified": 2, "editable": True},
            "groups": [{"id": 0, "name": "Default", "enabled": True, "description": None,
                        "date_added": 1, "date_modified": 2}],
            "name": "Phone", "created_at": "2026-10-16T01:00:00Z"}


def record():
    row = grant()
    return {"origin": row["origin"], "tls_mode": row["tls_mode"], "pin": row["pin"], "client": row["client"]["client"],
            "before": {"clientrecord": row["client"], "groups": row["groups"]}, "after_groups": [], "action": "pause"}


def outcome():
    return {"outcome": "confirmed", "attempted": True, "acknowledged": True, "membership_verified": True,
            "summary": "Pi-hole saved this client's filtering groups.", "checked_at": "2026-10-16T01:01:00Z"}


def snapshot(root):
    return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}


def reset(monkeypatch):
    for module in (store, receipts):
        monkeypatch.setattr(module, "_SEEN", {})
        monkeypatch.setattr(module, "_UNCERTAIN", set())


def test_absence_is_read_only_and_owner_lists_are_isolated(saved):
    assert store.list_grants("owner", lambda: None) == []
    assert store.find_token("b" * 64, lambda: None) is None
    assert list(saved.iterdir()) == []
    row = store.create(grant(), lambda: None)
    assert row["revoked"] is False and row["revoked_at"] is None
    assert store.list_grants("another", lambda: None) == []
    assert store.find_token(grant()["token_hash"], lambda: None) == row
    row["client"]["groups"].append(9)
    assert store.get(grant()["id"], lambda: None)["client"]["groups"] == [0]


def test_grant_and_revoke_survive_restart_without_secrets(saved, monkeypatch):
    created = store.create(grant(), lambda: None)
    before = snapshot(saved)
    reset(monkeypatch)
    assert store.get(created["id"], lambda: None) == created
    revoked = store.revoke("owner", created["id"], lambda: None)
    assert revoked["revoked"] and revoked["revoked_at"]
    assert all(snapshot(saved)[path] == value for path, value in before.items())
    reset(monkeypatch)
    assert store.get(created["id"], lambda: None) == revoked
    assert store.revoke("owner", created["id"], lambda: None) == revoked
    assert not any(word in b"".join(snapshot(saved).values()) for word in (b'"password"', b'"sid"', b'"cookie"', b'"token"', b'"queries"'))
    with pytest.raises(HTTPException) as error:
        store.reserve_command(created["id"], "d" * 32, record(), lambda: None)
    assert error.value.status_code == 403


def test_other_owner_cannot_revoke(saved):
    store.create(grant(), lambda: None)
    before = snapshot(saved)
    with pytest.raises(HTTPException) as error:
        store.revoke("another", grant()["id"], lambda: None)
    assert error.value.status_code == 404 and snapshot(saved) == before


def test_expanded_uppercase_ipv6_selector_retains_wire_identity(saved):
    data = grant()
    selector = "FD00:0000:0000:0000:0000:0000:0000:0040"
    data["client"]["client"] = selector
    saved_grant = store.create(data, lambda: None)
    assert saved_grant["client"]["client"] == selector
    operation = record()
    operation["client"] = selector
    operation["before"]["clientrecord"]["client"] = selector
    receipt = store.reserve_command(data["id"], "d" * 32, operation, lambda: None)["receipt"]
    assert receipt["client"] == selector and receipt["before"]["clientrecord"]["client"] == selector


@pytest.mark.parametrize("change", ["password", "sid", "raw_token", "extra-client", "extra-group", "bad-id", "token-hash", "pin-stamp", "public-ip", "cidr", "empty-groups", "foreign-group", "name-control", "surrogate", "nan"])
def test_grant_strict_shape_cannot_persist_secrets_or_bad_mapping(saved, change):
    data = grant()
    if change in {"password", "sid", "raw_token"}: data[change] = "NEVER-SAVE"
    if change == "extra-client": data["client"]["password"] = "NEVER-SAVE"
    if change == "extra-group": data["groups"][0]["sid"] = "NEVER-SAVE"
    if change == "bad-id": data["id"] = "../escape"
    if change == "token-hash": data["token_hash"] = "wrong"
    if change == "pin-stamp": data["pin_stamp"] = "wrong"
    if change == "public-ip": data["client"]["client"] = "8.8.8.8"
    if change == "cidr": data["client"]["client"] = "192.168.1.0/24"
    if change == "empty-groups": data["client"]["groups"] = []
    if change == "foreign-group": data["client"]["groups"] = [9]
    if change == "name-control": data["name"] = "phone\nnew"
    if change == "surrogate": data["name"] = "\ud800"
    if change == "nan": data["client"]["date_added"] = float("nan")
    with pytest.raises(HTTPException): store.create(data, lambda: None)
    assert list(saved.iterdir()) == []


def test_duplicate_grant_or_token_cannot_replace_approval(saved):
    store.create(grant(), lambda: None)
    before = snapshot(saved)
    data = grant(); data["name"] = "Replaced"
    with pytest.raises(HTTPException): store.create(data, lambda: None)
    data["id"] = "d" * 32
    with pytest.raises(HTTPException): store.create(data, lambda: None)
    assert snapshot(saved) == before


def test_finished_command_is_retrieved_after_restart_never_reserved_twice(saved, monkeypatch):
    row = store.create(grant(), lambda: None)
    ident = "d" * 32
    assert store.command(row["id"], ident, lambda: None) is None
    reserved = store.reserve_command(row["id"], ident, record(), lambda: None)
    assert reserved["receipt_id"] and reserved["receipt"]["outcome"]["outcome"] == "prepared"
    assert reserved["uncertain"] is False
    before = snapshot(saved)
    final = store.finish_command(row["id"], ident, outcome())
    assert final["receipt"]["outcome"] == outcome()
    assert all(snapshot(saved)[path] == value for path, value in before.items())
    reset(monkeypatch)
    assert store.command(row["id"], ident, lambda: None) == final
    before = snapshot(saved)
    with pytest.raises(HTTPException) as error: store.reserve_command(row["id"], ident, record(), lambda: None)
    assert error.value.status_code == 409 and snapshot(saved) == before
    assert store.finish_command(row["id"], ident, outcome()) == final


@pytest.mark.parametrize("stage", ["before_receipt", "after_receipt"])
def test_crash_before_receipt_link_blocks_repeat_even_after_restart(saved, monkeypatch, stage):
    row = store.create(grant(), lambda: None)
    original = receipts.reserve
    def fail(*args):
        if stage == "after_receipt": original(*args)
        raise OSError("simulated crash")
    monkeypatch.setattr(receipts, "reserve", fail)
    with pytest.raises(HTTPException): store.reserve_command(row["id"], "d" * 32, record(), lambda: None)
    reset(monkeypatch)
    saved_command = store.command(row["id"], "d" * 32, lambda: None)
    assert saved_command["uncertain"] is True and saved_command["receipt_id"] is None
    assert len(receipts.list_receipts("owner", lambda: None)) == (1 if stage == "after_receipt" else 0)
    before = snapshot(saved)
    for ident in ("d" * 32, "e" * 32):
        with pytest.raises(HTTPException) as error: store.reserve_command(row["id"], ident, record(), lambda: None)
        assert error.value.status_code == 409
    assert snapshot(saved) == before


def test_restore_is_bound_to_baseline_and_history_order(saved):
    row = store.create(grant(), lambda: None)
    store.reserve_command(row["id"], "d" * 32, record(), lambda: None)
    store.finish_command(row["id"], "d" * 32, outcome())
    restore = record(); restore["action"] = "restore"; restore["after_groups"] = [0]
    restore["before"]["clientrecord"]["groups"] = []
    store.reserve_command(row["id"], "e" * 32, restore, lambda: None)
    assert [item["operation_id"] for item in store.list_commands(row["id"], lambda: None)] == ["d" * 32, "e" * 32]
    invalid = copy.deepcopy(restore); invalid["after_groups"] = []
    before = snapshot(saved)
    with pytest.raises(HTTPException): store.reserve_command(row["id"], "f" * 32, invalid, lambda: None)
    assert snapshot(saved) == before


@pytest.mark.parametrize("change", ["origin", "client", "identity", "action", "password", "after"])
def test_command_reservation_cannot_target_another_device_or_arbitrary_action(saved, change):
    store.create(grant(), lambda: None)
    data = record()
    if change == "origin": data["origin"] = "https://192.168.1.3:443"
    if change == "client": data["client"] = "192.168.1.41"
    if change == "identity": data["before"]["clientrecord"]["id"] = 99
    if change == "action": data["action"] = "groups"
    if change == "password": data["password"] = "NEVER-SAVE"
    if change == "after": data["after_groups"] = [0]
    before = snapshot(saved)
    with pytest.raises(HTTPException): store.reserve_command(grant()["id"], "d" * 32, data, lambda: None)
    assert snapshot(saved) == before


def test_revocation_after_effect_still_allows_private_outcome_retention(saved):
    store.create(grant(), lambda: None)
    store.reserve_command(grant()["id"], "d" * 32, record(), lambda: None)
    store.revoke("owner", grant()["id"], lambda: None)
    final = store.finish_command(grant()["id"], "d" * 32, outcome())
    assert final["receipt"]["outcome"] == outcome()
    def denied(): raise HTTPException(403, "revoked")
    with pytest.raises(HTTPException) as error: store.command(grant()["id"], "d" * 32, denied)
    assert error.value.status_code == 403


def test_parallel_repeated_operations_have_one_durable_reservation(saved):
    store.create(grant(), lambda: None)
    def reserve():
        try: return store.reserve_command(grant()["id"], "d" * 32, record(), lambda: None)["receipt_id"]
        except HTTPException as error: return error.status_code
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: reserve(), range(4)))
    assert len([result for result in results if isinstance(result, str)]) == 1
    assert results.count(409) == 3 and len(receipts.list_receipts("owner", lambda: None)) == 1


@pytest.mark.parametrize("damage", ["malformed", "duplicate", "deleted", "changed", "orphan", "unknown", "hardlink"])
def test_grant_evidence_damage_is_preserved_and_blocks_access(saved, damage):
    store.create(grant(), lambda: None)
    path = next(saved.rglob(grant()["id"] + ".json"))
    if damage == "malformed": path.write_bytes(b'{')
    if damage == "duplicate": path.write_bytes(b'{"version":1,"version":1}')
    if damage == "deleted": path.unlink()
    if damage == "changed": path.write_bytes(path.read_bytes().replace(b'Phone', b'Other'))
    if damage == "orphan": (path.parent / ("d" * 32 + ".revoked.json")).write_text('{}')
    if damage == "unknown": (path.parent / "unrecognized.json").write_text('{}')
    if damage == "hardlink": (saved / "alias.json").hardlink_to(path)
    before = snapshot(saved)
    for operation in (lambda: store.get(grant()["id"], lambda: None), lambda: store.revoke("owner", grant()["id"], lambda: None)):
        with pytest.raises(HTTPException) as error: operation()
        assert error.value.status_code == 503
    assert snapshot(saved) == before


def test_missing_linked_receipt_is_unavailable_not_missing_command(saved, monkeypatch):
    store.create(grant(), lambda: None)
    reserved = store.reserve_command(grant()["id"], "d" * 32, record(), lambda: None)
    next(saved.rglob(reserved["receipt_id"] + ".json")).unlink()
    reset(monkeypatch)
    with pytest.raises(HTTPException) as error: store.command(grant()["id"], "d" * 32, lambda: None)
    assert error.value.status_code == 503


def test_fsync_failure_preserves_partial_evidence_and_latches(saved, monkeypatch):
    def fail(_): raise OSError("private disk error")
    monkeypatch.setattr(store.os, "fsync", fail)
    with pytest.raises(HTTPException) as error: store.create(grant(), lambda: None)
    assert "private disk error" not in error.value.detail
    paths = list(saved.rglob("*.json"))
    assert len(paths) == 1 and paths[0].read_bytes()
    paths[0].unlink()
    with pytest.raises(HTTPException): store.create(grant(), lambda: None)


def test_check_after_publish_denies_disclosure_and_preserves_approval(saved, monkeypatch):
    original = store._publish
    revoked = False
    def publish(*args):
        nonlocal revoked
        original(*args)
        revoked = True
    monkeypatch.setattr(store, "_publish", publish)
    def check():
        if revoked: raise HTTPException(401, "revoked")
    with pytest.raises(HTTPException) as error: store.create(grant(), check)
    assert error.value.status_code == 401
    assert store.get(grant()["id"], lambda: None)["revoked"] is False


def test_denied_operations_do_not_touch_disk(saved):
    def denied(): raise HTTPException(403, "denied")
    for operation in (lambda: store.create(grant(), denied), lambda: store.list_grants("owner", denied)):
        with pytest.raises(HTTPException): operation()
    assert list(saved.iterdir()) == []


@pytest.mark.parametrize("status", [401, 403, 409, 503])
def test_protection_failure_during_read_does_not_latch_unchanged_disk(saved, status):
    store.create(grant(), lambda: None)
    count = 0
    def check():
        nonlocal count
        count += 1
        if count >= 8:
            raise HTTPException(status, "access stopped")
    before = snapshot(saved)
    with pytest.raises(HTTPException): store.list_grants("owner", check)
    assert snapshot(saved) == before
    assert store.get(grant()["id"], lambda: None)["revoked"] is False


def test_caps_do_not_remove_previous_recovery(saved, monkeypatch):
    store.create(grant(), lambda: None)
    monkeypatch.setattr(store, "MAX_GRANTS", 1)
    other = grant(); other["id"] = "d" * 32; other["token_hash"] = "e" * 64
    with pytest.raises(HTTPException) as error: store.create(other, lambda: None)
    assert error.value.status_code == 409
    store.reserve_command(grant()["id"], "d" * 32, record(), lambda: None)
    monkeypatch.setattr(store, "MAX_COMMANDS", 1)
    before = snapshot(saved)
    with pytest.raises(HTTPException) as error: store.reserve_command(grant()["id"], "e" * 32, record(), lambda: None)
    assert error.value.status_code == 409 and snapshot(saved) == before
