"""Representation only: synthetic directory entries, no household filesystem scan."""
from types import SimpleNamespace
import ntpath

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
                              stat=lambda **_: SimpleNamespace(st_size=10)) for name in names]
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
                              stat=lambda **_: SimpleNamespace(st_size=7)) for i in range(80)]
    monkeypatch.setattr(algorithms.os, "scandir", lambda _: Entries(entries))
    monkeypatch.setattr(algorithms, "is_protected", lambda _: False)
    tree, _, meta = algorithms._scan_tree(tmp_path, max_nodes=10)
    assert len(tree["children"]) == 9
    assert meta["representation_limited"] is True
    assert tree["omitted_entries"] == 71
    assert tree["size"] == 560
    assert tree["omitted_bytes"] + sum(row["size"] for row in tree["children"]) == 560
