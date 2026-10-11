"""Free Space metadata checks using only temporary or synthetic inventories."""
from pathlib import Path
from types import SimpleNamespace
import os

import pytest

import storage_scan_algorithms as scan
import storage_scan_worker as worker
import storage_jobs as jobs


@pytest.fixture(autouse=True)
def local_scanner(monkeypatch):
    monkeypatch.setattr(scan, "CONTROL", None)


def test_recursive_metadata_categories_and_allocation_are_independent(tmp_path, monkeypatch):
    folder = tmp_path / "models"
    folder.mkdir()
    (folder / "model.GGUF").write_bytes(b"model")
    (tmp_path / "notes.txt").write_bytes(b"notes!!")
    monkeypatch.setattr(scan, "_allocated_size", lambda path, info: 4096)
    tree, largest, meta = scan._scan_tree(tmp_path)
    assert tree["size"] == 12 and tree["allocated_size"] == 8192 and tree["files"] == 2
    assert tree["allocated_partial"] is False
    model = next(row for row in largest if row["name"] == "model.GGUF")
    assert model["extension"] == ".gguf" and model["category"] == "models"
    assert model["modified_at"].endswith("Z")
    assert model["size"] == model["logical_size"] == 5
    assert sum(row["bytes"] for row in meta["categories"]) == 12
    assert meta["file_summary_complete"] is True
    assert len(meta["file_summary"]) == 2
    assert all(not Path(row["path"]).is_absolute() for row in meta["file_summary"])
    assert meta["scanner"]["mft"] is False and meta["scanner"]["engine"] == "scandir"


def test_unknown_allocation_is_not_substituted_with_logical_size(tmp_path, monkeypatch):
    (tmp_path / "known").write_bytes(b"a" * 10)
    (tmp_path / "unknown").write_bytes(b"b" * 20)
    monkeypatch.setattr(scan, "_allocated_size", lambda path, info: 4096 if path.name == "known" else None)
    tree, _, meta = scan._scan_tree(tmp_path)
    assert tree["size"] == 30
    assert tree["allocated_size"] is None and tree["allocated_known_bytes"] == 4096
    assert tree["allocated_partial"] is True
    assert meta["partial"] is False and meta["allocation_unknown"] == 1


def test_unknown_identity_cannot_claim_complete_deduplicated_storage(tmp_path, monkeypatch):
    (tmp_path / "first.bin").write_bytes(b"a" * 12)
    original = scan._entry_info
    def without_identity(entry):
        info = original(entry)
        return SimpleNamespace(st_size=info.st_size, st_ino=0, st_dev=info.st_dev,
                               st_mode=info.st_mode, st_mtime=info.st_mtime)
    monkeypatch.setattr(scan, "_entry_info", without_identity)
    monkeypatch.setattr(scan, "_allocated_size", lambda path, info: 4096)
    tree, _, meta = scan._scan_tree(tmp_path)
    assert tree["size"] == 12 and tree["allocated_known_bytes"] == 0
    assert tree["size_partial"] and tree["allocated_size"] is None
    assert meta["identity_unknown"] == 1 and meta["partial"]
    assert not meta["file_summary_complete"]


def test_hard_links_count_once_but_retain_alias_length(tmp_path, monkeypatch):
    source = tmp_path / "source.bin"
    source.write_bytes(b"a" * 123)
    alias = tmp_path / "alias.bin"
    try:
        alias.hardlink_to(source)
    except OSError:
        pytest.skip("Hard links unavailable")
    monkeypatch.setattr(scan, "_allocated_size", lambda path, info: 4096)
    tree, largest, meta = scan._scan_tree(tmp_path)
    assert tree["size"] == 123 and tree["allocated_size"] == 4096
    assert tree["files"] == 2 and meta["hardlinks_skipped"] == 1
    alias_node = next(row for row in tree["children"] if row["hardlink_duplicate"])
    assert alias_node["size"] == 0 and alias_node["allocated_size"] == 0
    assert alias_node["logical_size"] == 123
    assert len(largest) == 1
    files, info = scan._collect_large_files(tmp_path, min_bytes=1, limit=10)
    assert len(files) == 1 and info["hardlinks_skipped"] == 1


def test_reparse_points_are_skipped_even_if_not_junction_or_symlink(tmp_path, monkeypatch):
    linked = tmp_path / "cloud-reparse"
    linked.mkdir()
    (linked / "outside.bin").write_bytes(b"not read")
    original = scan._entry_info
    monkeypatch.setattr(scan, "_entry_info", lambda entry: SimpleNamespace(st_file_attributes=0x400)
                        if entry.name == linked.name else original(entry))
    tree, _, meta = scan._scan_tree(tmp_path)
    assert tree["size"] == 0 and meta["files"] == 0
    assert meta["skipped"] == 1 and meta["partial"] is True
    assert tree["allocated_size"] is None


