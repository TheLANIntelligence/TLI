import pytest
import storage_scan_algorithms as vis


def test_deep_scan_counts_files_and_reports_exclusions(tmp_path):
    deep = tmp_path / "one" / "two" / "three" / "four"
    deep.mkdir(parents=True)
    (deep / "keep.bin").write_bytes(b"1234567")
    excluded = tmp_path / "node_modules"
    excluded.mkdir()
    (excluded / "cache").write_bytes(b"123")
    tree, largest, meta = vis._scan_tree(tmp_path)
    assert tree["size"] == 7
    assert largest[0]["name"] == "keep.bin"
    assert meta["partial"] and meta["skipped"] == 1
    assert meta["files"] == 1
    _, _, limited = vis._scan_tree(tmp_path, max_depth=2, noisy_names=set())
    assert limited["depth_limited"] == 1 and limited["partial"]


def test_denied_entry_and_entry_limit_are_reported(tmp_path, monkeypatch):
    for index in range(3):
        (tmp_path / str(index)).write_bytes(b"abc")
    tree, _, meta = vis._scan_tree(tmp_path, max_entries=1)
    assert tree["size"] == 3 and meta["entry_limited"] and meta["partial"]
    def denied(_):
        raise PermissionError("Simulated")
    monkeypatch.setattr(vis.os, "scandir", denied)
    _, _, meta = vis._scan_tree(tmp_path)
    assert meta["denied"] == 1 and meta["partial"]


def test_time_limit_returns_truthful_partial_result(tmp_path, monkeypatch):
    ticks = iter([0, 16])
    monkeypatch.setattr(vis.time, "monotonic", lambda: next(ticks))
    _, _, meta = vis._scan_tree(tmp_path)
    assert meta["time_limited"] and meta["partial"]


def test_cleanup_estimates_report_limits_and_leave_files_unchanged(tmp_path):
    for i in range(3):
        (tmp_path / str(i)).write_bytes(b"abc")
    total, meta = vis._measure_cleanup(tmp_path, deadline=float("inf"))
    assert total == 9 and not meta["partial"]
    total, meta = vis._measure_cleanup(tmp_path, deadline=float("inf"), max_entries=1)
    assert total == 3 and meta["partial"] and meta["entry_limited"]
    total, meta = vis._measure_cleanup(tmp_path, deadline=float("inf"), max_bytes=2)
    assert total == 3 and meta["partial"] and meta["byte_limited"]
    total, meta = vis._measure_cleanup(tmp_path, deadline=0)
    assert total == 0 and meta["partial"] and meta["time_limited"]
    assert all(p.read_bytes() == b"abc" for p in tmp_path.iterdir())


def test_cleanup_permission_failure_is_not_reported_as_empty(tmp_path, monkeypatch):
    def denied(_):
        raise PermissionError("fixture")
    monkeypatch.setattr(vis.os, "scandir", denied)
    total, meta = vis._measure_cleanup(tmp_path, deadline=float("inf"))
    assert total == 0 and meta["partial"] and meta["denied"] == 1


def test_cleanup_does_not_follow_junction_targets(tmp_path, monkeypatch):
    (tmp_path / "linked").mkdir()
    (tmp_path / "linked" / "outside.txt").write_bytes(b"outside")
    monkeypatch.setattr(vis.Path, "is_junction", lambda p: p.name == "linked", raising=False)
    total, meta = vis._measure_cleanup(tmp_path, deadline=float("inf"))
    assert total == 0 and meta["partial"] and meta["skipped"] == 1


def test_cleanup_endpoint_preserves_sizes_and_adds_coverage(authed_client, tmp_path, monkeypatch):
    (tmp_path / "sample").write_bytes(b"abc")
    monkeypatch.setattr(vis.platform, "system", lambda: "Windows")
    monkeypatch.setattr(vis, "_cleanup_targets_windows", lambda: [
        {"path": str(tmp_path), "label": "Fixture", "safety": "manual", "tip": "Review", "how": "Review"}])
    import storage_jobs
    from storage_scan_worker import perform
    def synthetic_worker(request, *args):
        result, identity = perform(request, lambda **kw: None)
        return {"type": "result", "result": result, "identity": identity, "worker_stopped": True}
    monkeypatch.setattr(storage_jobs.process, "run", synthetic_worker)
    response = authed_client.get("/visualizer/cleanup-targets")
    assert response.status_code == 200
    target = response.json()["targets"][0]
    assert target["size_bytes"] == 3 and target["exists"] and "size_mb" in target
    assert not target["size_partial"] and not target["size_meta"]["partial"]


