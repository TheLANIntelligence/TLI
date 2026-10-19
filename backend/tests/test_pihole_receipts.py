"""Recovery survives restart; ambiguous disk writes never authorize replay."""
import copy
import json
from pathlib import Path
from unittest.mock import Mock

from fastapi import HTTPException
import pytest

import pihole_receipts as store
import tli_state as S


@pytest.fixture
def saved(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", tmp_path)
    monkeypatch.setattr(store, "_SEEN", {})
    monkeypatch.setattr(store, "_UNCERTAIN", set())
    return tmp_path


def record():
    return {"origin": "https://192.168.1.2:443", "tls_mode": "system_trust", "pin": "", "client": "192.168.1.40",
        "before": {"clientrecord": {"id": 4, "client": "192.168.1.40", "comment": None, "groups": [0],
            "date_added": 1, "date_modified": 2, "editable": True},
            "groups": [{"id": 0, "name": "Default", "enabled": True, "description": None, "date_added": 1, "date_modified": 2}]},
        "after_groups": [], "action": "pause"}


def outcome():
    return {"outcome": "confirmed", "attempted": True, "acknowledged": True, "membership_verified": True,
            "summary": "Pi-hole saved the selected client groups.", "checked_at": "2026-10-16T01:00:00Z"}


def snapshot(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}


def test_absence_is_read_only_and_owner_isolation(saved):
    before = list(saved.iterdir())
    assert store.list_receipts("owner", lambda: None) == []
    assert list(saved.iterdir()) == before
    receipt = store.reserve("owner", record(), lambda: None)
    assert receipt["outcome"]["outcome"] == "prepared"
    assert store.list_receipts("other", lambda: None) == []
    with pytest.raises(HTTPException) as error:
        store.get("other", receipt["id"], lambda: None)
    assert error.value.status_code == 404


def test_recovery_retains_original_and_survives_restart_without_credentials(saved, monkeypatch):
    original = record()
    receipt = store.reserve("owner", original, lambda: None)
    before = snapshot(saved)
    final = store.finish("owner", receipt["id"], outcome())
    assert final["before"] == original["before"] and final["outcome"] == outcome()
    assert all(snapshot(saved)[p] == value for p, value in before.items())
    monkeypatch.setattr(store, "_SEEN", {})
    monkeypatch.setattr(store, "_UNCERTAIN", set())
    assert store.get("owner", receipt["id"], lambda: None) == final
    assert store.finish("owner", receipt["id"], outcome()) == final
    altered = outcome(); altered["summary"] = "changed"
    with pytest.raises(HTTPException):
        store.finish("owner", receipt["id"], altered)
    assert store.get("owner", receipt["id"], lambda: None) == final
    final["before"]["clientrecord"]["groups"].append(7)
    assert store.get("owner", receipt["id"], lambda: None)["before"] == original["before"]
    assert not any(word in b"".join(snapshot(saved).values()) for word in (b'"password"', b'"sid"', b'"queries"'))


@pytest.mark.parametrize("damage", ["malformed", "duplicate", "deleted", "changed", "orphan", "unknown"])
def test_damaged_evidence_preserved_blocks_new_mutations(saved, damage):
    receipt = store.reserve("owner", record(), lambda: None)
    file = next(saved.rglob(receipt["id"] + ".json"))
    if damage == "malformed": file.write_bytes(b'{')
    if damage == "duplicate": file.write_bytes(b'{"version":1,"version":1}')
    if damage == "deleted": file.unlink()
    if damage == "changed": file.write_bytes(file.read_bytes().replace(b'Default', b'Updated'))
    if damage == "orphan": (file.parent / ("f" * 32 + ".outcome.json")).write_text(json.dumps(outcome()))
    if damage == "unknown": (file.parent / "unrecognized.json").write_text('{}')
    before = snapshot(saved)
    for operation in (lambda: store.list_receipts("owner", lambda: None), lambda: store.reserve("owner", record(), lambda: None)):
        with pytest.raises(HTTPException) as error: operation()
        assert error.value.status_code == 503
    assert snapshot(saved) == before


def test_partial_write_retained_and_latched_even_if_external_file_removed(saved, monkeypatch):
    def fail(_): raise OSError("private device failure")
    monkeypatch.setattr(store.os, "fsync", fail)
    with pytest.raises(HTTPException) as error:
        store.reserve("owner", record(), lambda: None)
    assert "private device failure" not in error.value.detail
    files = list(saved.rglob("*.json"))
    assert len(files) == 1 and files[0].read_bytes()
    files[0].unlink()
    with pytest.raises(HTTPException): store.reserve("owner", record(), lambda: None)
    assert list(saved.rglob("*.json")) == []


def test_revocation_after_confirmed_reservation_preserves_private_outcome(saved, monkeypatch):
    original = store._publish
    revoked = False
    def publish(*args):
        nonlocal revoked
        original(*args)
        revoked = True
    monkeypatch.setattr(store, "_publish", publish)
    def check():
        if revoked: raise HTTPException(401, "revoked")
    with pytest.raises(HTTPException) as error: store.reserve("owner", record(), check)
    assert error.value.status_code == 401
    assert len(list(saved.rglob("*.json"))) == 1
    receipt = store.list_receipts("owner", lambda: None)[0]
    store.finish("owner", receipt["id"], outcome())
    assert store.get("owner", receipt["id"], lambda: None)["outcome"] == outcome()


def test_denied_reads_and_reservations_do_not_touch_disk(saved):
    def denied(): raise HTTPException(403, "denied")
    with pytest.raises(HTTPException): store.reserve("owner", record(), denied)
    with pytest.raises(HTTPException): store.list_receipts("owner", denied)
    assert list(saved.iterdir()) == []


@pytest.mark.parametrize("change", ["password", "sid", "foreign-client", "bool-group", "unknown-group", "nan", "surrogate"])
def test_strict_record_cannot_store_credentials_or_invalid_restore(saved, change):
    data = record()
    if change in {"password", "sid"}: data[change] = "NEVER-SAVE"
    if change == "foreign-client": data["before"]["clientrecord"]["client"] = "192.168.1.41"
    if change == "bool-group": data["after_groups"] = [True]
    if change == "unknown-group": data["after_groups"] = [9]
    if change == "nan": data["before"]["clientrecord"]["date_added"] = float("nan")
    if change == "surrogate": data["before"]["clientrecord"]["comment"] = "\ud800"
    with pytest.raises(HTTPException): store.reserve("owner", data, lambda: None)
    assert list(saved.iterdir()) == []


def test_capacity_preserves_recovery(saved, monkeypatch):
    monkeypatch.setattr(store, "MAX_RECORDS", 1)
    receipt = store.reserve("owner", record(), lambda: None)
    store.finish("owner", receipt["id"], outcome())
    before = snapshot(saved)
    with pytest.raises(HTTPException) as error: store.reserve("owner", record(), lambda: None)
    assert error.value.status_code == 409 and snapshot(saved) == before


def test_hardlinked_evidence_rejected(saved):
    receipt = store.reserve("owner", record(), lambda: None)
    file = next(saved.rglob(receipt["id"] + ".json"))
    (saved / "outside.json").hardlink_to(file)
    with pytest.raises(HTTPException): store.list_receipts("owner", lambda: None)


def test_total_budget_preserves_existing_recovery(saved, monkeypatch):
    receipt = store.reserve("owner", record(), lambda: None)
    monkeypatch.setattr(store, "MAX_TOTAL_BYTES", 1024)
    before = snapshot(saved)
    with pytest.raises(HTTPException) as error: store.reserve("owner", record(), lambda: None)
    assert error.value.status_code == 409 and snapshot(saved) == before
    assert store.get("owner", receipt["id"], lambda: None)["before"] == record()["before"]


@pytest.mark.parametrize("change", [{"attempted": False}, {"membership_verified": False},
                                  {"outcome": "unknown"}, {"outcome": "not_attempted"}])
def test_restart_cannot_turn_contradictory_outcome_into_success(saved, monkeypatch, change):
    receipt = store.reserve("owner", record(), lambda: None)
    store.finish("owner", receipt["id"], outcome())
    path = next(saved.rglob(receipt["id"] + ".outcome.json"))
    path.write_text(json.dumps({**outcome(), **change}), encoding="utf-8")
    monkeypatch.setattr(store, "_SEEN", {})
    before = snapshot(saved)
    with pytest.raises(HTTPException): store.list_receipts("owner", lambda: None)
    assert snapshot(saved) == before