def test_summary_cap_does_not_truncate_accounting(tmp_path, monkeypatch):
    for index in range(510):
        (tmp_path / f"file-{index:04}.bin").write_bytes(b"sample")
    monkeypatch.setattr(scan, "_allocated_size", lambda path, info: 4096)
    tree, _, meta = scan._scan_tree(tmp_path, max_nodes=4)
    assert tree["size"] == 3060 and tree["allocated_size"] == 510 * 4096
    assert len(meta["file_summary"]) == 500 and meta["file_summary_complete"] is False
    assert meta["partial"] is False and meta["representation_limited"] is True
    assert tree["allocated_size"] == sum(row["allocated_size"] for row in tree["children"]) + tree["omitted_allocated_known_bytes"]


def test_partial_hash_reduces_candidates_without_proving_duplicates(tmp_path, monkeypatch):
    for name, content in [("a", b"a" * 200000), ("b", b"a" * 200000), ("c", b"b" * 200000)]:
        (tmp_path / name).write_bytes(content)
    original = scan._hash_duplicate_file
    hashed = []
    def full(path, signature, deadline):
        hashed.append(path.name)
        return original(path, signature, deadline)
    monkeypatch.setattr(scan, "_hash_duplicate_file", full)
    groups, meta = scan._find_duplicates(tmp_path)
    assert set(hashed) == {"a", "b"}
    assert meta["files_sampled"] == 3 and meta["files_hashed"] == 2
    assert groups[0]["verified"] is True and groups[0]["count"] == 2
    assert meta["verification"] == "full_sha256"


def test_capacity_is_volume_scope_and_unavailable_is_unknown(tmp_path, monkeypatch):
    monkeypatch.setattr(worker.shutil, "disk_usage", lambda _: SimpleNamespace(total=1000, used=750, free=250))
    result = worker.capacity(tmp_path)
    assert result["status"] == "known" and result["free"] == 250
    assert result["root_is_volume"] is False and result["scope"] == "containing_volume"
    def denied(_):
        raise PermissionError("synthetic denied volume")
    monkeypatch.setattr(worker.shutil, "disk_usage", denied)
    assert worker.capacity(tmp_path)["free"] is None
    assert worker.capacity(tmp_path)["status"] == "unknown"


@pytest.mark.parametrize("path", ["D:/Windows/System32/a.dll", "E:/Program Files/tool/file", "F:/pagefile.sys", "D:/EFI/Boot/file", "G:/ProgramData/service/data"])
def test_windows_protection_applies_to_other_volumes(path, monkeypatch):
    monkeypatch.setattr(scan.platform, "system", lambda: "Windows")
    assert scan.is_protected(path)
    assert not scan.is_protected("D:/Users/Me/Windows notes.txt")


def test_nonstandard_windows_directory_is_protected(monkeypatch):
    monkeypatch.setattr(scan.platform, "system", lambda: "Windows")
    monkeypatch.setenv("SystemRoot", "Z:/OperatingSystem")
    assert scan.is_protected("Z:/OperatingSystem/System32/a.dll")


def test_worker_metadata_validation_rejects_escape_and_invalid_allocation(tmp_path):
    (tmp_path / "one.txt").write_bytes(b"one")
    tree, largest, meta = scan._scan_tree(tmp_path)
    frame = {"result": {"tree": tree, "largest": largest, "meta": meta},
             "identity": {"before": {"status": "unknown"}, "after": {"status": "unknown"}}}
    assert jobs._validate_result("scan", frame) is frame["result"]
    meta["file_summary"][0]["path"] = "../outside.txt"
    with pytest.raises(ValueError, match="relative"):
        jobs._validate_result("scan", frame)
    meta["file_summary"][0]["path"] = "one.txt"
    tree["allocated_size"] = -1
    with pytest.raises(ValueError, match="metadata"):
        jobs._validate_result("scan", frame)


@pytest.mark.skipif(os.name != "nt", reason="Windows supported allocation API")
def test_windows_sparse_allocation_uses_filesystem_bytes(tmp_path):
    import ctypes
    import msvcrt
    from ctypes import wintypes
    path = tmp_path / "sparse.bin"
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.DeviceIoControl.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
                                     ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    kernel.DeviceIoControl.restype = wintypes.BOOL
    with path.open("wb") as stream:
        returned = wintypes.DWORD()
        if not kernel.DeviceIoControl(msvcrt.get_osfhandle(stream.fileno()), 0x900C4, None, 0, None, 0, ctypes.byref(returned), None):
            pytest.skip("Temporary filesystem does not support sparse files")
        stream.seek(8 * 1024 * 1024)
        stream.write(b"x")
    info = path.stat()
    allocated = scan._allocated_size(path, info)
    assert allocated is not None and 0 < allocated < info.st_size
    tree, _, meta = scan._scan_tree(tmp_path)
    assert tree["size"] == info.st_size and tree["allocated_size"] == allocated
    assert not meta["partial"]