def test_duplicates_check_middle_bytes_and_keep_real_matches(tmp_path):
    content = b"a" * 65536 + b"middle" * 4096 + b"z" * 65536
    for name in ("one.bin", "two.bin"):
        (tmp_path / name).write_bytes(content)
    (tmp_path / "different.bin").write_bytes(content.replace(b"middle", b"DIFFER"))
    groups, meta = vis._find_duplicates(tmp_path)
    assert len(groups) == 1 and groups[0]["count"] == 2
    assert {vis.Path(p).name for p in groups[0]["paths"]} == {"one.bin", "two.bin"}
    assert groups[0]["wasted_bytes"] == len(content)
    assert meta["verification"] == "full_sha256" and not meta["partial"]
    assert len(list(tmp_path.iterdir())) == 3


def test_duplicate_hardlinks_are_not_counted_as_extra_copies(tmp_path):
    source = tmp_path / "one.bin"
    source.write_bytes(b"x" * 8192)
    try:
        (tmp_path / "alias.bin").hardlink_to(source)
    except OSError:
        pytest.skip("Hard links unavailable on this test filesystem")
    (tmp_path / "copy.bin").write_bytes(source.read_bytes())
    groups, meta = vis._find_duplicates(tmp_path)
    assert groups[0]["count"] == 2 and groups[0]["wasted_bytes"] == 8192
    assert meta["hardlinks_skipped"] == 1


def test_duplicate_scan_limits_never_claim_complete_scan(tmp_path):
    for name in ("one", "two"):
        (tmp_path / name).write_bytes(b"x" * 8192)
    groups, meta = vis._find_duplicates(tmp_path, max_seconds=0)
    assert not groups and meta["partial"] and meta["time_limited"]
    groups, meta = vis._find_duplicates(tmp_path, max_entries=1)
    assert not groups and meta["partial"] and meta["entry_limited"]


def test_duplicate_hash_timeout_retains_only_completed_matches(tmp_path, monkeypatch):
    for name in ("one", "two", "three"):
        (tmp_path / name).write_bytes(b"x" * 8192)
    original = vis._hash_duplicate_file
    calls = []
    def timed(path, signature, deadline):
        calls.append(path)
        if len(calls) == 3:
            raise TimeoutError("fixture time limit")
        return original(path, signature, deadline)
    monkeypatch.setattr(vis, "_hash_duplicate_file", timed)
    groups, meta = vis._find_duplicates(tmp_path)
    assert len(groups) == 1 and groups[0]["count"] == 2
    assert meta["partial"] and meta["time_limited"] and meta["files_hashed"] == 2


def test_duplicate_files_changed_after_hash_are_discarded(tmp_path, monkeypatch):
    for name in ("one", "two"):
        (tmp_path / name).write_bytes(b"x" * 8192)
    original = vis._hash_duplicate_file
    def changed(path, signature, deadline):
        result = original(path, signature, deadline)
        if path.name == "one":
            path.write_bytes(b"changed")
        return result
    monkeypatch.setattr(vis, "_hash_duplicate_file", changed)
    groups, meta = vis._find_duplicates(tmp_path)
    assert not groups and meta["partial"] and meta["changed"] == 1


def test_duplicate_junctions_and_unreadable_files_are_excluded(tmp_path, monkeypatch):
    linked = tmp_path / "linked"
    linked.mkdir()
    (linked / "outside").write_bytes(b"x" * 8192)
    for name in ("one", "two"):
        (tmp_path / name).write_bytes(b"x" * 8192)
    monkeypatch.setattr(vis.Path, "is_junction", lambda p: p.name == "linked", raising=False)
    calls = []
    def denied(path, *args):
        calls.append(path)
        raise PermissionError("fixture")
    monkeypatch.setattr(vis, "_hash_duplicate_file", denied)
    groups, meta = vis._find_duplicates(tmp_path)
    assert not groups and meta["partial"] and meta["denied"] == 2 and meta["skipped"] == 1
    assert {p.name for p in calls} == {"one", "two"}


def test_duplicate_endpoint_retains_contract_with_verified_coverage(authed_client, tmp_path):
    for name in ("one", "two"):
        (tmp_path / name).write_bytes(b"x" * 8192)
    response = authed_client.get("/visualizer/duplicates", params={"path": str(tmp_path)})
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"groups", "meta"}
    assert body["groups"][0]["verified"] and body["meta"]["total_wasted_bytes"] == 8192


