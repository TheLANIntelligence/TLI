import json
from pathlib import Path

from fastapi import HTTPException
import pytest

from intelligence import conversation_search as search
import tli_state as S


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    target=tmp_path/"conversations.json"
    monkeypatch.setattr(S,"CONVERSATIONS_FILE",str(target))
    monkeypatch.setattr(S,"_store_key",lambda *args,**kwargs:b"k"*32)
    monkeypatch.setattr(S,"_get_conv_key",lambda:b"k"*32)
    monkeypatch.setattr(search,"_cursors",{})
    return target


def conversation(ident,owner="alice",title="Retained chat",messages=None,**extra):
    return {"id":ident,"user_id":owner,"title":title,"provider":"bundled","last_updated":"2026-09-07T12:00:00Z",
            "messages":messages if messages is not None else [{"role":"user","content":"Where is my document?","ts":"2026-09-01T12:00:00Z"},
            {"role":"assistant","content":"It is in the blue folder.","ts":"2026-09-01T12:00:01Z"}],**extra}


def put(target,records,encrypted=True):
    if encrypted:S.save_conversations(records)
    else:target.write_text(json.dumps(records),encoding="utf-8")


@pytest.mark.parametrize("encrypted",[True,False])
def test_search_finds_owned_bundled_and_lm_history_without_writing(isolated,encrypted):
    put(isolated,{"a":conversation("a"),"b":conversation("b",provider="lmstudio"),"c":conversation("c",owner="bob")},encrypted)
    before=isolated.read_bytes();result=search.search("alice","BLUE")
    assert {r["id"] for r in result["items"]}=={"a","b"}
    assert result["coverage"]["owned_conversations"]==2 and result["coverage"]["complete"]
    assert all(row["match"]["source"]=="assistant" and "blue" in row["snippet"] for row in result["items"])
    assert isolated.read_bytes()==before


def test_ownership_legacy_local_alias_and_peer_exclusion(isolated):
    put(isolated,{"local":conversation("local","local"),"legacy":conversation("legacy","bundled-ai"),
                  "alice":conversation("alice"),"peer":conversation("peer","local",mesh_source_ip="192.0.2.1"),
                  "unknown":conversation("unknown",None)})
    result=search.search("local")
    assert {row["id"] for row in result["items"]}=={"local","legacy"}
    assert result["coverage"]["owned_conversations"]==2
    assert [row["id"] for row in search.search("alice")["items"]]==["alice"]


def test_title_message_snippets_are_bounded_and_receipt_metadata_not_searched(isolated):
    records={"title":conversation("title",title="Find printer setup"),"user":conversation("user",messages=[{"role":"user","content":"x "*500+"printer in office"}]),
             "metadata":conversation("metadata",messages=[{"role":"assistant","content":"No match here","source_ref":{"secret":"printer"}}])}
    put(isolated,records);result=search.search("alice","printer")
    assert {row["id"] for row in result["items"]}=={"title","user"}
    assert all(len(row["snippet"])<=242 for row in result["items"])
    assert {row["match"]["source"] for row in result["items"]}=={"title","user"}
    assert all("messages" not in row and "source_ref" not in row for row in result["items"])


def test_search_can_find_normalized_unicode_beyond_start_of_message(isolated):
    put(isolated,{"a":conversation("a",messages=[{"role":"user","content":"earlier "*80+"ＭＵＳＩＣ settings"}])})
    result=search.search("alice","music")
    assert len(result["items"])==1 and "music" in result["items"][0]["snippet"]


def test_older_results_paginate_without_duplicates_in_stable_date_order(isolated):
    put(isolated,{str(i):conversation(str(i),last_updated=f"2026-09-{i+1:02d}T12:00:00Z") for i in range(25)})
    first=search.search("alice",limit=20);second=search.search("alice",limit=20,cursor=first["next_cursor"])
    assert len(first["items"])==20 and len(second["items"])==5 and second["next_cursor"] is None
    assert first["items"][0]["id"]=="24" and second["items"][-1]["id"]=="0"
    assert len({row["id"] for row in first["items"]+second["items"]})==25
    assert second["coverage"]["complete"]


@pytest.mark.parametrize("change",["owner","query","limit","store","expiry"])
def test_cursor_cannot_cross_owner_query_store_or_expiry(isolated,monkeypatch,change):
    put(isolated,{str(i):conversation(str(i)) for i in range(3)})
    result=search.search("alice",limit=1);cursor=result["next_cursor"]
    owner,query,limit="alice","",1
    if change=="owner":owner="bob"
    elif change=="query":query="folder"
    elif change=="limit":limit=2
    elif change=="store":put(isolated,{"new":conversation("new")})
    elif change=="expiry":monkeypatch.setattr(search.time,"time",lambda:10**20)
    with pytest.raises(HTTPException) as error:search.search(owner,query,limit,cursor)
    assert error.value.status_code in (409,410)


