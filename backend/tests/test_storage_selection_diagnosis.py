"""Selected-path explanations use authenticated synthetic retained metadata only."""
import copy
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import storage_jobs as jobs
import tli_state as S
from intelligence import storage_diagnosis as diagnosis

JOB = "a" * 32
ROOT = "C:/Observed"


@pytest.fixture
def observation(monkeypatch, app):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(jobs, "_jobs", {})
    monkeypatch.setattr(jobs, "_requests", {})
    monkeypatch.setattr(jobs, "_active", None)
    token = S.create_session_token("selection-owner")
    credential = jobs.Access("selection-owner", "browser", token)
    file = {"path": ROOT + "/Downloads/installer.iso", "name": "installer.iso", "kind": "file",
            "size": 1000, "logical_size": 1000, "size_known": True, "size_partial": False,
            "modified_at": "2026-10-10T15:00:00Z",
            "allocated_size": 4096, "allocated_known_bytes": 4096, "files": 1}
    alias = {**file, "path": ROOT + "/Downloads/alias.iso", "name": "alias.iso", "size": 0,
             "hardlink_duplicate": True, "allocated_size": 0, "allocated_known_bytes": 0}
    unreadable = {"path": ROOT + "/unreadable.bin", "name": "unreadable.bin", "kind": "file",
                  "size": 0, "size_known": False, "size_partial": True, "size_reason": "unreadable", "allocated_size": None}
    folder = {"path": ROOT + "/Downloads", "name": "Downloads", "kind": "directory", "size": 1800,
              "files": 5, "children": [file, alias], "size_known": True, "size_partial": False,
              "allocated_size": None, "allocated_known_bytes": 4096, "omitted_bytes": 800, "omitted_entries": 3}
    aggregate = {"path": ROOT + "/__MORE__", "name": "Grouped", "kind": "aggregate", "synthetic": True,
                 "size": 500, "files": 2, "collapsed_entries": 2}
    tree = {"path": ROOT, "name": "Observed", "kind": "directory", "size": 2300, "files": 8,
            "size_known": True, "size_partial": True, "children": [folder, unreadable, aggregate],
            "allocated_size": None, "allocated_known_bytes": 4096}
    result = {"tree": tree, "meta": {"root": ROOT, "partial": True, "denied": 1,
              "representation_limited": True, "folder_summary": [{"name": "Downloads", "bytes": 1800}]},
              "largest": [file, {"path": ROOT + "/not-retained.iso", "size": 800}]}
    job = {"id": JOB, "host": {"id": "synthetic", "name": "Synthetic host"}, "operation": "scan",
           "profile": "quick", "include_excluded": False, "path": ROOT, "status": "partial",
           "started_at": "2026-10-11T12:00:00Z", "updated_at": "2026-10-11T12:00:01Z",
           "finished_at": "2026-10-11T12:00:01Z", "expires_at": "2099-01-01T00:00:00Z", "progress": {},
           "limits": {}, "result_available": True, "error": None, "worker_stopped": True,
           "access": credential, "expiry": 10**12, "result": result}
    jobs._jobs[JOB] = job
    client = TestClient(app)
    client.cookies.set("tli_session", token)
    return credential, client, job


def test_file_selection_uses_real_authenticated_result_and_canonical_retained_path(observation):
    credential, client, _ = observation
    response = client.post("/visualizer/investigate", json={"job_id": JOB, "selected_path": r"c:\OBSERVED\downloads\INSTALLER.ISO"})
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    data = response.json()
    assert data["protocol"] == diagnosis.PROTOCOL and data["local_only"]
    evidence = data["evidence"]
    assert evidence["job_id"] == JOB and evidence["root"] == ROOT and evidence["logical_bytes"] == 2300
    assert evidence["selected_path"] == ROOT + "/Downloads/installer.iso"
    assert evidence["selection"]["logical_bytes"] == evidence["selection"]["counted_logical_bytes"] == 1000
    assert evidence["selection"]["allocated_bytes"] == 4096 and evidence["selection"]["file_count"] == 1
    assert evidence["selection"]["modified_at"] == "2026-10-10T15:00:00Z" and not evidence["selection"]["allocated_partial"]
    assert data["recommendations"][0]["classification"] == "requires_review"
    assert "not-retained.iso" not in data["reply"] and "not a promise of recoverable space" in data["reply"]


