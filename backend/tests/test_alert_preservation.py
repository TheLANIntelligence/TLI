"""Strict alert persistence and captured access; temporary files only."""
import base64
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import HTTPException
import pytest

import alert_store as store
import tli_state as S


ROWS = [
    {"id": "old-a", "kind": "disk_warn_C", "message": "PRIVATE drive warning", "detail": "C:\\",
     "severity": "warn", "created_at": "2001-01-01T00:00:00Z", "dismissed": False,
     "future": {"nested": [True, None, 2], "private": "unchanged"}},
    {"id": "old-b", "kind": "legacy", "message": "Legacy row", "future": [1, 2]},
    {"id": "old-c", "kind": "dismissed", "dismissed": True, "future": "retain"},
]


@pytest.fixture
def host(tmp_path, monkeypatch):
    root = tmp_path / "data"
    root.mkdir()
    path = root / "tli_alerts.json"
    raw = json.dumps(ROWS, separators=(",", ":")).encode("utf-8")
    path.write_bytes(raw)
    monkeypatch.setattr(S, "DATA_DIR", str(root))
    monkeypatch.setattr(S, "ALERTS_FILE", path)
    monkeypatch.setattr(S, "now_iso", lambda: "2026-10-16T00:00:00Z")
    monkeypatch.setattr(store, "_SEEN", set())
    monkeypatch.setattr(store, "_UNCERTAIN", set())
    f = SimpleNamespace(root=root, path=path, raw=raw, rows=deepcopy(ROWS), fail=False,
                        error=HTTPException(401, "Access ended"))
    def check():
        if f.fail:
            f.fail = False
            raise f.error
    f.check = check
    return f


def files(root):
    return {p.name: p.read_bytes() for p in root.iterdir() if p.is_file()}


def operation(action, *, check=None):
    if action == "read": return S.load_alerts(check=check)
    if action == "save": return S.save_alerts(deepcopy(ROWS), check=check)
    if action == "add": return S.add_alert("new-kind", "New message", "Detail", "future-severity", check=check)
    if action == "dismiss": return S.dismiss_alert("old-a", check=check)
    if action == "resolve": return S.resolve_alert("disk_warn_C", check=check)
    if action == "all": return S.dismiss_all_alerts(check=check)
    raise AssertionError(action)


def assert_error(call, status=503):
    with pytest.raises(HTTPException) as raised:
        call()
    assert raised.value.status_code == status
    assert raised.value.headers.get("Cache-Control") == "no-store"
    return raised.value


def test_read_is_detached_and_keeps_legacy_rows_unknown_metadata_exact_bytes(host):
    rows = S.load_alerts()
    assert rows == ROWS
    rows[0]["future"]["nested"].append("local mutation")
    assert S.load_alerts() == ROWS and host.path.read_bytes() == host.raw
    assert files(host.root) == {host.path.name: host.raw}


@pytest.mark.parametrize("parents_missing", [False, True])
def test_fresh_missing_reads_and_noop_mutations_do_not_create(host, monkeypatch, parents_missing):
    host.path.unlink()
    if parents_missing:
        path = host.root / "missing" / "nested" / "tli_alerts.json"
        monkeypatch.setattr(S, "ALERTS_FILE", path)
    assert S.load_alerts() == []
    assert S.dismiss_alert("unknown") is False
    assert S.resolve_alert("unknown") is None
    assert S.dismiss_all_alerts() == 0
    assert list(host.root.iterdir()) == []
    if parents_missing:
        assert_error(lambda: S.add_alert("kind", "message"))
        assert list(host.root.iterdir()) == []


def test_add_preserves_existing_rows_and_generated_contract(host):
    result = S.add_alert("new-kind", "New message", "Detail", "future-severity")
    assert result["id"].startswith("alert-") and len(result["id"]) == 16
    assert {key: value for key, value in result.items() if key != "id"} == {
        "kind": "new-kind", "message": "New message", "detail": "Detail", "severity": "future-severity",
        "created_at": "2026-10-16T00:00:00Z", "dismissed": False}
    saved = S.load_alerts()
    assert saved[:3] == ROWS and saved[3] == result
    result["message"] = "caller mutation"
    assert S.load_alerts()[3]["message"] == "New message"
    assert set(files(host.root)) == {host.path.name}


