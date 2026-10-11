"""Representation only: synthetic directory entries, no household filesystem scan."""
from types import SimpleNamespace
import ntpath
from pathlib import Path

import pytest

import storage_scan_algorithms as algorithms


class Entries:
    def __init__(self, values):
        self.values = values

    def __iter__(self):
        return iter(self.values)

    def close(self):
        pass


@pytest.mark.parametrize("reserved_name", ["__MORE__", "__more__", "__MoRe__"])
def test_collapsed_children_preserve_bytes_mark_representation_and_never_impersonate_real_path(monkeypatch, tmp_path, reserved_name):
    # Exercise Windows identity on every test platform without touching real files.
    monkeypatch.setattr(algorithms.os.path, "normcase", ntpath.normcase)
    names = [reserved_name] + [f"file-{i:04}.bin" for i in range(2600)]
    entries = [SimpleNamespace(name=name, path=str(tmp_path / name),
                              is_symlink=lambda: False, is_dir=lambda **_: False,
                              stat=lambda inode=index + 1, **_: SimpleNamespace(st_size=10, st_ino=inode, st_dev=1)) for index, name in enumerate(names)]
    monkeypatch.setattr(algorithms.os, "scandir", lambda _: Entries(entries))
    monkeypatch.setattr(algorithms, "is_protected", lambda _: False)
    tree, _, meta = algorithms._scan_tree(tmp_path, max_nodes=25000)
    assert meta["representation_limited"] is True
    assert meta["partial"] is False  # representation truncation is not a filesystem coverage failure
    assert tree["size"] == 26010 == sum(row["size"] for row in tree["children"])
    assert len(tree["children"]) == 2500
    grouped = [row for row in tree["children"] if row.get("synthetic")]
    assert len(grouped) == 1
    assert grouped[0]["collapsed_entries"] == 102
    assert grouped[0]["representation"] == "collapsed_children"
    assert grouped[0]["protected"] is True
    assert ntpath.normcase(grouped[0]["path"]) not in {ntpath.normcase(entry.path) for entry in entries}
    assert len({ntpath.normcase(row["path"]) for row in tree["children"]}) == 2500


def test_node_bound_exposes_omitted_bytes_separately_from_returned_children(monkeypatch, tmp_path):
    entries = [SimpleNamespace(name=str(i), path=str(tmp_path / str(i)),
                              is_symlink=lambda: False, is_dir=lambda **_: False,
                              stat=lambda inode=i + 1, **_: SimpleNamespace(st_size=7, st_ino=inode, st_dev=1)) for i in range(80)]
    monkeypatch.setattr(algorithms.os, "scandir", lambda _: Entries(entries))
    monkeypatch.setattr(algorithms, "is_protected", lambda _: False)
    tree, _, meta = algorithms._scan_tree(tmp_path, max_nodes=10)
    assert len(tree["children"]) == 9
    assert meta["representation_limited"] is True
    assert tree["omitted_entries"] == 71
    assert tree["size"] == 560
    assert tree["omitted_bytes"] + sum(row["size"] for row in tree["children"]) == 560


def fake_directories(monkeypatch, root, contents):
    """Enumerate ordered synthetic entries, with no filesystem metadata probes."""
    directories, opened, closed = {}, [], []

    def populate(parent, children):
        rows = []
        for name, value in children.items():
            path, directory = parent / name, isinstance(value, dict)

            def stat(size=value, inode=hash(str(path)) or 1, **kwargs):
                if size is None:
                    raise PermissionError("Synthetic inaccessible size")
                return SimpleNamespace(st_size=size, st_ino=inode, st_dev=1)

            rows.append(SimpleNamespace(
                name=name, path=str(path), is_symlink=lambda: False,
                is_dir=lambda directory=directory, **kwargs: directory, stat=stat))
            if directory:
                populate(path, value)
        directories[str(parent)] = rows

    populate(root, contents)

    class SyntheticEntries(Entries):
        def __init__(self, path):
            super().__init__(directories[str(path)])
            self.path = str(path)
            opened.append(self.path)

        def close(self):
            closed.append(self.path)

    monkeypatch.setattr(algorithms.os, "scandir", SyntheticEntries)
    monkeypatch.setattr(algorithms, "is_protected", lambda _: False)
    monkeypatch.setattr(Path, "is_junction", lambda _: False, raising=False)
    return opened, closed


def retained_nodes(tree):
    pending, rows = [tree], []
    while pending:
        node = pending.pop()
        rows.append(node)
        if "children" in node:
            assert node["size"] == node.get("omitted_bytes", 0) + sum(
                child["size"] for child in node["children"])
            for child in node["children"]:
                assert Path(child["path"]).parent == Path(node["path"])
            pending.extend(node["children"])
    assert len({row["path"] for row in rows}) == len(rows)
    return rows


