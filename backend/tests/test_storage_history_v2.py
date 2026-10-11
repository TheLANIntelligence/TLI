"""Bounded, encrypted historical evidence and explicit retention maintenance."""
import json

from fastapi import HTTPException
import pytest

from intelligence import storage_history as history, store
import tli_state as S


DRIVE = {"status": "known", "fingerprint": "a" * 64, "detail": "Synthetic volume"}
FILTERS = {"excluded_names": [], "max_depth": 18, "max_entries": 50000,
           "max_seconds": 15, "follow_links": False}


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(S, "_get_mem_key", lambda: b"k" * 32)
    monkeypatch.setattr(S, "_store_key", lambda *args: b"k" * 32)
    monkeypatch.setattr(history, "_host", lambda: {"id": "test-host", "name": "Fixture"})
    monkeypatch.setattr(history, "_recent", {})
    return tmp_path


def capture(root, files, *, complete=True, allocated=None, used=200, volume=True, partial=False):
    size = sum(row["bytes"] for row in files)
    tree = {"size": size, "allocated_size": allocated}
    meta = {"partial": partial, "denied": int(partial), "folder_summary": [], "direct_file_bytes": size,
            "scan_filters": FILTERS, "file_summary": files, "file_summary_complete": complete,
            "capacity": {"total": 1000, "used": used, "free": 1000 - used, "root_is_volume": volume}}
    result = history.capture("alice", root, tree, meta, DRIVE, after=DRIVE)
    assert result["available"]
    return result


def file(path, size, **fields):
    return {"path": path, "bytes": size, "logical_size": size, "extension": ".bin", **fields}


def test_saved_comparisons_survive_recent_cache_and_never_probe_disk(isolated, monkeypatch):
    first = capture(isolated, [file("grow.bin", 10), file("old.bin", 5)], allocated=20)
    history.save("alice", first["scan_id"])
    second = capture(isolated, [file("grow.bin", 25), file("new.bin", 7)], allocated=40, used=250)
    saved = history.save("alice", second["scan_id"])
    assert "removed_ids" not in saved
    history._recent.clear()
    monkeypatch.setattr(history, "drive_identity", lambda _: pytest.fail("Comparison must not probe any path"))
    result = history.compare("alice", first["scan_id"], second["scan_id"])
    assert result["comparable"] and result["file_comparison"]["complete"]
    rows = {row["path"]: row for row in result["files"]}
    assert rows["grow.bin"]["delta_bytes"] == 15
    assert rows["new.bin"]["status"] == "added" and rows["old.bin"]["status"] == "removed"
    assert "rename" in result["file_comparison"]["reason"]
    capacity = result["capacity"]
    assert capacity["used_delta_bytes"] == capacity["free_space_lost_bytes"] == 50
    assert capacity["scanned_logical_delta_bytes"] == 17
    assert capacity["scanned_allocated_delta_bytes"] == 20
    assert capacity["unexplained_delta_bytes"] == 30
    with pytest.raises(HTTPException):
        history.compare("bob", first["scan_id"], second["scan_id"])


def test_bounded_inventory_never_treats_threshold_crossing_as_deletion(isolated):
    first = capture(isolated, [file("old.bin", 10)], complete=False)
    history.save("alice", first["scan_id"])
    second = capture(isolated, [file("new.bin", 20)], complete=False)
    result = history.compare("alice", first["scan_id"], second["scan_id"])
    assert result["file_comparison"]["available"] and not result["file_comparison"]["complete"]
    assert {row["status"] for row in result["files"]} == {"not_observed", "newly_observed"}
    assert all(row["delta_bytes"] is None for row in result["files"])


@pytest.mark.parametrize("volume,allocated", [(False, 100), (True, None)])
def test_logical_file_deltas_are_not_subtracted_from_capacity(isolated, volume, allocated):
    first = capture(isolated, [file("one.bin", 10)], volume=volume, allocated=allocated)
    history.save("alice", first["scan_id"])
    second = capture(isolated, [file("one.bin", 20)], volume=volume, allocated=allocated, used=300)
    result = history.compare("alice", first["scan_id"], second["scan_id"])
    assert result["capacity"]["used_delta_bytes"] == 100
    assert result["capacity"]["unexplained_delta_bytes"] is None


def test_incomplete_coverage_keeps_capacity_and_matching_path_evidence_without_totals(isolated):
    first = capture(isolated, [file("one.bin", 10)], allocated=10)
    history.save("alice", first["scan_id"])
    second = capture(isolated, [file("one.bin", 20)], allocated=20, partial=True, used=300)
    result = history.compare("alice", first["scan_id"], second["scan_id"])
    assert not result["comparable"] and result["totals"] is None and result["folders"] == []
    assert result["file_comparison"]["available"] and not result["file_comparison"]["complete"]
    assert [(row["path"], row["status"], row["delta_bytes"]) for row in result["files"]] == [("one.bin", "grew", 10)]
    assert result["capacity"]["used_delta_bytes"] == 100
    assert result["capacity"]["scanned_logical_delta_bytes"] is None
    assert result["capacity"]["unexplained_delta_bytes"] is None


