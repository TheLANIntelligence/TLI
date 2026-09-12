"""Owned lexical recall and truthful whole-record input budgets, without models."""
import hashlib
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

import tli_state as S
from intelligence import context, memory


@pytest.fixture(autouse=True)
def private_context(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(context.devices, "node", lambda: {"id": "fixture-host", "name": "Study", "role": "standalone"})
    monkeypatch.setattr(context.devices, "get", lambda ident: {"id": ident, "name": "Fixture printer", "kind": "printer"})


def prepare(query="printer", history=(), **kwargs):
    return context.prepare_messages("Primary rules remain whole.", query, history,
                                    context.build("alice", query), **kwargs)


def pairs(count, size=20):
    return [message for i in range(count) for message in (
        {"role": "user", "content": f"Question {i}: " + "q" * size},
        {"role": "assistant", "content": f"Answer {i}: " + "a" * size})]


def reference_notes(result):
    line = next((line for message in result["messages"] if message["role"] == "system"
                 for line in message["content"].splitlines() if line.startswith("memory: ")), None)
    return json.loads(line.removeprefix("memory: ")) if line else []


def test_title_phrase_and_meaningful_words_drive_recall_without_preference_boost():
    titled = memory.save_fact("alice", "A4, 90 gsm.", title="Printer paper")
    ordinary = memory.save_fact("alice", "The printer sits near the cupboard with paper.")
    memory.save_fact("alice", "I prefer quiet evenings.", category="preference")
    memory.save_fact("bob", "Printer paper belongs to Bob.")
    selected = memory.relevant("alice", "Please tell me about my printer paper")
    assert selected[0]["id"] == titled["id"]
    assert {note["id"] for note in selected} == {titled["id"], ordinary["id"]}
    assert not memory.relevant("alice", "What do you remember about me?")
    assert not memory.relevant("alice", "galaxy telescope")


def test_plural_and_unicode_titles_match_deterministically():
    title = memory.save_fact("alice", "Use the rear socket.", title="Studio routers")
    accented = memory.save_fact("alice", "Stored upstairs.", title="CAFÉ equipment")
    assert memory.relevant("alice", "studio router")[0]["id"] == title["id"]
    assert memory.relevant("alice", "cafe\u0301 equipment")[0]["id"] == accented["id"]
    assert memory.relevant("alice", "studio router") == memory.relevant("alice", "studio router")


def test_only_explicit_target_allows_device_scoped_notes():
    device = memory.save_fact("alice", "Printer needs A4.", device_id="printer-1")
    global_note = memory.save_fact("alice", "Printer supply cupboard is downstairs.")
    for target, client in ((None, "printer-1"), ("other", "printer-1"), (None, None)):
        assert [f["id"] for f in memory.relevant("alice", "printer", target, client)] == [global_note["id"]]
    assert device["id"] in [f["id"] for f in memory.relevant("alice", "printer", "printer-1")]
    assert not memory.relevant("alice", "telescope", "printer-1")


def test_automatic_recall_never_reads_unowned_legacy_device_files(monkeypatch):
    memory.save_fact("local", "Printer uses letter paper.")
    monkeypatch.setattr(memory, "legacy_facts", lambda *a: pytest.fail("Automatic recall must not inspect ownerless device notes"))
    assert memory.relevant("local", "printer", client_device_id="shared-browser")
    assert context.build("local", "printer", client_device_id="shared-browser")["memory_ids"]


def test_owned_legacy_notes_keep_stable_versions_and_unknown_dates():
    Path(S.memory_path_for_user("alice")).write_text(json.dumps({"facts": ["Printer uses legal paper."]}))
    first = prepare()
    second = prepare()
    note = first["memory_context"]["notes"][0]
    assert note["id"] == "legacy-0"
    assert note["updated_at"] is None
    assert note["title"] == "Untitled note"
    assert second["memory_context"] == first["memory_context"]


def test_correction_and_delete_apply_to_next_recall_without_rewriting_history():
    fact = memory.save_fact("alice", "Printer uses A4.", title="Printer paper")
    initial = prepare()
    history = [{"role": "user", "content": "Which paper?"}, {"role": "assistant", "content": "Earlier you said A4."}]
    edited = memory.change("alice", fact["id"], "Printer now uses letter paper.")
    changed = prepare(history=history)
    assert reference_notes(changed)[0]["text"] == "Printer now uses letter paper."
    assert changed["memory_context"]["notes"][0]["revision"] == edited["revision"]
    assert initial["memory_context"]["notes"][0]["revision"] != edited["revision"]
    memory.change("alice", fact["id"], None)
    deleted = prepare(history=history)
    assert deleted["memory_context"]["status"] == "none"
    assert not reference_notes(deleted)
    assert "Earlier you said A4." in [m["content"] for m in deleted["messages"]]
    assert any("historical" in message["content"] for message in deleted["messages"] if message["role"] == "system")


def test_off_never_reads_saved_memory_and_preserves_the_existing_conversation(monkeypatch):
    monkeypatch.setattr(S, "load_memory", lambda *a, **kw: pytest.fail("Memory disabled must not open saved notes"))
    evidence = context.build("alice", "printer", client_device_id="old-browser", use_saved_memory=False)
    result = context.prepare_messages("rules", "printer", pairs(1), evidence)
    assert result["memory_context"] == {"use_saved_memory": False, "status": "disabled", "notes": [], "omitted_for_budget": 0}
    assert result["conversation_context"]["included_exchanges"] == 1
    assert "memory" not in result["categories"]


def test_on_surfaces_unreadable_owned_store_instead_of_claiming_empty_memory():
    path = Path(S.memory_path_for_user("alice"))
    path.write_bytes(b"damaged saved data")
    with pytest.raises(HTTPException) as exc:
        context.build("alice", "printer")
    assert exc.value.status_code == 503
    assert path.read_bytes() == b"damaged saved data"


def test_large_memory_cannot_displace_the_latest_complete_exchange():
    for i in range(8):
        memory.save_fact("alice", f"Printer setting {i}: " + "x" * 1900, title=f"Printer note {i}")
    history = pairs(4, 750)
    result = prepare(history=history, max_chars=8000)
    assert result["conversation_context"]["included_exchanges"] >= 2
    historical = [m for m in result["messages"] if m["role"] != "system"][:-1]
    assert historical == history[-len(historical):]
    assert result["memory_context"]["omitted_for_budget"] > 0
    assert sum(len(m["content"]) for m in result["messages"]) <= 8000
    assert len(reference_notes(result)) == len(result["memory_context"]["notes"])


def test_one_large_recent_exchange_wins_over_optional_notes_if_it_fits():
    memory.save_fact("alice", "Printer " + "n" * 1000)
    history = pairs(1, 1000)
    result = prepare(history=history, max_chars=3500)
    assert result["conversation_context"]["included_exchanges"] == 1
    assert result["memory_context"]["status"] == "none"
    assert result["memory_context"]["omitted_for_budget"] == 1


def test_more_than_eight_prior_turns_can_be_supplied_without_clipping():
    history = pairs(15)
    result = prepare(history=history)
    assert result["conversation_context"]["included_messages"] == 30
    assert result["conversation_context"]["status"] == "included"
    assert [message for message in result["messages"][:-1] if message["role"] != "system"] == history
    assert result["messages"][-2]["role"] == "system"
    assert result["messages"][-1] == {"role": "user", "content": "printer"}


def test_counts_include_omitted_snapshot_and_orphan_messages_without_fragmenting():
    history = [{"role": "assistant", "content": "Orphan"}] + pairs(2) + [{"role": "user", "content": "Unanswered"}]
    result = prepare(history=history, total_history_messages=40)
    assert result["conversation_context"] == {"status": "limited", "included_messages": 4,
        "included_exchanges": 2, "omitted_messages": 36, "character_budget": 12000}
    contents = [m["content"] for m in result["messages"]]
    assert "Orphan" not in contents and "Unanswered" not in contents


def test_an_oversized_recent_exchange_does_not_substitute_old_history():
    history = pairs(1) + pairs(1, 10000)
    result = prepare(history=history)
    assert result["conversation_context"]["included_messages"] == 0
    assert result["conversation_context"]["omitted_messages"] == 4


def test_complete_note_json_and_metadata_match_only_final_provider_input():
    large = memory.save_fact("alice", "Printer " + "huge detail " * 1100, title="Printer")
    small = memory.save_fact("alice", 'Printer setting: "letter".\nKeep the second tray. ☕', title="Paper")
    result = prepare(max_chars=4000)
    notes = reference_notes(result)
    assert [n["id"] for n in notes] == [small["id"]]
    assert notes[0]["text"] == small["text"]
    assert result["memory_context"]["omitted_for_budget"] == 1
    assert [n["id"] for n in result["memory_context"]["notes"]] == [small["id"]]
    assert large["text"] not in json.dumps(result["memory_context"])
    assert "text" not in result["memory_context"]["notes"][0]


def test_legacy_build_text_is_bounded_with_whole_json_notes():
    for _ in range(20):
        memory.save_fact("alice", "printer " + "x" * 1900)
    built = context.build("alice", "printer")
    assert len(built["text"]) < 5000
    line = next(line for line in built["text"].splitlines() if line.startswith("memory: "))
    notes = json.loads(line.removeprefix("memory: "))
    assert all(note["text"] == "printer " + "x" * 1900 for note in notes)
    assert built["memory_ids"] == [n["id"] for n in notes]


def test_required_question_and_reference_are_never_silently_shortened(monkeypatch):
    primary = "P" * 3000
    question = "Q" * 2500
    result = context.prepare_messages(primary, question, (), context.build("alice", "printer"))
    assert result["messages"][0]["content"] == primary
    assert result["messages"][-1]["content"] == question
    with pytest.raises(HTTPException) as exc:
        context.prepare_messages(primary, "Q" * 12000, (), context.build("alice", "printer"))
    assert exc.value.status_code == 422
    monkeypatch.setattr(context.devices, "get", lambda ident: {"id": ident, "name": "X" * 12000})
    with pytest.raises(HTTPException) as exc:
        context.build("alice", "printer", target_id="printer")
    assert exc.value.status_code == 422


def test_bound_compatibility_adapter_never_slices_reference_json_or_history():
    reference = json.dumps({"evidence": "X" * 10000})
    history = pairs(1, 100)
    result = context.bound_messages([{"role": "system", "content": "rules"},
        {"role": "system", "content": reference}] + history + [{"role": "user", "content": "question"}], 1500)
    assert result == [{"role": "system", "content": "rules"}] + history + [{"role": "user", "content": "question"}]


def test_opaque_legacy_context_does_not_invent_note_provenance():
    evidence = {"text": 'memory: [{"text":"Printer statement"}]', "categories": ["memory"]}
    result = context.prepare_messages("rules", "question", (), evidence)
    assert result["messages"][1]["content"] == evidence["text"]
    assert result["memory_context"]["status"] == "unknown"
    with pytest.raises(HTTPException) as exc:
        context.prepare_messages("rules", "question", (), {**evidence, "use_saved_memory": False})
    assert exc.value.status_code == 422


def test_saved_ai_origin_is_unverified_and_revision_bound_without_legacy_changes():
    note = memory.save_fact("alice", "Printer firmware may be outdated.")
    original = {k: note.get(k) for k in ("id", "text", "title", "category", "device_id", "created_at", "updated_at", "source", "report_id", "deleted")}
    original["source"] = note.get("source") or "user_memory"
    expected = hashlib.sha256(json.dumps(original, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    assert memory.revision(note) == expected
    origin = {"conversation_id": "synthetic", "message_index": 1, "revision": "a" * 64, "role": "assistant"}
    edited = memory.change("alice", note["id"], note["text"], metadata={"source": "chat_ai", "chat_source": origin})
    assert edited["revision"] != memory.revision({k: v for k, v in edited.items() if k != "chat_source"})
    result = prepare()
    assert result["memory_context"]["notes"][0]["source"] == "chat_ai"
    assert "chat_source" not in result["memory_context"]["notes"][0]
    assert "chat_ai is an AI-authored suggestion and remains unverified" in result["messages"][1]["content"]


@pytest.mark.parametrize("patch", [
    {"status": "included"}, {"use_saved_memory": "false"}, {"notes": [{}]},
    {"omitted_for_budget": -1}, {"omitted_for_budget": True},
])
def test_malformed_memory_receipts_do_not_surface_as_provenance(patch):
    value = {"use_saved_memory": False, "status": "disabled", "notes": [], "omitted_for_budget": 0, **patch}
    assert context.public_memory_receipt(value) is None


def test_public_receipts_strip_bodies_and_unknown_fields_and_accept_remote_unknown():
    memory.save_fact("alice", "Printer private detail", title="Paper")
    receipt = prepare()["memory_context"]
    receipt["notes"][0]["text"] = "Private body must not persist"
    receipt["secret"] = "No"
    public = context.public_memory_receipt(receipt)
    assert "text" not in public["notes"][0] and "secret" not in public
    assert context.public_memory_receipt({"use_saved_memory": True, "status": "unknown", "notes": [], "omitted_for_budget": 0})
    assert context.public_conversation_receipt({"status": "unknown", "included_messages": 0,
        "included_exchanges": 0, "omitted_messages": 0, "character_budget": 12000})
    assert context.public_conversation_receipt({"status": "included", "included_messages": 3,
        "included_exchanges": 1, "omitted_messages": 0, "character_budget": 12000}) is None