def test_dedupe_by_active_kind_and_readdition_after_dismissal(host, monkeypatch):
    original = store._publish
    blocker = Mock(side_effect=AssertionError("Deduped alert rewrote store"))
    monkeypatch.setattr(store, "_publish", blocker)
    assert S.add_alert("disk_warn_C", "different message") is None
    assert host.path.read_bytes() == host.raw
    blocker.assert_not_called()
    monkeypatch.setattr(store, "_publish", original)
    assert S.dismiss_alert("old-a") is True
    new = S.add_alert("disk_warn_C", "New condition")
    assert new["id"] != "old-a"
    saved = S.load_alerts()
    assert saved[0] == {**ROWS[0], "dismissed": True}
    assert saved[1:3] == ROWS[1:] and saved[-1] == new


def test_dismiss_existing_and_resolve_do_not_rewrite_noops(host, monkeypatch):
    original = store._publish
    assert S.dismiss_alert("old-a") is True
    saved = S.load_alerts()
    assert saved == [{**ROWS[0], "dismissed": True}, *ROWS[1:]]
    before = host.path.read_bytes()
    blocker = Mock(side_effect=AssertionError("Noop wrote store"))
    monkeypatch.setattr(store, "_publish", blocker)
    assert S.dismiss_alert("old-a") is True
    assert S.dismiss_alert("not-found") is False
    assert S.resolve_alert("disk_warn_C") is None
    assert S.resolve_alert("not-found") is None
    assert host.path.read_bytes() == before
    blocker.assert_not_called()
    monkeypatch.setattr(store, "_publish", original)
    S.resolve_alert("legacy")
    assert S.load_alerts()[1] == {**ROWS[1], "dismissed": True}


def test_resolve_all_same_kind_and_dismiss_all_counts_active_rows(host):
    rows = deepcopy(ROWS)
    rows.append({"id": "fourth", "kind": "disk_warn_C", "future": True})
    S.save_alerts(rows)
    S.resolve_alert("disk_warn_C")
    resolved = S.load_alerts()
    assert resolved[0]["dismissed"] is True and resolved[3]["dismissed"] is True
    assert "dismissed" not in resolved[1]
    assert S.dismiss_all_alerts() == 1
    before = host.path.read_bytes()
    assert S.dismiss_all_alerts() == 0 and host.path.read_bytes() == before
    for before_row, after_row in zip(rows, S.load_alerts()):
        assert {k: v for k, v in after_row.items() if k != "dismissed"} == {
            k: v for k, v in before_row.items() if k != "dismissed"}


def test_legacy_omitted_known_fields_remain_supported(host):
    rows = [{}, {"id": "only-id"}, {"kind": "only-kind"}, {"severity": "future", "future": {"v": 1}}]
    S.save_alerts(rows)
    assert S.load_alerts() == rows
    assert S.dismiss_all_alerts() == 4
    assert S.load_alerts() == [{**row, "dismissed": True} for row in rows]


def test_save_explicit_replacement_preserves_candidate_and_detaches_it(host):
    candidate = [{"id": "new", "kind": "new", "message": "saved", "future": {"v": [1]}}]
    assert S.save_alerts(candidate) is None
    candidate[0]["future"]["v"].append(2)
    assert S.load_alerts() == [{"id": "new", "kind": "new", "message": "saved", "future": {"v": [1]}}]


BAD = [b"{bad", b"{}", b"null", b"[1]", b"[null]", b'[{}, {"dismissed":"false"}]',
       b'[{"id":"x"},{"id":"x"}]', b'[{"message":null}]', b'[{"id":""}]',
       b'[{"kind":""}]', b'[{"id":"a","id":"b"}]', b'[{"future":{"x":1,"x":2}}]',
       b'[{"future":NaN}]', b'[{"future":1e999}]', b'[{"future":"\\ud800"}]', b"\xff",
       b" " * (store.MAX_BYTES + 1)]


@pytest.mark.parametrize("raw", BAD, ids=["syntax", "object", "null", "scalar-row", "null-row", "dismissed-type",
    "duplicate-id", "message-type", "empty-id", "empty-kind", "duplicate-key", "nested-duplicate",
    "nan", "overflow", "surrogate", "utf8", "oversize"])
