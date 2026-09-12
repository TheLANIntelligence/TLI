import copy
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import HTTPException
import pytest

from intelligence import storage_history as history, store
from routers import visualizer as vis
import tli_state as S


DRIVE = {"status": "known", "fingerprint": "a" * 64, "detail": "Synthetic volume"}


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(S, "_get_mem_key", lambda: b"k" * 32)
    monkeypatch.setattr(S, "_store_key", lambda *args: b"k" * 32)
    monkeypatch.setattr(history, "_host", lambda: {"id": "fixture-host", "name": "Fixture"})
    monkeypatch.setattr(history, "drive_identity", lambda root: copy.deepcopy(DRIVE))
    monkeypatch.setattr(history, "_recent", {})
    return tmp_path


def observation(root, folders=None, direct=0, **changes):
    folders = folders if folders is not None else [{"name": "Photos", "bytes": 10}]
    meta = {"partial": False, "folder_summary": folders, "direct_file_bytes": direct,
            "scan_filters": {"excluded_names": ["node_modules"], "max_depth": 18, "max_entries": 50000, "max_seconds": 15, "follow_links": False}, **changes}
    result = history.capture("alice", root, {"size": sum(row["bytes"] for row in folders) + direct}, meta, copy.deepcopy(DRIVE))
    assert result["available"]
    return result


def test_host_generated_scan_is_explicitly_saved_encrypted_and_owner_scoped(isolated):
    current = observation(isolated)
    assert not Path(S.DATA_DIR).exists()
    saved = history.save("alice", current["scan_id"])
    assert saved["saved"] and saved["snapshot"]["total_bytes"] == 10
    raw = store.private_path("alice", "storage_history").read_text()
    assert '"_tli_enc"' in raw and 'Photos' not in raw and str(isolated) not in raw
    assert history.history("bob")["snapshots"] == []
    with pytest.raises(HTTPException) as error: history.save("bob", current["scan_id"])
    assert error.value.status_code == 410


def test_comparison_reports_growth_new_and_not_observed_without_claiming_deletion(isolated, monkeypatch):
    first = observation(isolated, [{"name":"Grew","bytes":10},{"name":"Shrank","bytes":20},{"name":"Gone","bytes":8}], 2)
    history.save("alice", first["scan_id"])
    second = observation(isolated, [{"name":"Grew","bytes":18},{"name":"Shrank","bytes":7},{"name":"New","bytes":50}], 5)
    monkeypatch.setattr(history, "drive_identity", lambda root: (_ for _ in ()).throw(AssertionError("Compare must not probe drives")))
    response = history.compare("alice", first["scan_id"], second["scan_id"])
    assert response["comparable"] and response["point_in_time"]
    assert response["totals"] == {"before_bytes":40,"after_bytes":80,"delta_bytes":40,"direct_file_delta_bytes":3}
    rows = {row["name"]: row for row in response["folders"]}
    assert rows["Grew"]["delta_bytes"] == 8 and rows["Shrank"]["delta_bytes"] == -13
    assert rows["New"]["status"] == "newly_observed" and rows["New"]["delta_bytes"] is None
    assert rows["Gone"]["status"] == "not_observed" and rows["Gone"]["after_bytes"] is None


@pytest.mark.parametrize("flag", ["denied", "skipped", "depth_limited", "entry_limited", "time_limited", "summary_limited"])
def test_incomplete_scans_can_be_saved_but_never_claim_growth(isolated, flag):
    first=observation(isolated);history.save("alice",first["scan_id"])
    current=observation(isolated,[{"name":"Photos","bytes":1}],**{flag:1})
    history.save("alice",current["scan_id"])
    result=history.compare("alice",first["scan_id"],current["scan_id"])
    assert not result["comparable"] and result["totals"] is None and not result["folders"]
    assert any("incomplete" in reason for reason in result["reasons"])


