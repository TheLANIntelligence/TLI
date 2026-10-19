"""Derived scan index tests: temporary fixtures only, no personal drive scanning."""
import json
import os
import sqlite3
import threading
import time
from pathlib import Path

import pytest

import storage_scan_algorithms as scan
import storage_inventory as inventory_module
from storage_inventory import (ACCOUNTING, MAX_PAGE, InventoryInvalid, InventoryLimit,
                               InventoryNotFound, StorageInventory)


@pytest.fixture(autouse=True)
def scanner_control(monkeypatch):
    monkeypatch.setattr(scan, "CONTROL", None)


def row(path, *, kind="file", size=12, identity=None, **extra):
    return {"path": str(path), "name": path.name, "kind": kind,
            "logical_size": size if kind == "file" else None,
            "allocated_size": 4096 if kind == "file" else None,
            "file_identity": identity or "fixture:" + path.name, "volume_identity": "fixture-volume",
            "size_known": True, "size_partial": False, "allocated_partial": False,
            "extension": path.suffix.lower(), "modified_at": "2026-10-14T00:00:00Z", **extra}


def publish(store, root, entries, *, owner="alice", meta=None):
    writer = store.begin(owner, str(root))
    writer.add_rows([row(root, kind="directory"), *entries])
    summary = writer.finalize(meta or {})
    return writer.scan_id, summary


def test_inventory_retains_every_name_and_empty_directory_beyond_tree_cap(tmp_path, monkeypatch):
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    (fixture / "empty").mkdir()
    (fixture / "nested").mkdir()
    for n in range(40):
        (fixture / "nested" / f"item-{n:02}.txt").write_bytes(b"data")
    monkeypatch.setattr(scan, "_allocated_size", lambda p, info: 4096)
    store = StorageInventory(tmp_path / "indexes")
    writer = store.begin("alice", str(fixture))
    tree, _, meta = scan._scan_tree(fixture, max_nodes=3, inventory_sink=lambda value: writer.add_rows([value]))
    summary = writer.finalize(meta)
    assert meta["representation_limited"] and summary["display_truncated"]
    assert meta["inventory_rows_emitted"] == 43
    assert summary["indexed_entries"] == 43 and summary["indexed_files"] == 40
    assert summary["acquisition_complete"] and tree["size"] == summary["logical_bytes"] == 160
    children = store.query("alice", writer.scan_id, path=str(fixture), sort="name", descending=False)["rows"]
    assert [item["name"] for item in children] == ["empty", "nested"]
    assert children[0]["children_state"] == "empty" and children[0]["children_complete"]
    assert children[1]["children_state"] == "unloaded" and children[1]["child_count"] == 40
    assert children[1]["size"] == 160 and children[1]["allocated_size"] == 40 * 4096
    assert all(item["file_identity"] for item in meta["file_summary"])


def test_deterministic_hardlink_attribution_and_all_names_retained(tmp_path):
    root = tmp_path / "scope"
    entries = [row(root / "z.bin", identity="vol:123", size=99), row(root / "a.bin", identity="vol:123", size=99)]
    store = StorageInventory(tmp_path / "indexes")
    first, summary = publish(store, root, entries)
    second, reverse = publish(store, root, list(reversed(entries)))
    one = store.query("alice", first, sort="name", descending=False)["rows"]
    two = store.query("alice", second, sort="name", descending=False)["rows"]
    assert one == two
    assert [item["size"] for item in one] == [99, 0]
    assert [item["logical_size"] for item in one] == [99, 99]
    assert [item["allocated_size"] for item in one] == [4096, 4096]
    assert one[1]["hardlink_duplicate"]
    assert summary["logical_bytes"] == reverse["logical_bytes"] == 99
    assert summary["allocated_known_bytes"] == 4096
    assert summary["hardlink_aliases"] == 1 and summary["accounting"] == ACCOUNTING
    assert summary["folder_deltas_supported"] is False


def test_byte_limited_response_is_distinct_from_normal_pagination(tmp_path, monkeypatch):
    root = tmp_path / "scope"
    store = StorageInventory(tmp_path / "indexes")
    ident, _ = publish(store, root, [row(root / (name + ".avi")) for name in ("a", "b", "c")])
    page = store.query("alice", ident, mode="largest", limit=2)
    assert len(page["rows"]) == 2 and page["has_more"]
    assert page["response_limited"] is False
    monkeypatch.setattr(inventory_module, "MAX_RESPONSE", 1)
    limited = store.query("alice", ident, mode="largest", limit=2)
    assert len(limited["rows"]) == 1 and limited["has_more"]
    assert limited["response_limited"] is True