def test_damage_blocks_every_shared_helper_without_change(host, raw):
    host.path.write_bytes(raw)
    for action in ("read", "save", "add", "dismiss", "resolve", "all"):
        error = assert_error(lambda: operation(action))
        assert "PRIVATE" not in error.detail
        assert files(host.root) == {host.path.name: raw}


@pytest.mark.parametrize("damaged_first", [False, True])
def test_observed_disappearance_never_becomes_empty(host, damaged_first):
    if damaged_first:
        host.path.write_bytes(b"{broken")
        assert_error(S.load_alerts)
    else:
        assert S.load_alerts() == ROWS
    host.path.unlink()
    for action in ("read", "save", "add", "dismiss", "resolve", "all"):
        assert_error(lambda: operation(action))
    assert files(host.root) == {}


@pytest.mark.parametrize("action", ["save", "add", "dismiss", "resolve"])
@pytest.mark.parametrize("invalid", [None, 42, "", " " * 3, "x" * 1025, "\ud800"],
                         ids=["none", "integer", "empty", "spaces", "oversize", "surrogate"])
def test_invalid_arguments_preserve_original(host, action, invalid):
    if action == "save": callback = lambda: S.save_alerts([{"id": invalid}])
    elif action == "add": callback = lambda: S.add_alert(invalid, "message")
    elif action == "dismiss": callback = lambda: S.dismiss_alert(invalid)
    else: callback = lambda: S.resolve_alert(invalid)
    assert_error(callback, 400)
    assert files(host.root) == {host.path.name: host.raw}


def test_maximum_row_bound_never_prunes_history(host, monkeypatch):
    monkeypatch.setattr(store, "MAX_ROWS", len(ROWS))
    assert_error(lambda: S.add_alert("new", "message"), 409)
    assert host.path.read_bytes() == host.raw
    monkeypatch.setattr(store, "MAX_ROWS", len(ROWS) - 1)
    assert_error(S.load_alerts)
    assert host.path.read_bytes() == host.raw


@pytest.mark.parametrize("where", ["target", "parent"])
@pytest.mark.parametrize("invalid", ["inode", "reparse"])
def test_unknown_or_reparse_identity_fails_closed(host, monkeypatch, where, invalid):
    target = host.path if where == "target" else host.root
    original = Path.lstat
    def lstat(path, *args, **kwargs):
        value = original(path, *args, **kwargs)
        if path == target:
            attrs = {key: getattr(value, key) for key in dir(value) if key.startswith("st_")}
            attrs.update({"st_ino": 0} if invalid == "inode" else {"st_file_attributes": 0x400})
            return SimpleNamespace(**attrs)
        return value
    monkeypatch.setattr(Path, "lstat", lstat)
    assert_error(S.load_alerts)
    assert_error(lambda: S.dismiss_alert("old-a"))
    assert host.path.read_bytes() == host.raw


@pytest.mark.parametrize("kind", ["hardlink", "symlink", "directory", "case-alias", "linked-parent"])
def test_linked_or_aliased_paths_are_preserved_not_followed(host, monkeypatch, kind):
    original = host.root / "original.json"
    host.path.rename(original)
    if kind == "hardlink": os.link(original, host.path)
    elif kind == "directory": host.path.mkdir()
    elif kind == "case-alias": original.rename(host.path.with_name("TLI_ALERTS.JSON"))
    elif kind == "symlink":
        try: host.path.symlink_to(original)
        except OSError: pytest.skip("Host cannot create fixture symlinks")
    else:
        real = host.root / "real"
        real.mkdir()
        original.rename(real / "tli_alerts.json")
        linked = host.root / "linked"
        try: linked.symlink_to(real, target_is_directory=True)
        except OSError: pytest.skip("Host cannot create fixture symlinks")
        monkeypatch.setattr(S, "ALERTS_FILE", linked / "tli_alerts.json")
    assert_error(S.load_alerts)
    assert_error(lambda: S.save_alerts([]))
    if original.exists(): assert original.read_bytes() == host.raw


