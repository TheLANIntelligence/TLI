"""Satellite registry damage and interrupted writes stay visible and preserved."""
import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

import satellite_store as store
from routers import satellite_routes as sat
from tests.test_satellite_authorization import ENTRY, phones, issue, redeem


DAMAGED = [b"{", b"null", b"{}", b'[1]', b'[{"node_id":"sat_0123456789"}]',
           json.dumps([ENTRY, ENTRY]).encode(),
           json.dumps([{**ENTRY, "secret": ""}]).encode(),
           json.dumps([{**ENTRY, "node_id": "SAT_0123456789"}]).encode(),
           json.dumps([{**ENTRY, "last_seen": "not-time"}]).encode(),
           json.dumps([{**ENTRY, "battery_level": True}]).encode(),
           json.dumps([{**ENTRY, "online": 1}]).encode(),
           json.dumps([{**ENTRY, "future": float("nan")}]).encode(),
           json.dumps([{**ENTRY, "future": 1}]).replace('"future": 1', '"future": 1e999').encode(),
           json.dumps([ENTRY]).replace('"name": "Old phone"', '"name": "Old phone", "name": "duplicate"').encode(),
           json.dumps([ENTRY]).replace('"retain": [1, "vendor"]', '"retain": 1, "retain": 2').encode(),
           b'\xff']


@pytest.mark.parametrize("raw", DAMAGED)
@pytest.mark.parametrize("operation", ["list", "register", "heartbeat", "remove", "self-remove"])
def test_damage_never_becomes_empty_or_is_overwritten(phones, raw, operation):
    desktop, _ = phones.client()
    token = issue(desktop)
    phone, _ = phones.client(remote=True, secure=True)
    phones.path.write_bytes(raw)
    if operation == "list": result = desktop.get("/mesh/satellite/list")
    elif operation == "register": result = redeem(phone, token)
    elif operation == "heartbeat": result = phone.post("/mesh/satellite/heartbeat", json=ENTRY)
    elif operation == "self-remove": result = phone.post("/mesh/satellite/self-remove", json=ENTRY)
    else: result = desktop.delete("/mesh/satellite/" + ENTRY["node_id"])
    assert result.status_code == 503, result.text
    assert result.headers["cache-control"] == "no-store"
    assert phones.path.read_bytes() == raw and token in sat._join_tokens
    assert not list(phones.path.parent.glob(".tli-satellite-*.tmp"))


def test_fresh_missing_registry_is_valid_but_seen_deletion_is_not(phones):
    phones.path.unlink()
    assert store.read(phones.path) == []
    store.write(phones.path, [copy.deepcopy(ENTRY)])
    assert store.read(phones.path) == [ENTRY]
    phones.path.unlink()
    with pytest.raises(HTTPException) as error:
        store.write(phones.path, [])
    assert error.value.status_code == 503 and not phones.path.exists()


def test_oversize_and_excess_rows_are_preserved(phones, monkeypatch):
    before = phones.path.read_bytes()
    monkeypatch.setattr(store, "MAX_BYTES", len(before) - 1)
    with pytest.raises(HTTPException) as error:
        store.write(phones.path, [])
    assert error.value.status_code == 503 and phones.path.read_bytes() == before
    monkeypatch.setattr(store, "MAX_BYTES", 1024 * 1024)
    monkeypatch.setattr(store, "MAX_ROWS", 0)
    with pytest.raises(HTTPException) as error:
        store.read(phones.path)
    assert error.value.status_code == 503 and phones.path.read_bytes() == before