def test_page_scan_limits_can_return_no_matches_with_a_continuation(isolated,monkeypatch):
    monkeypatch.setattr(search,"MAX_PAGE_CONVERSATIONS",2)
    put(isolated,{"z":conversation("z",messages=[]),"y":conversation("y",messages=[]),"a":conversation("a",title="needle")})
    first=search.search("alice","needle")
    assert first["items"]==[] and first["next_cursor"] and first["coverage"]["page_scanned"]==2
    second=search.search("alice","needle",cursor=first["next_cursor"])
    assert second["items"][0]["id"]=="a" and second["coverage"]["complete"]


def test_partial_message_text_is_explicit_and_carried_across_pages(isolated,monkeypatch):
    monkeypatch.setattr(search,"MAX_MESSAGE_CHARS",10)
    put(isolated,{"z":conversation("z",title="",messages=[{"role":"user","content":"x"*11+"needle"}]),"a":conversation("a",title="needle")})
    result=search.search("alice","needle")
    assert [row["id"] for row in result["items"]]==["a"]
    assert result["coverage"]["text_limited"] and not result["coverage"]["complete"]


def test_page_character_limit_is_strict_and_skipped_text_is_reported(isolated,monkeypatch):
    monkeypatch.setattr(search,"MAX_PAGE_CHARS",25)
    put(isolated,{"z":conversation("z",title="",messages=[{"role":"user","content":"x"*40+"needle"}]),
                  "a":conversation("a",title="needle")})
    first=search.search("alice","needle")
    assert first["coverage"]["inspected_characters"]==25
    assert first["coverage"]["text_limited"] and first["next_cursor"] and not first["items"]
    second=search.search("alice","needle",cursor=first["next_cursor"])
    assert second["items"][0]["id"]=="a" and not second["coverage"]["complete"]


def test_message_limit_does_not_claim_text_beyond_limit_was_searched(isolated,monkeypatch):
    monkeypatch.setattr(search,"MAX_MESSAGES",2)
    put(isolated,{"a":conversation("a",title="",messages=[{"role":"user","content":"first"},
                  {"role":"assistant","content":"second"},{"role":"user","content":"needle"}])})
    result=search.search("alice","needle")
    assert not result["items"] and result["coverage"]["scanned_messages"]==2
    assert result["coverage"]["text_limited"] and not result["coverage"]["complete"]


@pytest.mark.parametrize("bad",["malformed","oversized","bad_nested","wrong_key"])
def test_unreadable_or_oversized_store_fails_without_overwriting(isolated,monkeypatch,bad):
    if bad=="oversized":monkeypatch.setattr(search,"MAX_STORE_BYTES",10);isolated.write_text("x"*11)
    elif bad=="bad_nested":isolated.write_text('{"a": []}')
    elif bad=="wrong_key":put(isolated,{"a":conversation("a")});monkeypatch.setattr(S,"_store_key",lambda *args,**kwargs:b"x"*32)
    else:isolated.write_text("{broken")
    before=isolated.read_bytes()
    with pytest.raises(HTTPException) as error:search.search("alice","folder")
    assert error.value.status_code in (413,503) and isolated.read_bytes()==before


def test_absent_store_does_not_create_persistence(isolated):
    result=search.search("alice")
    assert result["items"]==[] and result["coverage"]["complete"] and not isolated.exists()


def test_dictionary_identity_is_used_instead_of_forged_embedded_id(isolated):
    put(isolated,{"owned":conversation("someone-elses-id"),"foreign":conversation("foreign","bob")})
    assert [row["id"] for row in search.search("alice")["items"]]==["owned"]


def test_additive_router_is_authenticated_and_no_store(authed_client,client,isolated,monkeypatch):
    capabilities=authed_client.get("/api/intelligence/conversation-search/capabilities")
    assert capabilities.status_code==200 and capabilities.json()=={"ok":True,"protocol":search.PROTOCOL}
    assert capabilities.headers["Cache-Control"]=="no-store"
    result=authed_client.get("/api/intelligence/conversation-search",params={"q":"test"})
    assert result.status_code==200 and result.headers["Cache-Control"]=="no-store"
    from main import app
    from unittest.mock import patch
    with patch.dict(app.dependency_overrides,{},clear=True):
        monkeypatch.setattr(S,"load_pin_config",lambda:{"enabled":True})
        assert client.get("/api/intelligence/conversation-search/capabilities").status_code==401
        assert client.get("/api/intelligence/conversation-search").status_code==401