def test_partial_file_evidence_never_infers_absence_or_uses_unreadable_zero_size(isolated):
    first = capture(isolated, [file("gone.bin", 10), file("unreadable.bin", 100), file("same.bin", 10)])
    history.save("alice", first["scan_id"])
    second = capture(isolated, [file("new.bin", 30), file("unreadable.bin", 0, size_known=False), file("same.bin", 10)], partial=True)
    result = history.compare("alice", first["scan_id"], second["scan_id"])
    assert not result["comparable"] and result["file_comparison"]["available"]
    assert result["files"] == []


@pytest.mark.parametrize("change", ["root", "host", "policy", "drive", "time"])
def test_partial_overlap_requires_compatible_identity_scope_policy_and_time(isolated, change):
    first = capture(isolated, [file("one.bin", 10)])
    history.save("alice", first["scan_id"])
    second = capture(isolated, [file("one.bin", 30)], partial=True)
    current = history._recent[second["scan_id"]]["snapshot"]
    if change == "root": current["root"] += "/other"
    elif change == "host": current["host"]["id"] = "different-host"
    elif change == "policy": current["filters"]["max_depth"] += 1
    elif change == "drive": current["drive"]["fingerprint"] = "b" * 64
    elif change == "time": current["scanned_at"] = "2000-01-01T00:00:00Z"
    result = history.compare("alice", first["scan_id"], second["scan_id"])
    assert not result["comparable"] and not result["file_comparison"]["available"] and result["files"] == []


def test_changed_volume_identity_cannot_produce_capacity_delta(isolated):
    first = capture(isolated, [file("one.bin", 10)])
    history.save("alice", first["scan_id"])
    second = capture(isolated, [file("one.bin", 20)], used=300)
    history._recent[second["scan_id"]]["snapshot"]["drive"]["fingerprint"] = "b" * 64
    result = history.compare("alice", first["scan_id"], second["scan_id"])
    assert not result["comparable"] and not result["capacity"]["available"]


def test_unknown_file_identity_cannot_turn_alias_accounting_into_growth(isolated):
    first = capture(isolated, [file("one.bin", 10)], allocated=10)
    history.save("alice", first["scan_id"])
    # A legacy/third-party scanner may omit partial=True despite being unable
    # to recognize repeated hard-link identities. Preserve evidence, not growth.
    second = history.capture("alice", isolated, {"size": 20, "allocated_size": 20},
        {"partial": False, "identity_unknown": 2, "folder_summary": [], "direct_file_bytes": 20,
         "scan_filters": FILTERS, "file_summary": [file("one.bin", 10), file("alias.bin", 10)],
         "file_summary_complete": True,
         "capacity": {"total": 1000, "used": 200, "free": 800, "root_is_volume": True}}, DRIVE, after=DRIVE)
    assert second["available"] and not second["summary"]["coverage"]["complete"]
    assert not second["summary"]["file_coverage"]["complete"]
    history.save("alice", second["scan_id"])
    result = history.compare("alice", first["scan_id"], second["scan_id"])
    assert not result["comparable"] and result["totals"] is None and result["files"] == []
    assert result["capacity"]["available"] and result["capacity"]["free_delta_bytes"] == 0
    assert result["capacity"]["unexplained_delta_bytes"] is None


def test_hardlink_accounting_switch_does_not_look_like_file_growth(isolated):
    first = capture(isolated, [file("alias.bin", 0, logical_size=50, hardlink_duplicate=True), file("first.bin", 50)])
    history.save("alice", first["scan_id"])
    second = capture(isolated, [file("alias.bin", 50), file("first.bin", 0, logical_size=50, hardlink_duplicate=True)])
    result = history.compare("alice", first["scan_id"], second["scan_id"])
    assert result["files"] == [] and result["totals"]["delta_bytes"] == 0


def test_alias_accounting_cannot_turn_enumeration_order_into_folder_growth(isolated):
    def observed(folders, direct):
        result = history.capture("alice", isolated, {"size": 50},
            {"partial": False, "folder_summary": folders, "direct_file_bytes": direct,
             "scan_filters": FILTERS, "hardlinks_skipped": 1}, DRIVE, after=DRIVE)
        assert result["available"]
        return result["scan_id"]
    first = observed([{"name": "A", "bytes": 50}, {"name": "B", "bytes": 0}], 0)
    history.save("alice", first)
    # The same identity was encountered first at a root alias on this scan.
    second = observed([{"name": "A", "bytes": 0}, {"name": "B", "bytes": 0}], 50)
    result = history.compare("alice", first, second)
    assert result["comparable"] and result["totals"]["delta_bytes"] == 0
    assert result["folders"] == [] and not result["folder_comparison"]["available"]
    assert result["totals"]["direct_file_delta_bytes"] is None
    assert result["totals"]["direct_file_delta_available"] is False
    assert "traversal order" in result["folder_comparison"]["reason"]


