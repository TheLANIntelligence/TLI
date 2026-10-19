"""Bounded traversal regressions using synthetic metadata, never a host drive scan."""
from pathlib import Path
import stat
from types import SimpleNamespace

import pytest

import storage_scan_algorithms as scan


def synthetic_tree(monkeypatch, root, contents, *, before_entry=None):
    directories, opened, closed, consumed = {}, [], [], []
    next_identity = 100

    def populate(parent, values):
        nonlocal next_identity
        entries = []
        for name, value in values.items():
            path = parent / name
            directory = isinstance(value, dict)
            next_identity += 1
            size, identity = (0, next_identity) if directory else (
                value if isinstance(value, tuple) else (value, next_identity))
            info = SimpleNamespace(st_size=size, st_ino=identity, st_dev=1,
                                   st_mode=stat.S_IFDIR if directory else stat.S_IFREG,
                                   st_mtime=0, st_nlink=1)
            entries.append(SimpleNamespace(
                name=name, path=str(path), is_symlink=lambda: False,
                is_dir=lambda directory=directory, **_: directory,
                stat=lambda info=info, **_: info))
            if directory:
                populate(path, value)
        directories[str(parent)] = entries

    populate(root, contents)

    class Iterator:
        def __init__(self, path):
            self.path = str(path)
            opened.append(self.path)

        def __iter__(self):
            for entry in directories[self.path]:
                consumed.append(entry.path)
                if before_entry:
                    before_entry(entry)
                yield entry

        def close(self):
            closed.append(self.path)

    monkeypatch.setattr(scan.os, "scandir", Iterator)
    monkeypatch.setattr(scan, "CONTROL", None)
    monkeypatch.setattr(scan, "is_protected", lambda _: False)
    monkeypatch.setattr(scan, "_allocated_size", lambda _, info: info.st_size)
    monkeypatch.setattr(Path, "is_junction", lambda _: False, raising=False)
    return opened, closed, consumed


def assert_inventory_bound(rows, meta):
    assert len(rows) == meta["inventory_rows_emitted"] == meta["entries_seen"] + 1
    assert len({row["path"] for row in rows}) == len(rows)


def test_root_avi_is_observed_before_early_subtree_exhausts_entry_budget(monkeypatch, tmp_path):
    opened, closed, _ = synthetic_tree(monkeypatch, tmp_path, {
        "First folder": {f"small-{n}.wav": 7 for n in range(20)},
        "Later folder": {"unvisited.avi": 3000},
        "Effect Palette.avi": 16000,
    })
    rows = []
    tree, largest, meta = scan._scan_tree(tmp_path, max_entries=7, inventory_sink=rows.append)

    assert largest[0]["name"] == "Effect Palette.avi"
    assert meta["direct_file_bytes"] == 16000
    assert tree["size"] == 16028
    assert meta["files"] == 5 and meta["entries_seen"] == 7
    assert meta["entry_limited"] and meta["partial"]
    assert rows[0]["name"] == "Effect Palette.avi"
    unvisited = next(row for row in rows if row["name"] == "Later folder")
    assert unvisited["size_known"] is False and unvisited["size_reason"] == "entry_limit"
    assert str(tmp_path / "Later folder") not in opened
    assert sorted(opened) == sorted(closed)
    assert_inventory_bound(rows, meta)


def test_root_files_survive_subtree_time_limit_and_parent_handle_closes_first(monkeypatch, tmp_path):
    clock = [0]

    def expire_in_child(entry):
        if Path(entry.path).parent == tmp_path / "First":
            clock[0] = 16

    opened, closed, _ = synthetic_tree(monkeypatch, tmp_path, {
        "First": {"small.wav": 7}, "Later": {"unvisited.avi": 3000},
        "Titling Explained Deeper.avi": 20000,
    }, before_entry=expire_in_child)
    monkeypatch.setattr(scan.time, "monotonic", lambda: clock[0])
    rows = []
    tree, largest, meta = scan._scan_tree(tmp_path, inventory_sink=rows.append)

    assert tree["size"] == meta["direct_file_bytes"] == 20000
    assert largest[0]["name"] == "Titling Explained Deeper.avi"
    assert meta["time_limited"] and meta["partial"]
    assert closed == opened  # Parent iterator closes before any child iterator.
    assert str(tmp_path / "Later") not in opened
    assert next(row for row in rows if row["name"] == "Later")["size_reason"] == "time_limit"
    assert_inventory_bound(rows, meta)