def test_real_hardlink_sink_has_actual_bytes_and_deduplicated_counts(tmp_path, monkeypatch):
    root = tmp_path / "scope"
    root.mkdir()
    original = root / "z.txt"
    original.write_bytes(b"12345")
    try:
        os.link(original, root / "a.txt")
    except OSError:
        pytest.skip("Hard links unavailable on this fixture filesystem")
    monkeypatch.setattr(scan, "_allocated_size", lambda p, info: 4096)
    rows = []
    tree, _, meta = scan._scan_tree(root, inventory_sink=rows.append)
    files = [item for item in rows if item["kind"] == "file"]
    assert len(files) == 2 and len({item["file_identity"] for item in files}) == 1
    assert [item["logical_size"] for item in files] == [5, 5]
    assert [item["allocated_size"] for item in files] == [4096, 4096]
    assert sum(item["size"] for item in files) == tree["size"] == 5
    assert meta["hardlinks_skipped"] == 1


def test_pages_search_extensions_largest_and_selected_metadata_are_bounded(tmp_path):
    store = StorageInventory(tmp_path / "indexes")
    root = tmp_path / "scope"
    ident, summary = publish(store, root, [row(root / f"f-{n:03}.txt", size=n) for n in range(251)])
    first = store.query("alice", ident, limit=9999)
    assert len(first["rows"]) == MAX_PAGE and first["has_more"] and first["total"] == 251
    second = store.query("alice", ident, offset=first["next_offset"])
    assert len(second["rows"]) == 51 and not second["has_more"]
    assert not {r["path"] for r in first["rows"]}.intersection(r["path"] for r in second["rows"])
    assert store.query("alice", ident, mode="search", search="f-00")["total"] == 10
    assert store.query("alice", ident, mode="extension", extension=".TXT")["total"] == 251
    assert store.query("alice", ident, mode="largest", limit=1)["rows"][0]["logical_size"] == 250
    selected = store.query("alice", ident, mode="item", path=str(root / "f-005.txt"))["rows"][0]
    assert selected["file_identity"] == "fixture:f-005.txt" and selected["evidence_only"]
    assert len(json.dumps(first).encode()) < 1024**2
    assert summary["atomic_snapshot"] is False


def test_owner_and_path_boundaries_and_sql_sort_whitelist(tmp_path):
    store = StorageInventory(tmp_path / "indexes")
    root = tmp_path / "scope"
    ident, _ = publish(store, root, [row(root / "file.txt")])
    with pytest.raises(InventoryNotFound):
        store.query("bob", ident)
    with pytest.raises(InventoryNotFound):
        store.summary("alice", "../other")
    for mode in ("children", "item"):
        with pytest.raises(InventoryInvalid):
            store.query("alice", ident, mode=mode, path=str(root / ".." / "secret"))
    with pytest.raises(InventoryInvalid):
        store.query("alice", ident, sort="size; DROP TABLE items")
    with pytest.raises(InventoryNotFound):
        store.query("alice", ident, path=str(root / "unobserved"))
    with pytest.raises(InventoryNotFound):
        store.query("alice", ident, path=str(root / "file.txt"))
    writer = store.begin("alice", str(root))
    with pytest.raises(InventoryInvalid):
        writer.add_rows([row(tmp_path / "outside")])
    with pytest.raises(InventoryInvalid):
        writer.add_rows([row(root / "child", parent_path=str(tmp_path))])
    writer.abort()
    assert store.query("alice", ident)["total"] == 1


def test_partial_coverage_unknown_allocation_and_exclusions_remain_explicit(tmp_path, monkeypatch):
    root = tmp_path / "scope"
    root.mkdir()
    (root / "excluded").mkdir()
    (root / "excluded" / "hidden.txt").write_bytes(b"hidden")
    (root / "normal.txt").write_bytes(b"normal")
    monkeypatch.setattr(scan, "_allocated_size", lambda p, info: None)
    store = StorageInventory(tmp_path / "indexes")
    writer = store.begin("alice", str(root))
    _, _, meta = scan._scan_tree(root, noisy_names={"excluded"}, inventory_sink=lambda r: writer.add_rows([r]))
    summary = writer.finalize(meta)
    assert not summary["acquisition_complete"] and summary["excluded_entries"] == 1
    assert summary["allocation_unknown"] == 1 and summary["allocated_known_bytes"] == 0
    excluded = store.query("alice", writer.scan_id, mode="item", path=str(root / "excluded"))["rows"][0]
    assert excluded["children_state"] == "partial" and not excluded["children_complete"]
    assert excluded["excluded"] and excluded["protected"]