def test_file_summary_is_byte_bounded_private_and_excluded_from_listing(isolated):
    files = [file("long-folder-" + "x" * 100 + "/" + str(index) + ".bin", index) for index in range(500)]
    current = capture(isolated, files)
    summary = history._recent[current["scan_id"]]["snapshot"]
    assert 0 < len(summary["files"]) < 500
    assert not summary["file_coverage"]["complete"]
    assert sum(len(json.dumps(row, ensure_ascii=False).encode()) for row in summary["files"]) <= history.MAX_FILE_SUMMARY_BYTES
    history.save("alice", current["scan_id"])
    public = history.history("alice")["snapshots"][0]
    assert "files" not in public and "folders" not in public
    assert "long-folder" not in store.private_path("alice", "storage_history").read_text()


def test_legacy_snapshots_compare_without_requiring_new_evidence(isolated):
    first = capture(isolated, [file("one.bin", 10)])
    raw = history._recent[first["scan_id"]]["snapshot"]
    for key in ("files", "file_coverage", "capacity"):
        raw.pop(key)
    history.save("alice", first["scan_id"])
    second = capture(isolated, [file("one.bin", 20)])
    result = history.compare("alice", first["scan_id"], second["scan_id"])
    assert result["comparable"] and result["totals"]["delta_bytes"] == 10
    assert not result["file_comparison"]["available"] and not result["capacity"]["available"]


def test_retention_default_preserves_history_and_opt_in_prunes_only_owner(isolated):
    history.configure_retention("alice", max_snapshots=1, max_age_days=0, auto_prune=False)
    first = capture(isolated, [file("one.bin", 10)])
    history.save("alice", first["scan_id"])
    second = capture(isolated, [file("one.bin", 20)])
    before = store.private_path("alice", "storage_history").read_bytes()
    with pytest.raises(HTTPException) as error:
        history.save("alice", second["scan_id"])
    assert error.value.status_code == 409 and store.private_path("alice", "storage_history").read_bytes() == before
    history.configure_retention("alice", max_snapshots=1, max_age_days=0, auto_prune=True)
    assert history.save("alice", second["scan_id"])["removed_ids"] == [first["scan_id"]]
    assert [row["id"] for row in history.history("alice")["snapshots"]] == [second["scan_id"]]
    assert history.retention("bob")["max_snapshots"] == history.MAX_SNAPSHOTS
    assert not history.retention("bob")["auto_prune"]


def test_explicit_maintenance_expires_summaries_without_touching_files(isolated):
    actual = isolated / "keep.bin"
    actual.write_bytes(b"still here")
    current = capture(isolated, [file("keep.bin", 10)])
    history._recent[current["scan_id"]]["snapshot"]["scanned_at"] = "2000-01-01T00:00:00Z"
    history.save("alice", current["scan_id"])
    history.configure_retention("alice", max_snapshots=20, max_age_days=30, auto_prune=False)
    assert len(history.history("alice")["snapshots"]) == 1
    assert history.maintain("bob")["removed_count"] == 0
    assert history.maintain("alice")["removed_ids"] == [current["scan_id"]]
    assert actual.read_bytes() == b"still here"


@pytest.mark.parametrize("bad", [{"max_snapshots": 0}, {"max_snapshots": 21}, {"max_snapshots": True},
                                 {"max_age_days": -1}, {"max_age_days": 3651}, {"auto_prune": 1}])
def test_invalid_retention_is_rejected_without_creating_settings(isolated, bad):
    settings = {"max_snapshots": 20, "max_age_days": 0, "auto_prune": False, **bad}
    with pytest.raises(HTTPException) as error:
        history.configure_retention("alice", **settings)
    assert error.value.status_code == 422
    assert not store.private_path("alice", "storage_history_settings", create=False).exists()


def test_corrupt_retention_cannot_silently_reset_and_evict_history(isolated):
    current = capture(isolated, [file("one.bin", 10)])
    history.save("alice", current["scan_id"])
    path = store.private_path("alice", "storage_history_settings")
    path.write_text("broken")
    before = store.private_path("alice", "storage_history").read_bytes()
    with pytest.raises(HTTPException):
        history.configure_retention("alice", max_snapshots=1, max_age_days=1, auto_prune=True)
    with pytest.raises(HTTPException):
        history.maintain("alice")
    assert path.read_text() == "broken" and store.private_path("alice", "storage_history").read_bytes() == before


def test_failed_maintenance_never_reports_confirmed_removal(isolated, monkeypatch):
    current = capture(isolated, [file("one.bin", 10)])
    history._recent[current["scan_id"]]["snapshot"]["scanned_at"] = "2000-01-01T00:00:00Z"
    history.save("alice", current["scan_id"])
    history.configure_retention("alice", max_snapshots=20, max_age_days=1, auto_prune=False)
    monkeypatch.setattr(store, "write_private", lambda *args: None)
    with pytest.raises(HTTPException) as error:
        history.maintain("alice")
    assert error.value.status_code == 503