@pytest.mark.parametrize("kind", ["hardlink", "symlink", "reparse", "unknown-file-id", "unknown-parent-id"])
def test_linked_or_unidentifiable_registry_is_not_read_or_replaced(phones, monkeypatch, kind):
    before = phones.path.read_bytes()
    other = phones.path.with_name("unrelated.json")
    if kind == "hardlink":
        os.link(phones.path, other)
    elif kind == "symlink":
        phones.path.rename(other)
        try:
            phones.path.symlink_to(other)
        except OSError as error:
            pytest.skip(str(error))
    else:
        original = Path.lstat
        def lstat(path, *args, **kwargs):
            value = original(path, *args, **kwargs)
            target = phones.path.parent if kind == "unknown-parent-id" else phones.path
            if path == target:
                fields = {field: getattr(value, field) for field in dir(value) if field.startswith("st_")}
                fields["st_file_attributes" if kind == "reparse" else "st_ino"] = 0x400 if kind == "reparse" else 0
                return SimpleNamespace(**fields)
            return value
        monkeypatch.setattr(Path, "lstat", lstat)
    with pytest.raises(HTTPException) as error:
        store.write(phones.path, [])
    assert error.value.status_code == 503
    assert phones.path.read_bytes() == before


@pytest.mark.parametrize("mutation", ["garbled", "valid-changed", "truncated"])
def test_staging_damage_prevents_replacement(phones, monkeypatch, mutation):
    before = phones.path.read_bytes()
    original = store.os.fsync
    def fsync(fd):
        original(fd)
        temporary = next(phones.path.parent.glob(".tli-satellite-*.tmp"))
        if mutation == "garbled": temporary.write_bytes(b"invalid")
        if mutation == "valid-changed": temporary.write_text(json.dumps([{**ENTRY, "name": "tampered"}]), encoding="utf-8")
        if mutation == "truncated": temporary.write_bytes(b"")
    monkeypatch.setattr(store.os, "fsync", fsync)
    with pytest.raises(HTTPException) as error:
        store.write(phones.path, [{**ENTRY, "name": "intended"}])
    assert error.value.status_code == 503
    assert phones.path.read_bytes() == before
    assert not list(phones.path.parent.glob(".tli-satellite-*.tmp"))


def test_changed_original_between_read_and_update_is_preserved(phones):
    expected = store.read(phones.path)
    changed = [{**ENTRY, "name": "other writer", "future": {"credential": "preserve"}}]
    phones.path.write_text(json.dumps(changed), encoding="utf-8")
    before = phones.path.read_bytes()
    with pytest.raises(HTTPException) as error:
        store.write(phones.path, [], expected=expected)
    assert error.value.status_code == 409 and phones.path.read_bytes() == before


def test_original_changed_during_staging_is_not_overwritten(phones, monkeypatch):
    original = store.os.fsync
    changed = json.dumps([{**ENTRY, "name": "external writer"}]).encode()
    def fsync(fd):
        original(fd); phones.path.write_bytes(changed)
    monkeypatch.setattr(store.os, "fsync", fsync)
    with pytest.raises(HTTPException) as error:
        store.write(phones.path, [])
    assert error.value.status_code == 409 and phones.path.read_bytes() == changed


def test_unknown_compatible_metadata_and_existing_credential_are_preserved(phones):
    phone, _ = phones.client(remote=True, secure=True)
    assert phone.post("/mesh/satellite/heartbeat", json={**ENTRY, "battery_level": 21}).status_code == 200
    row = phones.read()[0]
    assert row["secret"] == ENTRY["secret"] and row["node_id"] == ENTRY["node_id"]
    assert row["custom"] == ENTRY["custom"] and row["battery_level"] == 21


def test_heartbeat_does_not_overwrite_external_change_after_initial_read(phones, monkeypatch):
    phone, _ = phones.client(remote=True, secure=True)
    original = sat._load_reg
    changed = json.dumps([{**ENTRY, "name": "external update"}]).encode()
    def read(**kwargs):
        value = original(**kwargs); phones.path.write_bytes(changed); return value
    monkeypatch.setattr(sat, "_load_reg", read)
    response = phone.post("/mesh/satellite/heartbeat", json=ENTRY)
    assert response.status_code == 409 and phones.path.read_bytes() == changed


def test_saved_invalid_output_never_replaces_valid_registry(phones):
    before = phones.path.read_bytes()
    with pytest.raises(HTTPException) as error:
        store.write(phones.path, [{**ENTRY, "secret": None}])
    assert error.value.status_code == 422 and phones.path.read_bytes() == before
