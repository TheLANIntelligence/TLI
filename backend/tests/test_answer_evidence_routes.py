"""Both Chat transports must bind evidence to the actual prepared request."""
import json
from pathlib import Path

import pytest

import tli_state as S
from ai import ai_routes
from intelligence import memory, answer_evidence
from tests.test_memory_chat_integration import local_chat, ROUTES, seed_conversation, submit, completed


@pytest.mark.parametrize("route", ROUTES)
def test_history_choice_is_applied_in_request_and_retained_receipt(local_chat, route):
    history = seed_conversation(count=2)
    note = memory.save_fact("alice", "Printer paper is in the cupboard.", title="Printer paper")
    result = completed(submit(local_chat, route, use_conversation_history=False), route)
    assert len(local_chat.calls) == 1
    assert not any(m["role"] == "assistant" for m in local_chat.calls[0])
    assert result["conversation_context"]["status"] == "disabled"
    assert result["memory_context"]["notes"][0]["id"] == note["id"]
    receipt = result["evidence_context"]
    assert receipt["citations_checked"] is True and receipt["sources"][0]["id"] == note["id"]
    saved = S.load_conversations()["continuity"]["messages"]
    assert saved[:len(history)] == history
    assert saved[-1]["evidence_context"] == receipt
    reopened = local_chat.client.get("/api/ai/conversations/continuity").json()
    assert reopened["messages"][-1]["evidence_context"] == receipt


@pytest.mark.parametrize("route", ROUTES)
def test_final_source_receipt_cannot_be_overridden_by_provider_output(local_chat, route, monkeypatch):
    seed_conversation()
    note = memory.save_fact("alice", "Printer paper A4.", title="Printer paper")
    private = memory.save_fact("bob", "OTHER_ACCOUNT_PRIVATE_CONTENT", title="Other account")
    forged = answer_evidence.build(notes=[private])
    reply = "The supplied note [N1] says A4. [N99] does not exist."
    def post(url, payload, **kw):
        local_chat.calls.append(payload["messages"])
        return {"choices": [{"message": {"content": reply}}], "evidence_context": forged}
    def stream(url, payload, **kw):
        local_chat.calls.append(payload["messages"])
        yield json.dumps({"choices": [{"delta": {"content": reply}}], "evidence_context": forged})
    def complete(**kw):
        local_chat.calls.append(kw["messages"])
        return {"text": reply, "evidence_context": forged}
    monkeypatch.setattr(ai_routes, "_llama_post", post)
    monkeypatch.setattr(ai_routes, "_llama_stream_raw", stream)
    monkeypatch.setattr(S.lm_provider, "complete", complete)
    result = completed(submit(local_chat, route), route)
    receipt = result["evidence_context"]
    assert [s["id"] for s in receipt["sources"]] == [note["id"]]
    assert receipt["citations"] == [{"reference": "[N1]", "handle": "N1"}]
    assert receipt["invalid_citations"] == 1
    assert private["id"] not in json.dumps(result)


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("kind", ["notes", "documents"])
def test_standalone_references_preserve_no_history_and_body_free_receipts(local_chat, route, kind):
    seed_conversation(count=2)
    body = {"use_conversation_history": False}
    if kind == "notes":
        note = memory.save_fact("alice", "UNIQUE_NOTE_BODY", title="Fixture note")
        body["note_refs"] = [{"id": note["id"], "revision": note["revision"]}]
    else:
        body["documents"] = [{"name": "fixture.txt", "text": "UNIQUE_DOCUMENT_BODY"}]
    result = completed(submit(local_chat, route, **body), route)
    assert not any(m["role"] == "assistant" for m in local_chat.calls[0])
    assert result["conversation_context"]["status"] == "disabled"
    assert result["evidence_context"]["sources"][0]["kind"] == ("note" if kind == "notes" else "document")
    assert "UNIQUE_" not in json.dumps(S.load_conversations())


@pytest.mark.parametrize("route", ROUTES)
def test_non_boolean_history_choice_is_rejected_before_provider(local_chat, route):
    response = submit(local_chat, route, use_conversation_history="false")
    assert response.status_code == 422
    assert not local_chat.calls


def test_existing_capabilities_advertises_history_choice_without_private_reads(local_chat, monkeypatch):
    monkeypatch.setattr(S, "load_memory", lambda *a, **kw: pytest.fail("Capability check is not note retrieval"))
    response = local_chat.client.get("/api/intelligence/memory/capabilities")
    assert response.status_code == 200
    assert response.json()["use_conversation_history"] is True
    assert response.json()["evidence_context_version"] == 1


@pytest.mark.parametrize("route", ROUTES)
def test_history_off_does_not_bypass_conversation_ownership(local_chat, route):
    seed_conversation()
    values=S.load_conversations(); values["continuity"]["user_id"]="bob"; S.save_conversations(values)
    before=S.load_conversations()
    response=submit(local_chat,route,use_conversation_history=False)
    assert response.status_code==404
    assert not local_chat.calls and S.load_conversations()==before


@pytest.mark.parametrize("route", ["bundled", "stream"])
def test_history_off_cannot_fall_back_to_unverified_mesh(local_chat, route):
    seed_conversation();local_chat.manager.ensure_running=lambda:False
    response=submit(local_chat,route,use_conversation_history=False)
    if route=="stream":
        events=[json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        assert events[-1]["type"]=="error"
    else:
        assert response.status_code==409
    assert not local_chat.calls