@pytest.mark.parametrize("phase", ["lock", "read", "stage-fsync", "recovery-fsync", "final-read"])
@pytest.mark.parametrize("kind", ["401", "503", "missing", "os"])
def test_one_shot_authority_errors_stop_before_commit_without_fallback(host, monkeypatch, phase, kind):
    host.error = {"401": HTTPException(401, "Expired"), "503": HTTPException(503, "PIN unavailable"),
                  "missing": FileNotFoundError("check"), "os": OSError("check")}[kind]
    if phase == "lock":
        class Lock:
            def __enter__(self): host.fail = True
            def __exit__(self, *args): pass
        monkeypatch.setattr(store, "LOCK", Lock())
    elif phase in {"read", "final-read"}:
        original = store._snapshot
        calls = []
        def snapshot(*args):
            result = original(*args); calls.append(1)
            if len(calls) == (1 if phase == "read" else 2): host.fail = True
            return result
        monkeypatch.setattr(store, "_snapshot", snapshot)
    else:
        original = store.os.fsync
        calls = []
        def fsync(fd):
            original(fd); calls.append(1)
            if len(calls) == (1 if phase == "stage-fsync" else 2): host.fail = True
        monkeypatch.setattr(store.os, "fsync", fsync)
    with pytest.raises(type(host.error)) as raised:
        S.dismiss_alert("old-a", check=host.check)
    assert raised.value is host.error
    assert files(host.root) == {host.path.name: host.raw} and not store._UNCERTAIN


@pytest.mark.parametrize("action", ["read", "save", "add", "dismiss", "resolve", "all"])
def test_every_shared_helper_checks_admission_before_read(host, monkeypatch, action):
    blocker = Mock(side_effect=AssertionError("Denied helper read store"))
    monkeypatch.setattr(store, "_snapshot", blocker)
    host.fail = True
    with pytest.raises(HTTPException) as raised:
        operation(action, check=host.check)
    assert raised.value is host.error
    blocker.assert_not_called()


@pytest.mark.parametrize("phase", ["first-read", "final-read"])
def test_read_error_rechecks_authority_before_disclosure(host, monkeypatch, phase):
    original = store._read_file
    calls = []
    def read(*args, **kwargs):
        calls.append(1)
        if len(calls) == (1 if phase == "first-read" else 4):
            host.fail = True
            raise OSError("PRIVATE filesystem detail")
        return original(*args, **kwargs)
    monkeypatch.setattr(store, "_read_file", read)
    with pytest.raises(HTTPException) as raised:
        S.dismiss_alert("old-a", check=host.check)
    assert raised.value is host.error
    assert host.path.read_bytes() == host.raw


@pytest.mark.parametrize("where", ["target", "parent"])
def test_marked_missing_failure_is_not_absence(host, monkeypatch, where):
    error = FileNotFoundError("Authority lost")
    error.alert_authority_failure = True
    target = host.path if where == "target" else host.root
    original = Path.lstat
    def lstat(path, *args, **kwargs):
        if path == target: raise error
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, "lstat", lstat)
    with pytest.raises(FileNotFoundError) as raised:
        S.load_alerts(check=host.check)
    assert raised.value is error


@pytest.mark.parametrize("change", ["valid", "damaged", "deleted"])
def test_original_change_during_staging_is_preserved(host, monkeypatch, change):
    original = store.os.fsync
    external = b'[{"id":"external","future":true}]' if change == "valid" else b"{broken"
    once = []
    def fsync(fd):
        original(fd)
        if not once:
            once.append(1)
            if change == "deleted": host.path.unlink()
            else: host.path.write_bytes(external)
    monkeypatch.setattr(store.os, "fsync", fsync)
    assert_error(lambda: S.dismiss_alert("old-a"), 409 if change == "valid" else 503)
    assert files(host.root) == ({} if change == "deleted" else {host.path.name: external})
    assert not store._UNCERTAIN


@pytest.mark.parametrize("phase", ["stage", "recovery"])
def test_staged_inode_byte_changes_are_detected_before_replace(host, monkeypatch, phase):
    original = store.os.fsync
    calls = []
    def fsync(fd):
        original(fd); calls.append(1)
        if len(calls) == (1 if phase == "stage" else 2):
            os.lseek(fd, 0, os.SEEK_SET); os.write(fd, b"broken")
    monkeypatch.setattr(store.os, "fsync", fsync)
    assert_error(lambda: S.dismiss_alert("old-a"))
    assert files(host.root) == {host.path.name: host.raw}


