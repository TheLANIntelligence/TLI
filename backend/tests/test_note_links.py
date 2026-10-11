"""Owned note pointers preserve content, revisions, backups and deleted history."""
import copy
import hashlib
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import HTTPException
import tli_state as S
from intelligence import memory, note_links as L, note_search, backups
from memory_validation import validate_memory_structure


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    note_search.clear_browser()


def fact(text="Private saved detail", owner="local"):
    return memory.save_fact(owner, text, title=text[:120])


def edge(note, relation="related"):
    return {"id": note["id"], "revision": note["revision"], "relation": relation}


def contents():
    return {str(p.relative_to(S.DATA_DIR)): p.read_bytes() for p in Path(S.DATA_DIR).rglob("*") if p.is_file()}


def test_read_only_metadata_links_and_incoming_never_copy_bodies_or_infer_truth():
    a, b = fact("PRIVATE-A"), fact("PRIVATE-B")
    first = contents()
    assert L.inspect("local", a["id"])["links"] == []
    assert contents() == first
    value = L.save("local", a["id"], a["revision"], [edge(b, "correction_reference")])
    assert value["links"][0]["availability"] == "current"
    assert value["note"]["revision"] != a["revision"]
    assert value["actions_performed"] is False
    assert "not verified facts" in value["scope"]
    stored = S.load_memory("local")["facts"][0]
    assert stored["text"] == "PRIVATE-A"
    assert "PRIVATE-B" not in json.dumps(stored["note_links"])
    assert set(stored["note_links"]["links"][0]) == {"id", "revision", "relation", "linked_at"}
    assert L.inspect("local", b["id"])["incoming"][0]["source"]["id"] == a["id"]
    assert all(b"PRIVATE" not in raw for raw in contents().values())


def test_changed_or_deleted_targets_remain_historical_without_reconstruction():
    a,b=fact("A"),fact("Historical body")
    value=L.save("local",a["id"],a["revision"],[edge(b)])
    changed=memory.change("local",b["id"],"New private body",expected_revision=b["revision"])
    assert L.inspect("local",a["id"])["links"][0]["availability"] == "changed"
    memory.change("local",b["id"],None,expected_revision=changed["revision"])
    deleted=L.inspect("local",a["id"])
    assert deleted["links"][0]["availability"] == "unavailable"
    assert deleted["links"][0]["target"] is None
    assert "Historical body" not in json.dumps(deleted)
    assert "New private body" not in json.dumps(deleted)
    kept=L.save("local",a["id"],value["note"]["revision"],[edge(b)])
    assert kept["links"][0]["availability"] == "unavailable"
    assert L.save("local",a["id"],kept["note"]["revision"],[])["links"] == []


def test_owner_self_duplicate_stale_or_missing_target_rejected_before_write():
    a,b,foreign=fact("A"),fact("B"),fact("Foreign",owner="other")
    for parent, revision, links, status in [(a["id"],a["revision"],[edge(a)],422),
        (a["id"],a["revision"],[edge(b),edge(b)],422),(a["id"],a["revision"],[edge(foreign)],404),
        (a["id"],"f"*64,[edge(b)],409),(a["id"],a["revision"],[{**edge(b),"revision":"f"*64}],409)]:
        before=contents()
        with pytest.raises(HTTPException) as caught:L.save("local",parent,revision,links)
        assert caught.value.status_code == status and contents()==before
    with pytest.raises(HTTPException):L.inspect("other",a["id"])


