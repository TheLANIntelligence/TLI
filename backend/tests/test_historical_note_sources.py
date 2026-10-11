"""Historical source identity stays exact without recreating removed content."""
import copy
import json

import pytest

import tli_state as S
from intelligence import answer_evidence, chat_continuity, context, memory
from tests.test_memory_chat_integration import local_chat, ROUTES, seed_conversation, submit, completed, supplied_notes


def note_receipt(notes):
    return {"use_saved_memory": True, "status": "included", "omitted_for_budget": 0,
            "notes": [{key: note.get(key) for key in
                       ("id", "revision", "title", "source", "category", "updated_at", "device_id")}
                      for note in notes]}


def store(turns):
    seed_conversation()
    values = S.load_conversations()
    values["continuity"]["messages"] = turns
    S.save_conversations(values)


@pytest.mark.parametrize("route", ROUTES)
def test_multiple_historical_sources_identify_the_exact_changed_and_missing_records(local_chat, route):
    first = memory.save_fact("alice", "Printer setting BEFORE_EDIT_BODY", title="Printer setup")
    second = memory.save_fact("alice", "Printer detail REMOVED_NOTE_BODY", title="Printer cable")
    third = memory.save_fact("alice", "Printer paper A4", title="Paper size")
    turns = [{"role": "user", "content": "What printer details did I save?"},
             {"role": "assistant", "content": "Setup [N1], cable [N2], paper [N3].",
              "memory_context": note_receipt([first, second, third])}]
    store(turns)
    memory.change("alice", first["id"], "Printer setting CURRENT_EDIT_BODY", expected_revision=first["revision"])
    memory.change("alice", second["id"], None, expected_revision=second["revision"])
    result = completed(submit(local_chat, route, message="Explain my printer details."), route)
    refs = result["evidence_context"]["historical_notes"]["references"]
    assert refs == [{"exchange_index": 1, "note_id": n["id"], "title": n["title"],
                     "revision": n["revision"], "handle": f"N{index}", "status": status}
                    for index, n, status in ((1, first, "changed"), (2, second, "unavailable"))]
    prior_answer = next(m["content"] for m in local_chat.calls[0] if m["role"] == "assistant")
    assert prior_answer == ("[Historical assistant answer: 1 of its saved-note references have changed and 1 are unavailable for this question. "
                            "Do not attribute its old details to a current saved note or treat them as a verified fix.]\n"
                            "Setup [N1], cable [N2], paper [N3].")
    assert all(ref["note_id"] not in prior_answer and ref["revision"] not in prior_answer for ref in refs)
    assert "CURRENT_EDIT_BODY" not in prior_answer
    assert "REMOVED_NOTE_BODY" not in json.dumps(local_chat.calls)
    assert "REMOVED_NOTE_BODY" not in json.dumps(result)
    current = result["evidence_context"]["sources"]
    assert second["id"] not in {s["id"] for s in current}
    assert next(s for s in current if s["id"] == first["id"])["revision"] != refs[0]["revision"]
    saved = S.load_conversations()["continuity"]["messages"]
    assert saved[:2] == turns
    assert saved[-1]["evidence_context"] == result["evidence_context"]
    reopened = local_chat.client.get("/api/ai/conversations/continuity").json()
    assert reopened["messages"][-1]["evidence_context"] == result["evidence_context"]


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("barrier", [None, {"role": "assistant", "content": ""},
                                    {"role": "assistant", "content": {"unexpected": "body"}},
                                    {"role": "tool", "content": "Not an ordinary exchange"}])
def test_invalid_turn_cannot_join_a_question_to_an_orphan_answer_or_seed_recall(local_chat, route, barrier):
    note = memory.save_fact("alice", "Printer cable is the saved detail.", title="Printer disconnects")
    turns = [{"role": "user", "content": "Why does the printer disconnect?"}, barrier,
             {"role": "assistant", "content": "An orphan reply [N1].", "memory_context": note_receipt([note])}]
    store(turns)
    result = completed(submit(local_chat, route, message="And what about that?"), route)
    assert result["conversation_context"]["included_exchanges"] == 0
    assert not any(m["role"] == "assistant" for m in local_chat.calls[0])
    assert supplied_notes(local_chat.calls[0]) == []
    assert result["evidence_context"]["historical_notes"]["checked"] is False
    assert S.load_conversations()["continuity"]["messages"][:3] == turns