def test_folder_selection_separates_representation_from_scan_coverage(observation):
    credential, _, _ = observation
    data = diagnosis.investigate(credential, JOB, selected_path=ROOT + "/Downloads")
    selected = data["evidence"]["selection"]
    assert selected["kind"] == "directory" and selected["file_count"] == 5 and selected["retained_children"] == 2
    assert selected["representation_limited"] and selected["omitted_entries"] == 3 and selected["omitted_bytes"] == 800
    assert selected["scan_partial"] and not selected["partial"]
    assert selected["allocated_bytes"] is None and selected["allocated_known_bytes"] == 4096
    assert selected["allocated_partial"]
    assert "measured subset" in data["reply"] and "cannot recover their individual paths" in data["reply"]
    assert data["recommendations"][0]["action"] == "blocked"
    assert "excluded or not retained" in data["reply"]


def test_root_selection_accounts_for_aggregate_and_omitted_bytes_without_double_counting(observation):
    credential, _, _ = observation
    data = diagnosis.investigate(credential, JOB, selected_path=ROOT)
    selected = data["evidence"]["selection"]
    assert selected["partial"] and selected["logical_bytes"] == 2300
    assert selected["omitted_bytes"] == 1300 and selected["omitted_entries"] == 5
    assert selected["retained_children"] == 2


def test_alias_explanation_distinguishes_actual_logical_size_from_counted_contribution(observation):
    credential, _, _ = observation
    data = diagnosis.investigate(credential, JOB, selected_path=ROOT + "/Downloads/alias.iso")
    selection = data["evidence"]["selection"]
    assert selection["hardlink_duplicate"] and selection["logical_bytes"] == 1000 and selection["counted_logical_bytes"] == 0
    assert "counted elsewhere" in data["reply"] and "does not mean this file has no disk allocation" in data["reply"]
    assert data["recommendations"][0]["action"] == "blocked"
    assert data["recommendations"][0]["size_bytes"] == 1000


def test_unknown_file_size_is_not_reported_as_zero(observation):
    credential, _, _ = observation
    data = diagnosis.investigate(credential, JOB, selected_path=ROOT + "/unreadable.bin")
    selection = data["evidence"]["selection"]
    assert selection["logical_bytes"] is None and selection["counted_logical_bytes"] is None
    assert not selection["size_known"] and selection["partial"]
    assert "zero bytes must not be inferred" in data["reply"]
    assert selection["size_reason"] == "unreadable" and "Recorded coverage reason: unreadable" in data["reply"]
    assert data["recommendations"][0]["action"] == "blocked"
    assert data["recommendations"][0]["size_bytes"] is None


@pytest.mark.parametrize("suffix", ["AppData/Local/Temp/work.tmp", "Chrome/Cache/entry.tmp"])
@pytest.mark.parametrize("protected", [False, True])
def test_selected_temp_cache_names_do_not_establish_ownership_or_safety(observation, suffix, protected):
    credential, _, job = observation
    row = {"path": ROOT + "/" + suffix, "name": "entry.tmp", "size": 10,
           "size_known": True, "protected": protected}
    job["result"]["tree"]["children"].append(row)
    job["result"]["largest"] = [row]
    selected = diagnosis.investigate(credential, JOB, selected_path=row["path"])["recommendations"][0]
    whole = diagnosis.investigate(credential, JOB)["recommendations"][0]
    if protected:
        assert selected["classification"] == whole["classification"] == "protected"
        assert selected["action"] == "blocked"
    else:
        assert selected["classification"] == "requires_review" and selected["action"] == "review"
        assert "ownership" in selected["reason"] and "in use" in selected["reason"] and "removal safety are unverified" in selected["reason"]
        assert whole["classification"] == "generally_safe_to_review"


@pytest.mark.parametrize("path,status", [(ROOT + "/not-retained.iso", 404), ("D:/Other/private.txt", 404),
    (ROOT + "/__MORE__", 422), ("remainder:synthetic", 422), (ROOT + "/../outside", 422),
    ("", 422), ("x" * 4097, 422), (ROOT + "/bad\x00path", 422)])
def test_missing_synthetic_and_invalid_selections_are_rejected(observation, path, status):
    _, client, _ = observation
    response = client.post("/visualizer/investigate", json={"job_id": JOB, "selected_path": path})
    assert response.status_code == status, response.text


def test_omitted_selection_preserves_whole_scan_shape_and_reply(observation):
    credential, _, _ = observation
    baseline = diagnosis.investigate(credential, JOB)
    assert baseline == diagnosis.investigate(credential, JOB, selected_path=None)
    assert "selected_path" not in baseline["evidence"] and "selection" not in baseline["evidence"]
    assert baseline["reply"].startswith("Scan evidence for") and "Largest observed folders" in baseline["reply"]