def test_final_stage_path_replacement_is_not_committed_or_deleted(host, monkeypatch):
    original = store._snapshot
    count = []
    impostor = []
    def snapshot(*args):
        result = original(*args); count.append(1)
        if len(count) == 2:
            stage = next(host.root.glob("*.tmp"))
            saved = stage.with_suffix(".saved")
            stage.rename(saved)
            stage.write_bytes(b"impostor")
            impostor.append(stage)
        return result
    monkeypatch.setattr(store, "_snapshot", snapshot)
    assert_error(lambda: S.dismiss_alert("old-a"))
    assert host.path.read_bytes() == host.raw and impostor[0].read_bytes() == b"impostor"
    assert store._UNCERTAIN  # Unowned staging path cannot be safely cleaned.


@pytest.mark.parametrize("action", ["save", "add", "dismiss", "resolve", "all"])
@pytest.mark.parametrize("landed", [False, True])
@pytest.mark.parametrize("denied", [False, True])
def test_uncertain_replace_retains_versions_and_blocks_all_helpers(host, monkeypatch, action, landed, denied):
    original = store._publish
    after = []
    def publish(staged, target, **kwargs):
        after.append(staged.read_bytes())
        if landed: original(staged, target, **kwargs)
        if denied: host.fail = True
        raise OSError("Unconfirmed publication")
    monkeypatch.setattr(store, "_publish", publish)
    with pytest.raises(HTTPException) as raised:
        operation(action, check=host.check)
    assert raised.value.status_code == (401 if denied else 503)
    if denied: assert raised.value is host.error
    assert host.path.read_bytes() == (after[0] if landed else host.raw)
    recovery = next(host.root.glob("*.recovery.json"))
    record = json.loads(recovery.read_bytes())
    assert record["target"] == host.path.name and record["operation"] == "alerts"
    for key, raw in (("before", host.raw), ("after", after[0])):
        assert base64.b64decode(record[key]["base64"]) == raw
        assert record[key]["sha256"] == hashlib.sha256(raw).hexdigest()
    retained = files(host.root)
    for other in ("read", "save", "add", "dismiss", "resolve", "all"):
        assert_error(lambda: operation(other))
    assert files(host.root) == retained


@pytest.mark.parametrize("action", ["save", "add", "dismiss", "resolve", "all"])
@pytest.mark.parametrize("status", [401, 503])
def test_confirmed_effect_is_retained_before_late_denial(host, monkeypatch, action, status):
    host.error = HTTPException(status, "Access unavailable")
    original = store._publish
    expected = []
    def publish(staged, target, **kwargs):
        expected.append(staged.read_bytes())
        original(staged, target, **kwargs)
        host.fail = True
    monkeypatch.setattr(store, "_publish", publish)
    with pytest.raises(HTTPException) as raised:
        operation(action, check=host.check)
    assert raised.value is host.error and not store._UNCERTAIN
    assert host.path.read_bytes() == expected[0]
    assert S.load_alerts() == json.loads(expected[0])
    assert files(host.root) == {host.path.name: expected[0]}


@pytest.mark.parametrize("published", [False, True])
@pytest.mark.parametrize("denied", [False, True])
def test_cleanup_failure_latches_and_preserves_original_denial(host, monkeypatch, published, denied):
    if published:
        original = store._publish
        def publish(*args, **kwargs):
            original(*args, **kwargs)
            if denied: host.fail = True
        monkeypatch.setattr(store, "_publish", publish)
    else:
        original = store.os.fsync
        def fsync(fd):
            original(fd)
            if denied: host.fail = True
            else: raise OSError("Staging unavailable")
        monkeypatch.setattr(store.os, "fsync", fsync)
    original_unlink = Path.unlink
    def unlink(path, *args, **kwargs):
        if path.name.startswith(".tli-alerts-"): raise OSError("Cleanup unavailable")
        return original_unlink(path, *args, **kwargs)
    monkeypatch.setattr(Path, "unlink", unlink)
    with pytest.raises(HTTPException) as raised:
        S.dismiss_alert("old-a", check=host.check)
    assert raised.value.status_code == (401 if denied else 503)
    if denied: assert raised.value is host.error
    assert store._UNCERTAIN
    retained = files(host.root)
    assert len(retained) >= 2
    assert_error(S.load_alerts)
    assert files(host.root) == retained