def test_depth_and_entry_limits_cannot_claim_complete_inventory(tmp_path):
    root = tmp_path / "scope"
    root.mkdir()
    (root / "nested").mkdir()
    (root / "nested" / "below.txt").write_bytes(b"x")
    store = StorageInventory(tmp_path / "indexes")
    writer = store.begin("alice", str(root))
    _, _, meta = scan._scan_tree(root, max_depth=0, inventory_sink=lambda r: writer.add_rows([r]))
    summary = writer.finalize(meta)
    assert not summary["acquisition_complete"] and summary["coverage"]["depth_limited"] == 1
    directory = store.query("alice", writer.scan_id)["rows"][0]
    assert directory["child_count"] == 0 and directory["children_state"] == "partial"


def test_sink_failure_is_not_swallowed_as_a_filesystem_permission_failure(tmp_path):
    (tmp_path / "file.txt").write_text("data")
    def failed_sink(value):
        raise RuntimeError("Inventory transport unavailable")
    with pytest.raises(RuntimeError, match="Inventory transport unavailable"):
        scan._scan_tree(tmp_path, inventory_sink=failed_sink)


def test_staging_never_queryable_writer_can_cross_threads_and_abort_removes_files(tmp_path):
    store = StorageInventory(tmp_path / "indexes")
    root = tmp_path / "scope"
    writer = store.begin("alice", str(root))
    with pytest.raises(InventoryNotFound):
        store.summary("alice", writer.scan_id)
    errors = []
    def add():
        try:
            writer.add_rows([row(root, kind="directory"), row(root / "file.txt")])
        except Exception as exc:
            errors.append(exc)
    thread = threading.Thread(target=add)
    thread.start()
    thread.join()
    assert not errors
    assert writer.finalize({})["indexed_files"] == 1
    interrupted = store.begin("alice", str(root))
    interrupted.add_rows([row(root, kind="directory")])
    staged_path = interrupted.path
    interrupted.abort()
    assert not staged_path.exists()


def test_disk_quota_and_cancelled_finalize_are_explicit_and_recoverable(tmp_path):
    store = StorageInventory(tmp_path / "indexes", max_scan_bytes=96 * 1024)
    root = tmp_path / "scope"
    writer = store.begin("alice", str(root))
    with pytest.raises(InventoryLimit):
        writer.add_rows(row(root / (str(n) + "x" * 180)) for n in range(1000))
    writer.abort()
    assert not writer.path.exists()
    writer = store.begin("alice", str(root))
    writer.add_rows([row(root, kind="directory"), row(root / "file")])
    def cancel():
        raise RuntimeError("cancelled by owner")
    with pytest.raises(RuntimeError, match="cancelled by owner"):
        writer.finalize({}, checkpoint=cancel)
    assert not writer.path.exists()
    with pytest.raises(InventoryNotFound):
        store.summary("alice", writer.scan_id)


def test_expiration_recovery_and_delete_remove_derived_evidence(tmp_path):
    store = StorageInventory(tmp_path / "indexes", ttl_seconds=10)
    root = tmp_path / "scope"
    ident, _ = publish(store, root, [row(root / "file")])
    path = store._filename("alice", ident)
    os.utime(path, (time.time() - 30, time.time() - 30))
    with pytest.raises(InventoryNotFound):
        store.summary("alice", ident)
    assert not path.exists()
    staged = store._owner_dir("alice") / ("a" * 32 + ".building")
    staged.write_bytes(b"interrupted")
    os.utime(staged, (time.time() - 4000, time.time() - 4000))
    store.prune()
    assert not staged.exists()
    crashed = store._owner_dir("alice") / ("b" * 32 + ".building")
    crashed.write_bytes(b"crashed")
    StorageInventory(store.directory)
    assert not crashed.exists()
    live = store.begin("alice", str(root))
    os.utime(live.path, (time.time() - 4000, time.time() - 4000))
    StorageInventory(store.directory).prune()
    assert live.path.exists()
    live.abort()
    ident, _ = publish(store, root, [])
    store.delete("alice", ident)
    with pytest.raises(InventoryNotFound):
        store.summary("alice", ident)