def test_cancelled_queue_keeps_observed_root_file_and_unknown_directory_rows(monkeypatch, tmp_path):
    opened, closed, _ = synthetic_tree(monkeypatch, tmp_path, {
        "First": {"unvisited.bin": 3}, "Second": {"unvisited.bin": 4},
        "recording.avi": 5000,
    })

    def cancel_after_root_file(**progress):
        if progress.get("files", 0) >= 1:
            raise scan.ScanCancelled()

    monkeypatch.setattr(scan, "CONTROL", cancel_after_root_file)
    rows = []
    tree, _, meta = scan._scan_tree(tmp_path, inventory_sink=rows.append)
    assert tree["size"] == 5000 and meta["cancelled"] and meta["partial"]
    assert opened == closed == [str(tmp_path)]
    directories = [row for row in rows if row["path"] != str(tmp_path) and row["kind"] == "directory"]
    assert len(directories) == 2
    assert all(row["size_reason"] == "cancelled" and not row["size_known"] for row in directories)
    assert_inventory_bound(rows, meta)


def test_directory_queue_cannot_bypass_entry_budget(monkeypatch, tmp_path):
    opened, closed, consumed = synthetic_tree(monkeypatch, tmp_path, {
        **{f"folder-{n}": {"unvisited.bin": 1} for n in range(10)}, "late.avi": 1000,
    })
    rows = []
    tree, _, meta = scan._scan_tree(tmp_path, max_entries=3, inventory_sink=rows.append)
    assert meta["entries_seen"] == meta["dirs"] == 3
    assert len(consumed) == 4  # One iterator lookahead, no materialized listing.
    assert opened == closed == [str(tmp_path)]
    assert tree["size_known"] is True and tree["size_partial"] is True
    assert all(row["size_reason"] == "entry_limit" for row in rows[:-1])
    assert not any(row["name"] == "late.avi" for row in rows)
    assert_inventory_bound(rows, meta)


def test_direct_file_retention_is_independent_of_descendant_node_budget(monkeypatch, tmp_path):
    synthetic_tree(monkeypatch, tmp_path, {
        "First": {f"small-{n}.bin": 7 for n in range(20)}, "root.avi": 2000,
    })
    rows = []
    tree, _, meta = scan._scan_tree(tmp_path, max_nodes=2, inventory_sink=rows.append)
    assert [row["name"] for row in tree["children"]] == ["root.avi"]
    assert tree["size"] == 2140 and tree["omitted_bytes"] == 140
    assert meta["representation_limited"] and not meta["partial"]
    assert_inventory_bound(rows, meta)


def test_depth_limit_still_includes_direct_files_and_unknown_queued_folders(monkeypatch, tmp_path):
    synthetic_tree(monkeypatch, tmp_path, {"First": {"deep.avi": 1000}, "root.avi": 2000})
    rows = []
    tree, _, meta = scan._scan_tree(tmp_path, max_depth=0, inventory_sink=rows.append)
    assert tree["size"] == 2000
    assert meta["depth_limited"] == 1 and meta["partial"]
    assert next(row for row in rows if row["name"] == "First")["size_reason"] == "depth_limit"
    assert_inventory_bound(rows, meta)


def test_file_first_hardlinks_keep_actual_inventory_bytes_and_count_once(monkeypatch, tmp_path):
    synthetic_tree(monkeypatch, tmp_path, {"First": {"alias.avi": (2000, 42)}, "root.avi": (2000, 42)})
    rows = []
    tree, _, meta = scan._scan_tree(tmp_path, inventory_sink=rows.append)
    assert tree["size"] == tree["allocated_size"] == 2000
    assert meta["hardlinks_skipped"] == 1 and not meta["partial"]
    files = [row for row in rows if row["kind"] == "file"]
    assert [row["name"] for row in files] == ["root.avi", "alias.avi"]
    assert [row["size"] for row in files] == [2000, 0]
    assert all(row["logical_size"] == row["allocated_size"] == 2000 for row in files)
    assert_inventory_bound(rows, meta)


def test_transport_failure_while_emitting_deferred_directory_is_not_swallowed(monkeypatch, tmp_path):
    synthetic_tree(monkeypatch, tmp_path, {"First": {"deep.avi": 1000}, "root.avi": 2000})

    def fail_directory(row):
        if row["name"] == "First":
            raise RuntimeError("Synthetic inventory transport failure")

    with pytest.raises(RuntimeError, match="inventory transport failure"):
        scan._scan_tree(tmp_path, max_depth=0, inventory_sink=fail_directory)