def test_large_file_search_returns_largest_subset_and_truthful_totals(tmp_path):
    for size in (3, 8, 5, 2):
        (tmp_path / str(size)).write_bytes(b"x" * size)
    files, meta = vis._collect_large_files(tmp_path, min_bytes=3, limit=2)
    assert [f["size"] for f in files] == [8, 5]
    assert meta["found"] == 3 and meta["returned"] == 2 and meta["results_limited"]
    assert meta["total_bytes"] == 13 and not meta["partial"]
    assert all(p.stat().st_size == int(p.name) for p in tmp_path.iterdir())


def test_large_file_search_limits_preserve_inspected_results(tmp_path, monkeypatch):
    for name in ("one", "two"):
        (tmp_path / name).write_bytes(b"abc")
    files, meta = vis._collect_large_files(tmp_path, min_bytes=1, limit=5, max_entries=1)
    assert len(files) == 1 and meta["entry_limited"] and meta["partial"]
    times = iter([0, 0, 0, 16])
    monkeypatch.setattr(vis.time, "monotonic", lambda: next(times, 16))
    files, meta = vis._collect_large_files(tmp_path, min_bytes=1, limit=5)
    assert len(files) == 1 and meta["time_limited"] and meta["partial"]


def test_large_file_search_skips_protected_noisy_and_linked_locations(tmp_path, monkeypatch):
    for name in ("protected", "linked", "node_modules", "personal"):
        folder = tmp_path / name
        folder.mkdir()
        (folder / "file.bin").write_bytes(b"abc")
    monkeypatch.setattr(vis, "is_protected", lambda path: vis.Path(path).name == "protected")
    monkeypatch.setattr(vis.Path, "is_junction", lambda path: path.name == "linked", raising=False)
    files, meta = vis._collect_large_files(tmp_path, min_bytes=1, limit=5)
    assert len(files) == 1 and vis.Path(files[0]["path"]).parent.name == "personal"
    assert meta["skipped"] == 3 and meta["partial"]
    files, meta = vis._collect_large_files(tmp_path / "protected", min_bytes=1, limit=5)
    assert not files and meta["skipped"] == 1 and meta["partial"]


def test_large_file_search_denied_is_not_a_complete_empty_search(tmp_path, monkeypatch):
    def denied(_):
        raise PermissionError("fixture")
    monkeypatch.setattr(vis.os, "scandir", denied)
    files, meta = vis._collect_large_files(tmp_path, min_bytes=1, limit=5)
    assert not files and meta["denied"] == 1 and meta["partial"]


def test_large_file_endpoint_keeps_response_contract(authed_client, tmp_path):
    (tmp_path / "fixture.bin").write_bytes(b"x" * 1048576)
    response = authed_client.get("/visualizer/large-files", params={"path": str(tmp_path), "min_mb": 1})
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"files", "meta"}
    assert body["files"][0]["size"] == 1048576 and body["meta"]["total_mb"] == 1
    assert not body["meta"]["partial"]


def test_protected_files_are_counted_but_not_suggested(tmp_path, monkeypatch):
    (tmp_path / "hiberfil.sys").write_bytes(b"1234567")
    (tmp_path / "review.zip").write_bytes(b"123")
    monkeypatch.setattr(vis, "is_protected", lambda path: path.endswith("hiberfil.sys"))
    tree, largest, meta = vis._scan_tree(tmp_path)
    assert tree["size"] == 10 and not meta["partial"]
    assert [item["name"] for item in largest] == ["review.zip"]
    assert tree["children"][0]["protected"]


@pytest.mark.parametrize("limits", [{}, {"max_depth": 18, "max_entries": 50000}])
def test_scan_endpoint_retains_contract_and_emits_truthful_activity(authed_client, tmp_path, monkeypatch, limits):
    import event_bus
    (tmp_path / "example.txt").write_bytes(b"abc")
    events = []
    monkeypatch.setattr(event_bus, "emit_event", lambda *args, **kw: events.append((args, kw)))
    response = authed_client.get("/visualizer/scan", params={"path": str(tmp_path), **limits})
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"tree", "largest", "meta"}
    assert body["tree"]["size"] == 3 and body["meta"]["partial"] is False
    assert body["meta"]["max_depth"] == 18 and body["meta"]["max_entries"] == 50000
    assert events[0][0][2] == "Storage scan started"
    assert events[-1][0][2] == "Storage scan finished"
    assert "no files were changed" in events[-1][0][3]
    assert (tmp_path / "example.txt").read_bytes() == b"abc"