def test_stable_identity_comparison_uses_index_and_withholds_folder_deltas(tmp_path):
    root = tmp_path / "scope"
    store = StorageInventory(tmp_path / "indexes")
    before, _ = publish(store, root, [row(root / "before.bin", identity="vol:123", size=10)])
    after, _ = publish(store, root, [row(root / "after.bin", identity="vol:123", size=25)])
    comparison = store.compare("alice", before, after)
    assert comparison["comparable"] and comparison["changes"][0]["logical_delta"] == 15
    assert comparison["acquisition_complete"] and not comparison["complete"]
    assert comparison["comparison_scope"] == "matched_file_identities" and not comparison["added_removed_supported"]
    assert not comparison["results_limited"]
    assert comparison["changes"][0]["previous_path"] == str(root / "before.bin")
    assert not comparison["folder_deltas_supported"] and not comparison["atomic_snapshot"]
    partial, _ = publish(store, root, [row(root / "after.bin", identity="vol:123", size=25)], meta={"partial": True})
    assert "incomplete_acquisition" in store.compare("alice", before, partial)["reasons"]
    with pytest.raises(InventoryNotFound):
        store.compare("bob", before, after)
    foreign, _ = publish(store, root, [row(root / "foreign.bin", identity="vol:123", size=50,
                                         volume_identity="different-volume")])
    comparison = store.compare("alice", before, foreign)
    assert not comparison["comparable"] and not comparison["complete"]
    assert comparison["changes"] == [] and "volume_identity_differs" in comparison["reasons"]


def test_invalid_protocol_types_and_lost_rows_cannot_publish_complete_index(tmp_path):
    root = tmp_path / "scope"
    store = StorageInventory(tmp_path / "indexes")
    writer = store.begin("alice", str(root))
    for invalid in (row(root / "file", size_known="false"),
                    row(root / "file", logical_size=True),
                    row(root / "file", size_known=False, size_partial=False),
                    row(root / "file", allocated_size=None, allocated_partial=False),
                    row(root / "file", root_path=str(tmp_path / "another"))):
        with pytest.raises(InventoryInvalid):
            writer.add_rows([invalid])
    writer.add_rows([row(root, kind="directory"), row(root / "file")])
    for bad in ({"entries_seen": True}, {"partial": "false"}):
        with pytest.raises(InventoryInvalid):
            writer.finalize(bad)
    with pytest.raises(InventoryInvalid, match="row count"):
        writer.finalize({"inventory_rows_emitted": 3})
    assert not writer.path.exists()
    with pytest.raises(InventoryNotFound):
        store.summary("alice", writer.scan_id)


def test_changed_aliases_and_missing_parents_preserve_incomplete_evidence(tmp_path):
    store = StorageInventory(tmp_path / "indexes")
    root = tmp_path / "scope"
    ident, summary = publish(store, root, [row(root / "a.bin", identity="live:123", size=10),
                                         row(root / "z.bin", identity="live:123", size=15)])
    assert not summary["acquisition_complete"] and summary["identity_conflicts"] == 1
    assert store.query("alice", ident)["total"] == 2
    _, summary = publish(store, root, [row(root / "unseen-parent" / "file")])
    assert not summary["acquisition_complete"] and summary["orphaned_entries"] == 1
    before, _ = publish(store, root, [row(root / "file")], meta={"volume_observation": {"status": "known", "fingerprint": "one"}})
    after, summary = publish(store, root, [row(root / "file")], meta={"volume_observation": {"status": "changed", "fingerprint": "two"}})
    assert not summary["acquisition_complete"]
    comparison = store.compare("alice", before, after)
    assert "volume_observation_differs" in comparison["reasons"] and not comparison["complete"]


def test_failed_schema_initialization_closes_database_before_unlink(tmp_path, monkeypatch):
    connections = []
    class FailingSchema(sqlite3.Connection):
        closed = False
        def executescript(self, value):
            raise sqlite3.OperationalError("fixture disk full")
        def close(self):
            self.closed = True
            super().close()
    def connection(path, **options):
        value = sqlite3.connect(path, factory=FailingSchema)
        connections.append(value)
        return value
    store = StorageInventory(tmp_path / "indexes")
    with monkeypatch.context() as patch:
        patch.setattr(inventory_module, "_connect", connection)
        with pytest.raises(InventoryLimit):
            store.begin("alice", str(tmp_path / "scope"))
    assert connections[0].closed
    assert not list(store._files())
    writer = store.begin("alice", str(tmp_path / "scope"))
    writer.abort()