def test_selection_performs_no_filesystem_scan_or_content_reads(observation, monkeypatch):
    credential, _, _ = observation
    import builtins
    import os
    def forbidden(*args, **kwargs):
        pytest.fail("Selected explanations must use retained metadata only")
    monkeypatch.setattr(builtins, "open", forbidden)
    monkeypatch.setattr(Path, "stat", forbidden)
    monkeypatch.setattr(os, "scandir", forbidden)
    monkeypatch.setattr(jobs, "start", forbidden)
    monkeypatch.setattr(S.lm_provider, "complete", forbidden)
    assert diagnosis.investigate(credential, JOB, selected_path=ROOT + "/Downloads")["local_only"]


def test_selected_path_remains_bound_to_original_session_and_owner(observation, app):
    _, _, _ = observation
    for owner in ["selection-owner", "other-owner"]:
        token = S.create_session_token(owner)
        stranger = TestClient(app); stranger.cookies.set("tli_session", token)
        response = stranger.post("/visualizer/investigate", json={"job_id": JOB, "selected_path": ROOT})
        assert response.status_code == 404 and ROOT not in response.text


def test_revocation_before_reply_blocks_private_selection_evidence(observation, monkeypatch):
    credential, _, _ = observation
    original = diagnosis._selected_evidence
    def revoked(*args):
        result = original(*args)
        S.revoke_session_token(credential.credential)
        return result
    monkeypatch.setattr(diagnosis, "_selected_evidence", revoked)
    with pytest.raises(HTTPException) as denied:
        diagnosis.investigate(credential, JOB, selected_path=ROOT)
    assert denied.value.status_code == 401


def test_selection_traversal_is_bounded_and_rejects_ambiguous_retained_paths(observation, monkeypatch):
    _, _, job = observation
    tree = copy.deepcopy(job["result"]["tree"])
    tree["children"].append(copy.deepcopy(tree["children"][0]))
    with pytest.raises(HTTPException) as duplicate:
        diagnosis._selected_evidence(tree, {}, ROOT + "/Downloads")
    assert duplicate.value.status_code == 409
    monkeypatch.setattr(diagnosis, "MAX_SELECTION_NODES", 3)
    with pytest.raises(HTTPException) as bounded:
        diagnosis._selected_evidence(job["result"]["tree"], {}, ROOT)
    assert bounded.value.status_code == 409


def test_posix_selection_keeps_case_sensitive_identity_and_real_bucket_names_are_allowed():
    tree = {"path": "/observed", "name": "observed", "size": 10, "children": [
        {"path": "/observed/__MORE__", "name": "__MORE__", "size": 10}]}
    _, evidence = diagnosis._selected_evidence(tree, {}, "/observed/__MORE__")
    assert evidence["kind"] == "file" and evidence["logical_bytes"] == 10
    with pytest.raises(HTTPException) as missing:
        diagnosis._selected_evidence(tree, {}, "/Observed/__MORE__")
    assert missing.value.status_code == 404


def test_windows_selection_does_not_merge_distinct_unicode_names():
    tree = {"path": ROOT, "name": "Observed", "size": 30, "children": [
        {"path": ROOT + "/Straße.txt", "name": "Straße.txt", "size": 10},
        {"path": ROOT + "/STRASSE.txt", "name": "STRASSE.txt", "size": 20}]}
    for spelling, canonical, size in [("straße.txt", "Straße.txt", 10), ("strasse.txt", "STRASSE.txt", 20)]:
        _, selected = diagnosis._selected_evidence(tree, {}, ROOT + "/" + spelling)
        assert selected["path"] == ROOT + "/" + canonical and selected["logical_bytes"] == size


def test_selected_explanation_does_not_attribute_whole_scan_comparison_to_selected_path(observation, monkeypatch):
    from intelligence import storage_history
    credential, _, job = observation
    job["result"]["meta"]["saved_scan"] = {"scan_id": "c" * 32}
    monkeypatch.setattr(storage_history, "compare", lambda *args: {"comparable": True, "totals": {"delta_bytes": 900}})
    data = diagnosis.investigate(credential, JOB, baseline_id="b" * 32, selected_path=ROOT + "/Downloads")
    assert "does not establish growth for this selected path" in data["reply"]
    assert data["evidence"]["comparison"]["totals"]["delta_bytes"] == 900