def test_old_records_keep_exact_revision_and_edits_preserve_optional_link_metadata():
    a,b=fact("A"),fact("B")
    fields={k:a.get(k) for k in ("id","text","title","category","device_id","created_at","updated_at","source","report_id","deleted")}
    assert a["revision"]==hashlib.sha256(json.dumps(fields,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    linked=L.save("local",a["id"],a["revision"],[edge(b)])
    record=next(n for n in S.load_memory("local")["facts"] if n["id"]==a["id"])
    changed=memory.change("local",a["id"],"New text",expected_revision=linked["note"]["revision"],metadata={"title":"Retitled"})
    assert changed["note_links"]==record["note_links"]
    assert changed["revision"]!=linked["note"]["revision"]


def test_concurrent_edits_cannot_lose_first_saved_relationship():
    a,b,c=fact("A"),fact("B"),fact("C")
    def save(target):
        try:return L.save("local",a["id"],a["revision"],[edge(target)])["links"][0]["id"]
        except HTTPException as e:return e.status_code
    with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(save,[b,c]))
    assert results.count(409)==1
    assert L.inspect("local",a["id"])["links"][0]["id"] in (b["id"],c["id"])


@pytest.mark.parametrize("corrupt",[None,[],{"schema_version":True,"links":[]},{"schema_version":2,"links":[]},
    {"schema_version":1,"links":[{"id":"other","revision":"a"*64,"relation":"inferred_fact","linked_at":"2026-09-08"}]}])
def test_malformed_link_metadata_is_unavailable_to_reader_and_backup(corrupt):
    value={"facts":[{"id":"a","text":"Saved", "note_links":corrupt}]}
    with pytest.raises(ValueError):validate_memory_structure(value)
    with pytest.raises(ValueError):backups._validate_data("notebook",value,"local")


def test_note_links_are_not_silently_followed_by_chat_or_semantic_selection(monkeypatch):
    a,b=fact("printer setup"),fact("Unrelated SECRET network body")
    L.save("local",a["id"],a["revision"],[edge(b)])
    relevant=memory.relevant("local","printer setup")
    assert [n["id"] for n in relevant]==[a["id"]]
    selected,_=note_search._facts("local",[{"id":a["id"],"revision":memory.list_facts("local")[0]["revision"]}])
    assert len(selected)==1 and "SECRET" not in selected[0][1]


def test_link_save_invalidates_only_owners_derived_search_state():
    a,b=fact("A"),fact("B")
    r=note_search.review("local",None,[{"id":a["id"],"revision":a["revision"]}],1234,"synthetic-model","")
    L.save("local",a["id"],a["revision"],[edge(b)])
    assert r["review_id"] not in note_search._reviews


def test_current_recovery_reader_preserves_links_and_source_byte_for_byte(tmp_path):
    from tests.test_recovery_readback import values,seed,expectation,tree,readback
    payload=values()
    source,target=payload["notebook"]["facts"][:2]
    source["note_links"]={"schema_version":1,"links":[{"id":target["id"],"revision":memory.revision(target),"relation":"related","linked_at":"2026-09-08T12:00:00Z"}]}
    root=seed(tmp_path/"recovered",payload)
    before=tree(root)
    assert readback.run_readback(root,expectation(payload))["ok"] is True
    assert tree(root)==before


@pytest.mark.parametrize("format",[None,"saved-work-v2"])
def test_old_and_new_backup_formats_preserve_relationships(format):
    a,b=fact("Private A"),fact("Private B")
    L.save("local",a["id"],a["revision"],[edge(b)])
    expected=S.load_memory("local")
    before=contents()
    password="Synthetic test password 2026"
    blob=backups.create_archive("local",password,format)
    receipt=backups.verify_archive(blob,password)
    assert receipt["ok"] is True
    assert receipt["schema_version"]==(2 if format else 1)
    entries=backups._unpack(backups._decrypt(blob,password))
    assert json.loads(entries["notebook.json"])["facts"]==expected["facts"]
    assert contents()==before


def test_authenticated_schema_pagination_and_missing_key_protection(client):
    a,b,c=fact("A"),fact("B"),fact("C")
    base=f"/api/intelligence/memory/{a['id']}/links"
    data=client.get(base,params={"limit":1}).json()
    assert len(data["candidates"])==1 and data["next_after"]
    second=client.get(base,params={"limit":1,"after":data["next_after"]}).json()
    assert len(second["candidates"])==1 and second["next_after"] is None
    invalid=client.put(base,json={"expected_revision":a["revision"],"links":[edge(b)]*9})
    assert invalid.status_code==422
    before=Path(S.memory_path_for_user("local")).read_bytes()
    (Path(S.DATA_DIR)/"memory_key.bin").unlink()
    response=client.put(base,json={"expected_revision":a["revision"],"links":[edge(b)]})
    assert response.status_code==503
    assert Path(S.memory_path_for_user("local")).read_bytes()==before
    assert not (Path(S.DATA_DIR)/"memory_key.bin").exists()