def test_failed_connection_configuration_closes_the_open_connection(tmp_path, monkeypatch):
    connections = []
    real_connect = sqlite3.connect
    class FailingPragma(sqlite3.Connection):
        closed = False
        def execute(self, sql, *args):
            if sql.startswith("PRAGMA"):
                raise sqlite3.OperationalError("fixture resource failure")
            return super().execute(sql, *args)
        def close(self):
            self.closed = True
            super().close()
    def connection(*args, **kwargs):
        value = real_connect(*args, **kwargs, factory=FailingPragma)
        connections.append(value)
        return value
    store = StorageInventory(tmp_path / "indexes")
    monkeypatch.setattr(sqlite3, "connect", connection)
    with pytest.raises(InventoryLimit):
        store.begin("alice", str(tmp_path / "scope"))
    assert connections[0].closed and not list(store._files())


def test_comparison_response_byte_bound_and_matching_only_semantics(tmp_path):
    root = tmp_path / "scope"
    store = StorageInventory(tmp_path / "indexes")
    # Names are fixture evidence only, never opened as filesystem paths.
    entries = [row(root / (str(n) + "\u754c" * 1800), identity=f"v:{n}", size=10) for n in range(100)]
    before, _ = publish(store, root, entries)
    after, _ = publish(store, root, [{**value, "logical_size": 11} for value in entries])
    compared = store.compare("alice", before, after, limit=100)
    assert compared["results_limited"] and 0 < len(compared["changes"]) < 100
    assert len(json.dumps(compared).encode()) < 1024 * 1024
    assert not compared["changes_complete"] and not compared["added_removed_supported"]


def test_reused_identity_with_different_birth_time_is_not_a_matched_file_change(tmp_path):
    root = tmp_path / "scope"
    store = StorageInventory(tmp_path / "indexes")
    before, _ = publish(store, root, [row(root / "file", identity="volume:123", size=12,
                                         created_at="2026-10-12T00:00:00Z")])
    after, _ = publish(store, root, [row(root / "file", identity="volume:123", size=20,
                                        created_at="2026-10-14T00:00:00Z")])
    assert store.compare("alice", before, after)["changes"] == []


def test_sqlite_ingestion_checkpoint_interrupts_and_removes_staging(tmp_path):
    root = tmp_path / "scope"
    store = StorageInventory(tmp_path / "indexes")
    writer = store.begin("alice", str(root))
    interrupted_inside_sqlite = []
    def checkpoint():
        # The explicit before/after batch callbacks run outside a transaction.
        # This proves the VM progress handler can interrupt actual ingestion.
        if writer.conn.in_transaction:
            interrupted_inside_sqlite.append(True)
            raise ValueError("session revoked during database ingestion")
    with pytest.raises(ValueError, match="session revoked"):
        writer.add_rows((row(root / f"file-{n}.txt") for n in range(128)), checkpoint=checkpoint)
    assert interrupted_inside_sqlite and writer._closed
    assert not writer.path.exists() and not Path(str(writer.path) + "-journal").exists()
    with pytest.raises(InventoryNotFound):
        store.summary("alice", writer.scan_id)


def test_post_batch_revocation_discards_already_committed_staging(tmp_path, monkeypatch):
    root = tmp_path / "scope"
    store = StorageInventory(tmp_path / "indexes")
    writer = store.begin("alice", str(root))
    revoked = threading.Event()
    real_insert = writer._insert
    def insert(rows):
        real_insert(rows)
        revoked.set()
    monkeypatch.setattr(writer, "_insert", insert)
    def checkpoint():
        if revoked.is_set():
            raise ValueError("session revoked after batch")
    with pytest.raises(ValueError, match="session revoked after batch"):
        writer.add_rows([row(root / "file")], checkpoint=checkpoint)
    assert writer._closed and not writer.path.exists()


def test_corrupt_or_expired_metadata_closes_read_handle(tmp_path):
    root = tmp_path / "scope"
    store = StorageInventory(tmp_path / "indexes")
    ident, summary = publish(store, root, [row(root / "file")])
    path = store._filename("alice", ident)
    conn = sqlite3.connect(path)
    conn.execute("UPDATE metadata SET value=? WHERE key='summary'", (json.dumps({"schema_version": 1}),))
    conn.commit()
    conn.close()
    with pytest.raises(InventoryNotFound):
        store.query("alice", ident)
    store.delete("alice", ident)  # Windows fails this unlink if a reader leaked.
    assert not path.exists()
    ident, summary = publish(store, root, [])
    path = store._filename("alice", ident)
    summary["expires_at"] = time.time() - 1
    conn = sqlite3.connect(path)
    conn.execute("UPDATE metadata SET value=? WHERE key='summary'", (json.dumps(summary),))
    conn.commit()
    conn.close()
    with pytest.raises(InventoryNotFound):
        store.summary("alice", ident)
    assert not path.exists()
