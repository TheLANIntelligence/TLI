"""Engine capability selection must not trigger privileged probes."""
import pytest

import storage_engines as engines
from storage_ntfs import NtfsError
from storage_ntfs_windows import canonical_volume


def test_native_gate_is_explicit_and_has_no_environment_override(monkeypatch):
    monkeypatch.setenv("TLI_ENABLE_NTFS", "1")
    capability = engines.native_capability("R:\\", platform_name="nt")
    assert not capability["available"] and capability["reason"] == "unvalidated_native_engine"
    assert not capability["filesystem_probed"]
    assert engines.native_capability("R:\\fixture", platform_name="nt")["reason"] == "native_requires_volume_scope"
    assert engines.native_capability("\\\\server\\share\\", platform_name="nt")["reason"] == "not_local_drive_path"
    assert engines.native_capability("/tmp", platform_name="posix")["reason"] == "platform_not_windows"
    assert engines.select_engine("R:\\", "ntfs").name == "scandir"
    with pytest.raises(ValueError):
        engines.select_engine("R:\\", "unknown")


def test_directory_adapter_preserves_contract_and_inventory_sink(tmp_path, monkeypatch):
    import storage_scan_algorithms as algorithms
    calls = []
    sink = object()
    def scan(root, **kwargs):
        calls.append((root, kwargs))
        return {"name": "root"}, [], {"scanner": {"allocation_method": "existing"}}
    monkeypatch.setattr(algorithms, "_scan_tree", scan)
    selected = engines.select_engine(tmp_path, "scandir")
    tree, largest, meta = selected.scan(tmp_path, max_entries=123, inventory_sink=sink)
    assert calls == [(tmp_path, {"max_entries": 123, "inventory_sink": sink})]
    assert meta["scanner"]["engine"] == "scandir" and meta["scanner"]["mft"] is False
    assert meta["scanner"]["allocation_method"] == "existing"
    assert meta["scanner"]["fallback_reason"] is None


@pytest.mark.parametrize("value", ["R:", "R:\\folder", "\\\\.\\R:", "\\\\server\\share\\", "/", "C:\\..\\", "é:\\"])
def test_raw_probe_only_accepts_explicit_ascii_drive_root(value):
    with pytest.raises(NtfsError, match="explicit_drive_root_required"):
        canonical_volume(value)


def test_drive_root_normalization():
    assert canonical_volume("r:/") == "R:\\"