@pytest.mark.parametrize("change", ["root", "filters", "host", "drive", "unknown_drive", "unknown_host"])
def test_incompatible_observations_refuse_numeric_comparison(isolated, change):
    first=observation(isolated);history.save("alice",first["scan_id"])
    current=observation(isolated)
    snapshot=history._recent[current["scan_id"]]["snapshot"]
    if change=="root":snapshot["root"]+="/different"
    elif change=="filters":snapshot["filters"]["max_depth"]=19
    elif change=="host":snapshot["host"]["id"]="other"
    elif change=="drive":snapshot["drive"]["fingerprint"]="b"*64
    elif change=="unknown_drive":snapshot["drive"]["status"]="unknown"
    elif change=="unknown_host":snapshot["host"]["id"]="unknown"
    result=history.compare("alice",first["scan_id"],current["scan_id"])
    assert not result["comparable"] and result["totals"] is None and not result["folders"]


def test_identity_change_during_scan_is_visible_and_blocks_comparison(isolated, monkeypatch):
    monkeypatch.setattr(history, "drive_identity", lambda root: {"status":"unknown","fingerprint":None,"detail":"Unavailable"})
    current=observation(isolated)
    assert current["summary"]["drive"]["status"]=="changed"


def test_expired_token_rejects_save_but_duplicate_saved_token_survives_cache_loss(isolated, monkeypatch):
    current=observation(isolated);first=history.save("alice",current["scan_id"])
    history._recent.clear()
    assert history.save("alice",current["scan_id"])==first
    current=observation(isolated)
    monkeypatch.setattr(history.time,"time",lambda:current["expires_at"]+1)
    with pytest.raises(HTTPException) as error:history.save("alice",current["scan_id"])
    assert error.value.status_code==410


def test_duplicate_and_concurrent_saves_preserve_each_observation_once(isolated):
    first=observation(isolated);second=observation(isolated)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results=list(pool.map(lambda ident:history.save("alice",ident),[first["scan_id"],second["scan_id"],first["scan_id"],second["scan_id"]]))
    assert all(result["saved"] for result in results)
    assert len(history.history("alice")["snapshots"])==2


@pytest.mark.parametrize("corruption", ["json", "structure", "oversized"])
def test_unreadable_store_is_preserved_and_never_replaced(isolated, corruption):
    current=observation(isolated)
    target=store.private_path("alice","storage_history")
    if corruption=="structure":store.write_private("alice","storage_history",[{"broken":True}])
    else:target.write_text("{broken" if corruption=="json" else "x"*(history.MAX_STORE_BYTES+1))
    before=target.read_bytes()
    with pytest.raises(Exception):history.save("alice",current["scan_id"])
    assert target.read_bytes()==before


def test_history_limits_preserve_existing_records_instead_of_silently_evicting(isolated,monkeypatch):
    monkeypatch.setattr(history,"MAX_SNAPSHOTS",2)
    for _ in range(2):current=observation(isolated);history.save("alice",current["scan_id"])
    before=store.private_path("alice","storage_history").read_bytes();current=observation(isolated)
    with pytest.raises(HTTPException) as error:history.save("alice",current["scan_id"])
    assert error.value.status_code==409 and store.private_path("alice","storage_history").read_bytes()==before


def test_scanner_summary_includes_empty_folders_and_root_files_without_payload_collapse(isolated):
    (isolated/"empty").mkdir();(isolated/"photos").mkdir();(isolated/"photos/a").write_bytes(b"123")
    (isolated/"direct").write_bytes(b"12345")
    tree,_,meta=vis._scan_tree(isolated)
    assert tree["size"]==8 and meta["direct_file_bytes"]==5
    assert sorted(meta["folder_summary"],key=lambda r:r["name"])==[{"name":"empty","bytes":0,"size_known":True,"size_partial":False},{"name":"photos","bytes":3,"size_known":True,"size_partial":False}]
    assert not meta["summary_limited"]


