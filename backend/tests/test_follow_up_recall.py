"""Follow-up recall through current encrypted notes and owned conversations."""
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

import tli_state as S
from intelligence import chat_continuity, context, memory
from intelligence.input_budget import TextBudget


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(context.devices, "node", lambda: {"id": "fixture-host", "name": "Study", "role": "standalone"})
    monkeypatch.setattr(context.devices, "get", lambda ident: {"id": ident, "name": "Fixture printer", "kind": "printer"})


def pair(topic, answer="No fresh checks were performed."):
    return [{"role": "user", "content": topic}, {"role": "assistant", "content": answer}]


def save_history(messages, owner="alice"):
    S.save_conversations({"fixture-conversation": {"id": "fixture-conversation", "user_id": owner, "messages": messages}})


def prepare(question="What fixed it last time?", **kwargs):
    return chat_continuity.prepare("alice", question, "fixture-conversation", "Current TLI rules.", **kwargs)


def ids(prepared):
    return [note["id"] for note in prepared["memory_context"]["notes"]]


def reference(prepared):
    return "\n".join(message["content"] for message in prepared["messages"][1:] if message["role"] == "system")


@pytest.mark.parametrize("question", ["What fixed it last time?", "What worked last time?", "How did we fix that before?", "And what about that?"])
def test_short_follow_up_reopens_current_owned_fix_and_preserves_question(question):
    note = memory.save_fact("alice", "Replacing the printer USB cable stopped disconnects.", title="Printer disconnects", report_id="fixture-report")
    memory.save_fact("bob", "The printer needs Bob's private fix.", title="Printer disconnects")
    memory.save_fact("alice", "Restarting the router fixed it last time.", title="Router fix")
    save_history(pair("Why does the printer disconnect?"))
    result = prepare(question)
    assert ids(result) == [note["id"]]
    assert "replacing" in reference(result).lower()
    assert "router" not in reference(result)
    assert "private" not in reference(result)
    assert result["messages"][-1] == {"role": "user", "content": question}
    assert result["memory_context"]["notes"][0]["source"] == "user_confirmation"
    assert "not an independent test" in reference(result)


def test_current_corrections_and_deletion_win_without_rewriting_history():
    note = memory.save_fact("alice", "Printer fix was changing the USB port.", title="Printer fix")
    history = pair("Why does the printer disconnect?", "The old note said change the USB port.")
    save_history(history)
    first = prepare()
    changed = memory.change("alice", note["id"], "Printer fix was replacing the cable.", expected_revision=note["revision"])
    current = prepare()
    assert "replacing the cable" in reference(current)
    assert "changing the USB port" not in reference(current)
    assert current["memory_context"]["notes"][0]["revision"] == changed["revision"] != first["memory_context"]["notes"][0]["revision"]
    memory.change("alice", note["id"], None, expected_revision=changed["revision"])
    assert ids(prepare()) == []
    assert S.load_conversations()["fixture-conversation"]["messages"] == history


@pytest.mark.parametrize("history", [
    pair("Why does the printer disconnect?") + pair("What should I cook for dinner?"),
    pair("What should I cook for dinner?", "Your printer disconnected because of its cable."),
    pair("Why does the printer disconnect?") + [{"role": "user", "content": "What should I cook for dinner?"}],
    pair("Printer " + "q" * 801),
])
def test_new_topics_assistant_assertions_incomplete_and_large_turns_cannot_anchor_old_notes(history):
    memory.save_fact("alice", "Printer needs a new USB cable.", title="Printer disconnects")
    save_history(history)
    assert ids(prepare()) == []


def test_explicit_new_question_does_not_expand_from_previous_topic():
    memory.save_fact("alice", "Printer cable was replaced.", title="Printer fix")
    note = memory.save_fact("alice", "Router was moved away from the microwave.", title="Router fix")
    save_history(pair("Why does the printer disconnect?"))
    assert ids(prepare("Why is the router slow?")) == [note["id"]]


def test_three_exchange_limit_and_no_lookup_across_conversations():
    memory.save_fact("alice", "Printer cable was replaced.", title="Printer fix")
    memory.save_fact("alice", "A router restart fixed it last time.", title="Old router fix")
    save_history(pair("Why does the printer disconnect?") + pair("What about that?") * 3)
    assert ids(prepare()) == []
    result = chat_continuity.prepare("alice", "What fixed it last time?", None, "rules")
    assert ids(result) == []


def test_explicit_target_filters_follow_up_and_client_id_never_substitutes():
    one = memory.save_fact("alice", "Printer cable replaced.", title="Printer fix", device_id="printer-one")
    memory.save_fact("alice", "Printer firmware updated.", title="Printer fix", device_id="printer-two")
    save_history(pair("Why does the printer disconnect?"))
    assert ids(prepare()) == []
    assert ids(prepare(device_id="printer-one")) == []
    # Legacy turns lack a recorded target: never assume this new selection is
    # the computer the earlier question was about.
    assert ids(prepare(target_id="printer-one", device_id="printer-two")) == []
    assert ids(prepare("What printer fix did I save?", target_id="printer-one", device_id="printer-two")) == [one["id"]]