@pytest.mark.parametrize("posix", [False, True])
def test_fresh_creation_is_exclusive_and_finishes_link_cleanup(host, monkeypatch, posix):
    host.path.unlink()
    monkeypatch.setattr(store, "WINDOWS", not posix)
    result = S.add_alert("new", "message")
    assert S.load_alerts() == [result]
    assert host.path.stat().st_nlink == 1
    assert set(files(host.root)) == {host.path.name}


def test_fresh_create_arrival_is_not_overwritten(host, monkeypatch):
    host.path.unlink()
    original = store._publish
    external = b'[{"id":"external"}]'
    def publish(staged, target, **kwargs):
        target.write_bytes(external)
        original(staged, target, **kwargs)
    monkeypatch.setattr(store, "_publish", publish)
    assert_error(lambda: S.add_alert("new", "message"))
    assert host.path.read_bytes() == external and store._UNCERTAIN
    record = json.loads(next(host.root.glob("*.recovery.json")).read_bytes())
    assert record["before"] is None


def test_posix_failed_staging_cleanup_keeps_before_after_envelope(host, monkeypatch):
    host.path.unlink()
    monkeypatch.setattr(store, "WINDOWS", False)
    original = Path.unlink
    def unlink(path, *args, **kwargs):
        if path.name.startswith(".tli-alerts-") and path.suffix == ".tmp":
            raise OSError("Owned stage could not be removed")
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, "unlink", unlink)
    assert_error(lambda: S.add_alert("new", "message"))
    assert host.path.stat().st_nlink == 2 and store._UNCERTAIN
    record = json.loads(next(host.root.glob("*.recovery.json")).read_bytes())
    assert record["before"] is None
    assert base64.b64decode(record["after"]["base64"]) == host.path.read_bytes()
    retained = files(host.root)
    assert len(retained) == 3
    assert_error(S.load_alerts)
    assert files(host.root) == retained


def test_precommit_fsync_failure_is_clean_and_retryable(host, monkeypatch):
    original = store.os.fsync
    monkeypatch.setattr(store.os, "fsync", Mock(side_effect=OSError("Storage unavailable")))
    assert_error(lambda: S.dismiss_alert("old-a"))
    assert files(host.root) == {host.path.name: host.raw} and not store._UNCERTAIN
    monkeypatch.setattr(store.os, "fsync", original)
    assert S.dismiss_alert("old-a") is True
    assert S.load_alerts()[0]["dismissed"] is True


def test_parallel_add_and_dismiss_preserve_both_updates(host):
    with ThreadPoolExecutor(max_workers=2) as pool:
        added = pool.submit(S.add_alert, "new-kind", "New message")
        dismissed = pool.submit(S.dismiss_alert, "old-a")
        row, done = added.result(), dismissed.result()
    assert done is True
    assert S.load_alerts() == [{**ROWS[0], "dismissed": True}, *ROWS[1:], row]


def test_parallel_same_kind_producers_dedupe_inside_transaction(host):
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: S.add_alert("same-kind", "message"), range(4)))
    assert sum(result is not None for result in results) == 1
    assert S.load_alerts()[:3] == ROWS
    assert len(S.load_alerts()) == 4


def test_parallel_add_and_dismiss_all_report_the_serialized_outcome(host):
    with ThreadPoolExecutor(max_workers=2) as pool:
        added = pool.submit(S.add_alert, "new-kind", "message")
        dismissed = pool.submit(S.dismiss_all_alerts)
        row, count = added.result(), dismissed.result()
    saved = S.load_alerts()
    assert len(saved) == 4 and all(item["dismissed"] is True for item in saved[:3])
    assert {k: v for k, v in saved[-1].items() if k != "dismissed"} == {
        k: v for k, v in row.items() if k != "dismissed"}
    assert count == (3 if saved[-1]["dismissed"] else 2)