def test_descendants_cannot_consume_their_parent_reservation(monkeypatch, tmp_path):
    opened, closed = fake_directories(monkeypatch, tmp_path, {
        "Many files": {f"file-{i}.bin": 7 for i in range(20)}, "later.bin": 7})
    tree, largest, meta = algorithms._scan_tree(tmp_path, max_nodes=10)

    assert tree["size"] == 147
    assert len(retained_nodes(tree)) == 10
    assert [row["name"] for row in tree["children"]] == ["Many files"]
    folder = tree["children"][0]
    assert len(folder["children"]) == 8
    assert folder["size"] == 140
    assert folder["omitted_bytes"] == 84
    assert folder["omitted_entries"] == 12
    assert tree["omitted_bytes"] == 7
    assert tree["omitted_entries"] == 1
    assert meta["representation_limited"] is True
    assert meta["partial"] is False
    assert meta["files"] == len(largest) == 21
    assert meta["folder_summary"] == [{
        "name": "Many files", "bytes": 140, "size_known": True, "size_partial": False}]
    assert sorted(opened) == sorted(closed)


@pytest.mark.parametrize("limit", [1, 2, 4, 10, 25])
def test_deep_node_limits_keep_an_unbroken_path_and_all_known_bytes(monkeypatch, tmp_path, limit):
    contents = {f"file-{i}.bin": i + 1 for i in range(20)}
    names = [f"level-{i}" for i in range(8)]
    for name in reversed(names):
        contents = {name: contents}
    fake_directories(monkeypatch, tmp_path, contents)

    tree, _, meta = algorithms._scan_tree(tmp_path, max_nodes=limit)
    assert tree["size"] == 210
    assert len(retained_nodes(tree)) == limit
    node = tree
    for name in names[:min(len(names), limit - 1)]:
        assert node["children"][0]["name"] == name
        node = node["children"][0]
        assert node["size"] == 210
    assert meta["files"] == 20  # Representation limits do not truncate inspection.
    assert meta["representation_limited"] is True
    assert meta["partial"] is False


def test_empty_directory_reservation_does_not_starve_later_folders(monkeypatch, tmp_path):
    fake_directories(monkeypatch, tmp_path, {
        "Empty": {}, "Useful": {"first.bin": 2, "second.bin": 3}, "later.bin": 4})
    tree, _, meta = algorithms._scan_tree(tmp_path, max_nodes=3)
    assert tree["size"] == 9
    assert len(retained_nodes(tree)) == 3
    assert [row["name"] for row in tree["children"]] == ["Useful"]
    assert tree["children"][0]["children"][0]["name"] == "first.bin"
    assert tree["children"][0]["omitted_bytes"] == 3
    assert meta["partial"] is False


def test_partial_unknown_sizes_remain_visible_after_node_budget_exhaustion(monkeypatch, tmp_path):
    fake_directories(monkeypatch, tmp_path, {
        "Folder": {"visible.bin": 7, "unreadable.bin": None, "omitted.bin": 11}})
    tree, _, meta = algorithms._scan_tree(tmp_path, max_nodes=3)
    assert len(retained_nodes(tree)) == 3
    assert tree["size"] == 18
    folder = tree["children"][0]
    assert folder["omitted_entries"] == 2
    assert folder["omitted_bytes"] == 11
    assert folder["size_partial"] is True
    assert tree["size_partial"] is True
    assert meta["denied"] == 1
    assert meta["partial"] is True


def test_cancellation_retains_bounded_ancestors_and_only_inspected_bytes(monkeypatch, tmp_path):
    opened, closed = fake_directories(monkeypatch, tmp_path, {
        "First": {"Second": {"Third": {f"file-{i}.bin": 7 for i in range(20)}}},
        "Unvisited": {"later.bin": 1000}})

    def cancel_after_four_files(**progress):
        if progress.get("files", 0) >= 4:
            raise algorithms.ScanCancelled()

    monkeypatch.setattr(algorithms, "CONTROL", cancel_after_four_files)
    tree, _, meta = algorithms._scan_tree(tmp_path, max_nodes=5)
    assert len(retained_nodes(tree)) == 5
    assert tree["size"] == 28
    assert tree["size_partial"] is True
    assert meta["cancelled"] is True
    assert meta["partial"] is True
    assert meta["files"] == 4
    assert str(tmp_path / "Unvisited") not in opened
    assert sorted(opened) == sorted(closed)
    node = tree
    for name in ["First", "Second", "Third"]:
        assert node["children"][0]["name"] == name
        node = node["children"][0]
        assert node["size"] == 28
    assert len(node["children"]) == 1
    assert node["omitted_bytes"] == 21
