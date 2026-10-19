"""Canonical naming changes preserve identity bytes and use only temporary roots."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

import node_settings as store
import tli_state as S
from tests.test_peer_trust import peers, browser


DOCUMENT = {"node_id": "original-node", "node_name": "Original name", "role": "member",
            "mesh_status": "approved", "host_device_id": "host-id", "host_name": "Host name",
            "host_address": "https://192.0.2.2:8443", "created_at": "2001-01-01T00:00:00Z",
            "updated_at": "2001-02-01T00:00:00Z", "prefer_mesh_ai": True,
            "mesh_ai_cpu_threshold": 81, "future": {"keep": [1, None, {"exact": True}]}}


@pytest.fixture
def installation(tmp_path, monkeypatch):
    root = tmp_path / "data"
    node = root / "mesh" / "node_config.json"
    node.parent.mkdir(parents=True)
    raw = json.dumps(DOCUMENT, separators=(",", ":")).encode()
    node.write_bytes(raw)
    legacy = root / "devices.json"
    legacy.write_bytes(b'{"default-device":{"ai_name":"Legacy","created_at":"old","future":42},"other":{"keep":true}}')
    monkeypatch.setattr(S, "DATA_DIR", str(root))
    monkeypatch.setattr(S, "NODE_CONFIG_PATH", node)
    monkeypatch.setattr(S, "DEVICES_FILE", str(legacy))
    monkeypatch.setattr(S, "now_iso", lambda: "2002-01-01T00:00:00Z")
    monkeypatch.setattr(store, "_UNCERTAIN", set())
    f = SimpleNamespace(root=root, node=node, raw=raw, legacy=legacy, legacy_raw=legacy.read_bytes(),
                        revoked=False, error=HTTPException(401, "Authority ended"))

    def check():
        if f.revoked:
            f.revoked = False
            raise f.error

    f.check = check
    return f


def files(root):
    return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}


def assert_error(call, status=503):
    with pytest.raises(HTTPException) as raised:
        call()
    assert raised.value.status_code == status
    assert raised.value.headers["Cache-Control"] == "no-store"
    return raised.value


@pytest.mark.parametrize("change", [{"name": "  New name  "}, {"role": " HOST "},
                                  {"name": "New name", "role": "standalone"}])
def test_only_requested_fields_change_and_legacy_registry_is_untouched(installation, change):
    f = installation
    result = S.update_node_settings(**change, check=f.check)
    saved = json.loads(f.node.read_bytes())
    expected = dict(DOCUMENT, updated_at="2002-01-01T00:00:00Z")
    if "name" in change: expected["node_name"] = change["name"].strip()
    if "role" in change: expected["role"] = change["role"].strip().lower()
    assert saved == expected
    assert result == {key: expected[key] for key in ("node_id", "node_name", "role")}
    assert f.legacy.read_bytes() == f.legacy_raw
    assert {path.name for path in f.node.parent.iterdir()} == {"node_config.json"}
    assert S.read_node_config().node_id == "original-node"


@pytest.mark.parametrize("name", ["é" * 64, "🙂" * 64, "N" * 64])
def test_names_at_unicode_bounds_are_preserved(installation, name):
    result = S.update_node_settings(name=name, check=installation.check)
    assert result["node_name"] == name
    assert json.loads(installation.node.read_bytes())["node_name"] == name


@pytest.mark.parametrize("change", [{}, {"name": " Original name "}, {"role": "MEMBER"},
                                  {"name": "Original name", "role": "member"}])
def test_no_change_does_not_replace_or_create_recovery_files(installation, monkeypatch, change):
    before = files(installation.root)
    monkeypatch.setattr(store.os, "replace", lambda *a: pytest.fail("No-op replaced node file"))
    result = S.update_node_settings(**change, check=installation.check)
    assert result["node_name"] == "Original name"
    assert files(installation.root) == before


def test_role_only_edit_preserves_legacy_long_name(installation):
    document = dict(DOCUMENT, node_name="Legacy " + "é" * 100)
    installation.node.write_text(json.dumps(document), encoding="utf-8")
    result = S.update_node_settings(role="host", check=installation.check)
    assert result["node_name"] == document["node_name"]
    assert json.loads(installation.node.read_bytes())["node_name"] == document["node_name"]


@pytest.mark.parametrize("name", ["", "   ", "x" * 65, "🙂" * 65, " " * 257, "bad\ud800",
    "\nLeading", "Trailing\r", "\tTab", "bad\0name", "bad\x7fname", "bad\x85name", "bad\x9fname", 1, True])
def test_invalid_names_fail_before_saved_reads(installation, monkeypatch, name):
    before = files(installation.root)
    monkeypatch.setattr(store, "_snapshot", lambda *a: pytest.fail("Invalid input read saved settings"))
    assert_error(lambda: S.update_node_settings(name=name, check=installation.check), 400)
    assert files(installation.root) == before


@pytest.mark.parametrize("role", ["", "other", "host" * 9, 1, True])
def test_invalid_roles_are_not_persisted(installation, role):
    before = files(installation.root)
    assert_error(lambda: S.update_node_settings(role=role, check=installation.check), 400)
    assert files(installation.root) == before


@pytest.mark.parametrize("raw", [b"{broken", b"[]", b"{}", b"null", b'"private"',
    b'{"node_id":"first","node_id":"second"}',
    json.dumps(dict(DOCUMENT, future={"bad": float("nan")})).encode(),
    json.dumps(dict(DOCUMENT, future={"bad": float("inf")})).encode(),
    json.dumps(DOCUMENT).replace('"future":', '"extra":1e999,"future":').encode(),
    json.dumps(DOCUMENT).replace('"keep":', '"bad":1,"bad":2,"keep":').encode(),
    b"\xff", b" " * (store.MAX_BYTES + 1),
    json.dumps(dict(DOCUMENT, role="unsupported")).encode(),
    json.dumps(dict(DOCUMENT, node_id="")).encode(),
], ids=["broken", "list", "empty", "null", "string", "duplicate", "nan", "infinity",
        "overflow", "nested-duplicate", "invalid-utf8", "oversize", "invalid-role", "empty-id"])
def test_damaged_document_is_never_replaced(installation, raw):
    f = installation
    f.node.write_bytes(raw)
    before = files(f.root)
    assert_error(lambda: S.update_node_settings(name="New name", check=f.check))
    assert files(f.root) == before
    assert store._UNCERTAIN == set()


def test_missing_identity_is_not_created_even_without_dependencies(installation):
    f = installation
    f.node.unlink()
    before = files(f.root)
    assert_error(lambda: S.update_node_settings(name="New name", check=f.check))
    assert files(f.root) == before


def test_canonical_read_returns_detached_projection(installation):
    result = store.read_node_settings(check=installation.check)
    result["node_name"] = "Caller mutation"
    assert store.read_node_settings(check=installation.check)["node_name"] == "Original name"
    assert installation.node.read_bytes() == installation.raw


@pytest.mark.parametrize("kind", ["hardlink", "symlink", "case-alias"])
def test_aliased_node_paths_are_rejected_without_changes(installation, kind):
    f = installation
    other = f.node.with_name("original.json")
    if kind == "case-alias":
        f.node.rename(f.node.with_name("NODE_CONFIG.JSON"))
    else:
        f.node.rename(other)
        try:
            if kind == "symlink": f.node.symlink_to(other)
            else: os.link(other, f.node)
        except OSError as error:
            pytest.skip("Test host cannot create temporary " + kind + ": " + str(error))
    before = files(f.root)
    assert_error(lambda: S.update_node_settings(name="New name", check=f.check))
    assert files(f.root) == before


@pytest.mark.parametrize("target", ["file", "parent"])
@pytest.mark.parametrize("unsafe", ["zero-inode", "reparse"])
def test_unknown_identity_or_reparse_component_blocks_write(installation, monkeypatch, target, unsafe):
    f = installation
    chosen = f.node if target == "file" else f.node.parent
    original = Path.lstat
    def lstat(path, *args, **kwargs):
        info = original(path, *args, **kwargs)
        if path != chosen:
            return info
        result = SimpleNamespace(**{key: getattr(info, key) for key in (
            "st_mode", "st_ino", "st_dev", "st_size", "st_mtime_ns", "st_ctime_ns", "st_nlink")})
        result.st_file_attributes = getattr(info, "st_file_attributes", 0)
        if unsafe == "zero-inode": result.st_ino = 0
        else: result.st_file_attributes |= 0x400
        return result
    monkeypatch.setattr(Path, "lstat", lstat)
    assert_error(lambda: S.update_node_settings(name="New name", check=f.check))
    assert f.node.read_bytes() == f.raw


ERRORS = [pytest.param(lambda: HTTPException(401, "Revoked"), id="401"),
          pytest.param(lambda: HTTPException(503, "Security unavailable"), id="503"),
          pytest.param(lambda: FileNotFoundError("Denied"), id="missing"),
          pytest.param(lambda: OSError("Denied"), id="os-error")]


@pytest.mark.parametrize("error_factory", ERRORS)
@pytest.mark.parametrize("stage", ["admission", "lock", "original-read", "stage-fsync", "recovery-fsync", "final-read"])
def test_one_shot_authority_failure_preserves_original(installation, monkeypatch, error_factory, stage):
    f = installation
    f.error = error_factory()
    before = files(f.root)
    if stage == "admission":
        f.revoked = True
    elif stage == "lock":
        class Lock:
            def __enter__(self): f.revoked = True
            def __exit__(self, *args): return False
        monkeypatch.setattr(S, "_NODE_CONFIG_LOCK", Lock())
    elif stage in {"stage-fsync", "recovery-fsync"}:
        original, calls = store.os.fsync, []
        def fsync(descriptor):
            original(descriptor)
            calls.append(True)
            if len(calls) == (1 if stage == "stage-fsync" else 2): f.revoked = True
        monkeypatch.setattr(store.os, "fsync", fsync)
    else:
        original, calls = store._read_file, []
        def read(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if path == f.node:
                calls.append(True)
                if len(calls) == (1 if stage == "original-read" else 2): f.revoked = True
            return result
        monkeypatch.setattr(store, "_read_file", read)
    with pytest.raises(type(f.error)) as raised:
        S.update_node_settings(name="New name", check=f.check)
    assert raised.value is f.error
    assert files(f.root) == before
    assert store._UNCERTAIN == set()


def test_invalid_input_error_rechecks_authority(installation, monkeypatch):
    original = store._inputs
    def inputs(*args):
        installation.revoked = True
        return original(*args)
    monkeypatch.setattr(store, "_inputs", inputs)
    with pytest.raises(HTTPException) as raised:
        S.update_node_settings(name="", check=installation.check)
    assert raised.value is installation.error


@pytest.mark.parametrize("mode", ["changed", "corrupt", "missing"])
def test_original_changed_during_staging_is_preserved(installation, monkeypatch, mode):
    f = installation
    original, calls = store.os.fsync, []
    changed = json.dumps(dict(DOCUMENT, future={"external": "preserved"})).encode()
    def fsync(descriptor):
        original(descriptor)
        calls.append(True)
        if len(calls) == 1:
            if mode == "missing": f.node.unlink()
            else: f.node.write_bytes(changed if mode == "changed" else b"corrupt external bytes")
    monkeypatch.setattr(store.os, "fsync", fsync)
    assert_error(lambda: S.update_node_settings(name="New name", check=f.check), 409 if mode == "changed" else 503)
    if mode == "missing": assert not f.node.exists()
    else: assert f.node.read_bytes() == (changed if mode == "changed" else b"corrupt external bytes")
    assert not list(f.node.parent.glob(".tli-node-settings-*"))
    assert store._UNCERTAIN == set()


@pytest.mark.parametrize("which", [1, 2])
def test_same_inode_staged_corruption_never_commits(installation, monkeypatch, which):
    original, calls = store.os.fsync, []
    def fsync(descriptor):
        original(descriptor)
        calls.append(True)
        if len(calls) == which:
            os.lseek(descriptor, 0, os.SEEK_SET)
            os.write(descriptor, b"CORRUPTED")
            original(descriptor)
    monkeypatch.setattr(store.os, "fsync", fsync)
    assert_error(lambda: S.update_node_settings(name="New name", check=installation.check))
    assert installation.node.read_bytes() == installation.raw
    assert not list(installation.node.parent.glob(".tli-node-settings-*"))


def test_staged_path_replaced_during_final_original_read_is_not_followed(installation, monkeypatch):
    f = installation
    original, count = store._snapshot, []
    impostor = b"Preserve the replacement file too"
    def snapshot(path, check):
        result = original(path, check)
        count.append(True)
        if len(count) == 2:
            stage = next(f.node.parent.glob(".tli-node-settings-*.tmp"))
            stage.unlink()
            stage.write_bytes(impostor)
        return result
    monkeypatch.setattr(store, "_snapshot", snapshot)
    assert_error(lambda: S.update_node_settings(name="New name", check=f.check))
    assert f.node.read_bytes() == f.raw
    retained = list(f.node.parent.glob(".tli-node-settings-*.tmp"))
    assert len(retained) == 1 and retained[0].read_bytes() == impostor


@pytest.mark.parametrize("status", [401, 503])
def test_confirmed_replace_survives_late_denial_without_uncertain_latch(installation, monkeypatch, status):
    f = installation
    original = store.os.replace
    f.error = HTTPException(status, "Authority ended")
    def replace(source, target):
        original(source, target)
        f.revoked = True
    monkeypatch.setattr(store.os, "replace", replace)
    with pytest.raises(HTTPException) as raised:
        S.update_node_settings(name="Confirmed new name", check=f.check)
    assert raised.value is f.error
    assert S.read_node_config().node_name == "Confirmed new name"
    assert store._UNCERTAIN == set()
    assert f.legacy.read_bytes() == f.legacy_raw
    assert not list(f.node.parent.glob(".tli-node-settings-*"))


@pytest.mark.parametrize("landed", [False, True])
@pytest.mark.parametrize("revoke", [False, True])
def test_uncertain_replace_retains_both_versions_and_blocks_all_shared_node_access(installation, monkeypatch, landed, revoke):
    f = installation
    cfg = S.read_node_config()
    original = store.os.replace
    def replace(source, target):
        if landed: original(source, target)
        if revoke: f.revoked = True
        raise OSError("Replacement result cannot be confirmed")
    monkeypatch.setattr(store.os, "replace", replace)
    with pytest.raises(HTTPException) as raised:
        S.update_node_settings(name="Unconfirmed name", check=f.check)
    assert raised.value.status_code == (401 if revoke else 503)
    assert str(f.node) in store._UNCERTAIN
    retained = list(f.node.parent.glob(".tli-node-settings-*.recovery.json"))
    assert len(retained) == 1
    record = json.loads(retained[0].read_bytes())
    assert record["version"] == 1 and record["target"] == "node_config.json"
    before, after = (base64.b64decode(record[key]["base64"], validate=True) for key in ("before", "after"))
    assert before == f.raw
    assert json.loads(after)["node_name"] == "Unconfirmed name"
    for key, raw in (("before", before), ("after", after)):
        assert hashlib.sha256(raw).hexdigest() == record[key]["sha256"]
    assert f.node.read_bytes() == (after if landed else before)
    preserved = files(f.root)
    for read_or_write in (S.read_node_config, S.load_node_config, lambda: S.save_node_config(cfg),
                          store.read_node_settings, lambda: S.update_node_settings(name="Never replay")):
        assert_error(read_or_write)
    assert files(f.root) == preserved


def test_serialized_name_and_role_changes_do_not_lose_other_fields(installation):
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = [pool.submit(S.update_node_settings, name="New name", check=installation.check),
                pool.submit(S.update_node_settings, role="host", check=installation.check)]
        for job in jobs: job.result(timeout=5)
    saved = json.loads(installation.node.read_bytes())
    assert saved == dict(DOCUMENT, node_name="New name", role="host", updated_at="2002-01-01T00:00:00Z")


@pytest.mark.parametrize("missing_directory", [False, True])
def test_uncertain_node_blocks_trust_marker_before_read_or_write(peers, monkeypatch, missing_directory):
    import peer_trust
    monkeypatch.setattr(store, "_UNCERTAIN", set())
    if missing_directory:
        S.MESH_DIRECTORY_PATH.unlink()
    review = peer_trust.preview(peers.b, ["observe"], "owner", browser())
    def failed_replace(*args):
        raise OSError("Uncertain replacement")
    monkeypatch.setattr(store.os, "replace", failed_replace)
    assert_error(lambda: S.update_node_settings(name="Unconfirmed"))
    before = files(peers.root)
    original, node_reads = S._security.read_json, []
    def read(path, *args, **kwargs):
        if Path(path) == S.NODE_CONFIG_PATH:
            node_reads.append(True)
            if not missing_directory:
                pytest.fail("Trust marker read node after uncertain replacement")
        return original(path, *args, **kwargs)
    monkeypatch.setattr(S._security, "read_json", read)
    monkeypatch.setattr(S._security, "write_json", lambda *a, **kw: pytest.fail("Trust marker wrote after uncertainty"))
    with pytest.raises(HTTPException) as raised:
        peer_trust.approve(review["review_id"], peers.b["identity_fingerprint"],
                           peers.b["certificate_sha256"], "owner", browser())
    assert raised.value.status_code == 503
    assert review["review_id"] in peer_trust._PREVIEWS
    # The separate legacy directory fallback reads node metadata once. The
    # marker itself cannot reread it or create an absent directory after denial.
    assert len(node_reads) == int(missing_directory)
    assert files(peers.root) == before


@pytest.mark.parametrize("create", [False, True])
def test_uncertain_node_blocks_transfer_marker_before_read_key_or_write(installation, monkeypatch, create):
    import peer_transfer_store
    f = installation
    monkeypatch.setattr(S, "MESH_DATA_DIR", f.node.parent)
    def failed_replace(*args):
        raise OSError("Uncertain replacement")
    monkeypatch.setattr(store.os, "replace", failed_replace)
    assert_error(lambda: S.update_node_settings(name="Unconfirmed"))
    before = files(f.root)
    def forbidden(*args, **kwargs):
        pytest.fail("Transfer marker reached node/key/write after uncertainty")
    monkeypatch.setattr(S._security, "read_json", forbidden)
    monkeypatch.setattr(S._security, "write_json", forbidden)
    monkeypatch.setattr(S, "get_chat_key", forbidden)
    with pytest.raises(HTTPException) as raised:
        peer_transfer_store.index(create=create)
    assert raised.value.status_code == 503
    assert files(f.root) == before