@pytest.mark.parametrize("scope", ["note_context", "document_context", "screenshot_context"])
def test_standalone_reference_exchange_does_not_seed_automatic_recall(scope):
    memory.save_fact("alice", "Printer cable replaced.", title="Printer fix")
    messages = pair("Why does the printer disconnect?")
    messages[-1][scope] = {"status": "included"}
    save_history(messages)
    result = prepare()
    assert ids(result) == []
    assert result["conversation_context"]["included_exchanges"] == 1


@pytest.mark.parametrize("current, previous, standalone, expected", [
    ("printer-one", "printer-one", False, True),
    ("printer-one", "printer-two", False, False),
    ("printer-one", None, False, False),
    (None, "printer-one", False, False),
    (None, None, True, False),
])
def test_recorded_current_scope_permits_matching_target_and_cuts_changed_scope(current, previous, standalone, expected):
    note = memory.save_fact("alice", "Printer cable replaced.", title="Printer fix", device_id=current)
    turns = pair("Why does the printer disconnect?")
    turns[-1]["conversation_context"] = {"status": "none", "included_messages": 0, "included_exchanges": 0,
        "omitted_messages": 0, "character_budget": 12000,
        "recall_scope": {"target_id": previous, "standalone_reference": standalone}}
    save_history(turns)
    result = prepare(target_id=current)
    assert ids(result) == ([note["id"]] if expected else [])
    assert result["conversation_context"]["recall_scope"] == {"target_id": current, "standalone_reference": False}
    assert "recall_scope" not in json.dumps(result["messages"])


def test_malformed_scope_fails_closed_for_selected_target_without_hiding_valid_history():
    memory.save_fact("alice", "Printer cable replaced.", title="Printer fix", device_id="printer-one")
    turns = pair("Why does the printer disconnect?")
    turns[-1]["conversation_context"] = {"status": "none", "included_messages": 0, "included_exchanges": 0,
        "omitted_messages": 0, "character_budget": 12000, "recall_scope": {"target_id": "printer-one", "standalone_reference": "false"}}
    save_history(turns)
    result = prepare(target_id="printer-one")
    assert ids(result) == []
    assert result["conversation_context"]["included_exchanges"] == 1


def test_memory_disabled_does_not_read_notes_or_derive_topic(monkeypatch):
    save_history(pair("Why does the printer disconnect?"))
    monkeypatch.setattr(S, "load_memory", lambda *a, **kw: pytest.fail("Disabled memory must not be read"))
    monkeypatch.setattr(memory, "follow_up_query", lambda *a: pytest.fail("No disabled recall"))
    result = prepare(use_saved_memory=False)
    assert result["memory_context"]["status"] == "disabled"
    assert result["conversation_context"]["included_exchanges"] == 1


def test_ownership_check_precedes_retrieval(monkeypatch):
    save_history(pair("Why does the printer disconnect?"), owner="bob")
    monkeypatch.setattr(S, "load_memory", lambda *a, **kw: pytest.fail("Wrong owner must fail before recall"))
    with pytest.raises(HTTPException) as error:
        prepare()
    assert error.value.status_code == 404


def test_whole_budget_and_input_receipts_still_match_follow_up_evidence():
    for i in range(8):
        memory.save_fact("alice", "Printer " + "n" * 1800, title=f"Printer fix {i}")
    save_history(pair("Why does the printer disconnect?", "Old answer " + "h" * 1200))
    result = prepare(budget=TextBudget(character_limit=4500, max_tokens=1024))
    assert result["input_budget"]["input_characters"] <= 4500
    assert result["memory_context"]["omitted_for_budget"] > 0
    assert result["conversation_context"]["included_exchanges"] == 1
    line = next((line for line in reference(result).splitlines() if line.startswith("memory: ")), None)
    supplied = json.loads(line.removeprefix("memory: ")) if line else []
    assert [note["id"] for note in supplied] == ids(result)
    assert all(note["text"] == "Printer " + "n" * 1800 for note in supplied)


def test_preparation_reads_encrypted_stores_without_mutating_them():
    memory.save_fact("alice", "Printer cable replaced.", title="Printer fix")
    save_history(pair("Why does the printer disconnect?"))
    before = {p: p.read_bytes() for p in Path(S.DATA_DIR).rglob("*") if p.is_file()}
    assert json.loads(Path(S.memory_path_for_user("alice")).read_text())["_tli_enc"] == 1
    assert json.loads(Path(S.CONVERSATIONS_FILE).read_text())["_tli_enc"] == 1
    prepare()
    assert before == {p: p.read_bytes() for p in Path(S.DATA_DIR).rglob("*") if p.is_file()}