def test_scan_api_provenance_and_save_rejects_client_sizes(authed_client,isolated):
    (isolated/"one").write_bytes(b"observed")
    response=authed_client.get("/visualizer/scan",params={"path":str(isolated)})
    scan=response.json()["meta"]["saved_scan"]
    assert response.headers["Cache-Control"]=="no-store"
    assert scan["protocol"]==history.PROTOCOL and scan["summary"]["total_bytes"]==8
    assert authed_client.post("/visualizer/history/save",json={"scan_id":scan["scan_id"],"version":1,"total_bytes":999}).status_code==422
    saved=authed_client.post("/visualizer/history/save",json={"scan_id":scan["scan_id"],"version":1})
    assert saved.status_code==200 and saved.json()["snapshot"]["total_bytes"]==8
    listed=authed_client.get("/visualizer/history")
    assert listed.headers["Cache-Control"]=="no-store" and len(listed.json()["snapshots"])==1


def test_history_routes_require_existing_session(client,isolated,monkeypatch):
    from main import app
    from unittest.mock import patch
    with patch.dict(app.dependency_overrides,{},clear=True):
        monkeypatch.setattr(S,"load_pin_config",lambda:{"enabled":True})
        assert client.get("/visualizer/history").status_code==401
        assert client.post("/visualizer/history/save",json={"scan_id":"a"*32,"version":1}).status_code==401
        assert client.post("/visualizer/history/compare",json={"scan_id":"a"*32,"baseline_id":"b"*32,"version":1}).status_code==401
        assert client.delete("/visualizer/history/"+"a"*32).status_code==401


def test_folder_summary_limit_does_not_turn_unlisted_folders_into_growth_or_loss(isolated):
    for index in range(201):(isolated/str(index)).mkdir()
    tree,_,meta=vis._scan_tree(isolated)
    assert len(meta["folder_summary"])==200 and meta["summary_limited"] and not meta["partial"]
    result=history.capture("alice",isolated,tree,meta,copy.deepcopy(DRIVE))
    assert result["available"] and not result["summary"]["coverage"]["complete"]


def test_save_write_failure_never_claims_confirmation(isolated,monkeypatch):
    current=observation(isolated)
    monkeypatch.setattr(store,"write_private",lambda *args:None)
    with pytest.raises(HTTPException) as error:history.save("alice",current["scan_id"])
    assert error.value.status_code==503


def test_clock_reversal_blocks_misleading_later_scan_label(isolated):
    first=observation(isolated);history.save("alice",first["scan_id"])
    current=observation(isolated)
    history._recent[current["scan_id"]]["snapshot"]["scanned_at"]="2000-01-01T00:00:00Z"
    result=history.compare("alice",first["scan_id"],current["scan_id"])
    assert not result["comparable"] and result["totals"] is None and any("clock" in reason for reason in result["reasons"])


def test_removing_summary_frees_slot_without_probing_or_deleting_observed_files(isolated,monkeypatch):
    monkeypatch.setattr(history,"MAX_SNAPSHOTS",1)
    actual=isolated/"keep.txt";actual.write_text("unchanged")
    first=observation(isolated);history.save("alice",first["scan_id"])
    second=observation(isolated)
    monkeypatch.setattr(history,"drive_identity",lambda root:(_ for _ in ()).throw(AssertionError("No drive probe during summary removal")))
    with pytest.raises(HTTPException):history.save("alice",second["scan_id"])
    with pytest.raises(HTTPException) as error:history.remove("bob",first["scan_id"])
    assert error.value.status_code==404
    result=history.remove("alice",first["scan_id"])
    assert result=={"ok":True,"protocol":history.PROTOCOL,"deleted":True,"snapshot_id":first["scan_id"]}
    assert actual.read_text()=="unchanged" and history.save("alice",second["scan_id"])["saved"]


def test_failed_summary_removal_preserves_history_and_never_claims_success(isolated,monkeypatch):
    first=observation(isolated);history.save("alice",first["scan_id"])
    before=store.private_path("alice","storage_history").read_bytes()
    monkeypatch.setattr(store,"write_private",lambda *args:None)
    with pytest.raises(HTTPException) as error:history.remove("alice",first["scan_id"])
    assert error.value.status_code==503 and store.private_path("alice","storage_history").read_bytes()==before