@pytest.mark.parametrize("route", ROUTES)
def test_saved_notes_off_does_not_inspect_historical_sources_or_add_reference_metadata(local_chat, route, monkeypatch):
    note = memory.save_fact("alice", "Printer detail.", title="Printer")
    store([{"role": "user", "content": "Printer details?"},
           {"role": "assistant", "content": "Historical [N1].", "memory_context": note_receipt([note])}])
    monkeypatch.setattr(S, "load_memory", lambda *a, **kw: pytest.fail("Opt-out accessed saved notes"))
    result = completed(submit(local_chat, route, use_saved_memory=False), route)
    assert result["evidence_context"]["historical_notes"] == {"checked": False, "changed": 0, "unavailable": 0}
    assert next(m["content"] for m in local_chat.calls[0] if m["role"] == "assistant") == "Historical [N1]."


def test_complete_pairs_survive_a_barrier_with_exact_historical_exchange_indices(local_chat):
    first = memory.save_fact("alice", "Printer old detail.", title="First")
    second = memory.save_fact("alice", "Printer second detail.", title="Second")
    turns = [{"role": "user", "content": "Printer first?"},
             {"role": "assistant", "content": "First answer.", "memory_context": note_receipt([first])},
             None, {"role": "assistant", "content": "Orphan answer.", "memory_context": note_receipt([first])},
             {"role": "user", "content": "Printer second?"},
             {"role": "assistant", "content": "Second answer.", "memory_context": note_receipt([second])}]
    store(turns)
    memory.change("alice", first["id"], None, expected_revision=first["revision"])
    memory.change("alice", second["id"], "Corrected second.", expected_revision=second["revision"])
    prepared = chat_continuity.prepare("alice", "Printer details?", "continuity", "Rules.")
    assert prepared["conversation_context"]["included_exchanges"] == 2
    assert "Orphan answer" not in json.dumps(prepared["messages"])
    refs = prepared["evidence_context"]["historical_notes"]["references"]
    assert [(r["exchange_index"], r["note_id"], r["status"]) for r in refs] == [
        (1, first["id"], "unavailable"), (2, second["id"], "changed")]


def test_provenance_checks_only_current_owner_and_eligible_target_without_old_body_recovery(local_chat, monkeypatch):
    generic = memory.save_fact("alice", "Private current body.", title="General")
    other = memory.save_fact("alice", "Other target body.", title="Other target", device_id="node-other")
    memory.save_fact("bob", "BOB_SECRET_BODY", title="General")
    store([{"role": "user", "content": "Earlier details?"},
           {"role": "assistant", "content": "An older explanation.", "memory_context": note_receipt([other, generic])}])
    memory.change("alice", generic["id"], None, expected_revision=generic["revision"])
    original = S.load_memory
    calls = []
    def owned(user, *args, **kwargs):
        calls.append(user)
        assert user == "alice"
        return original(user, *args, **kwargs)
    monkeypatch.setattr(S, "load_memory", owned)
    monkeypatch.setattr(context.devices, "get", lambda ident: {"id": ident, "name": "Selected target"})
    result = chat_continuity.prepare("alice", "Explain general details.", "continuity", "Rules.", target_id="node-current")
    refs = result["evidence_context"]["historical_notes"]["references"]
    assert calls and [(r["note_id"], r["handle"]) for r in refs] == [(generic["id"], "N2")]
    assert "BOB_SECRET_BODY" not in json.dumps(result)
    assert "Other target body" not in json.dumps(result)
    assert "Private current body" not in json.dumps(result)


def valid_history_receipt():
    receipt = answer_evidence.build()
    receipt["historical_notes"] = {"checked": True, "changed": 1, "unavailable": 0, "references": [
        {"exchange_index": 1, "note_id": "fixture", "title": "Saved title", "revision": "a" * 64,
         "handle": "N1", "status": "changed"}]}
    return receipt


def test_legacy_receipt_shape_remains_unchanged_and_only_reference_metadata_is_projected():
    old = answer_evidence.build()
    assert old["historical_notes"] == {"checked": False, "changed": 0, "unavailable": 0}
    assert answer_evidence.public_receipt(old) == old
    receipt = valid_history_receipt()
    with_body = copy.deepcopy(receipt)
    with_body["historical_notes"]["references"][0]["body"] = "PRIVATE_BODY"
    assert answer_evidence.public_receipt(with_body) == receipt


@pytest.mark.parametrize("mutation", [
    lambda h: h.update(changed=0),
    lambda h: h.update(checked=False),
    lambda h: h["references"].append(copy.deepcopy(h["references"][0])),
    lambda h: h["references"][0].update(exchange_index=True),
    lambda h: h["references"][0].update(exchange_index=33),
    lambda h: h["references"][0].update(handle="R1"),
    lambda h: h["references"][0].update(revision="unknown"),
    lambda h: h["references"][0].update(status="deleted"),
])
def test_incoherent_or_unbounded_historical_reference_metadata_is_rejected(mutation):
    receipt = valid_history_receipt()
    mutation(receipt["historical_notes"])
    assert answer_evidence.public_receipt(receipt) is None
