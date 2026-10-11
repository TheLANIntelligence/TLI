"""Historical source receipts describe the exact supplied, coherent snapshot."""
import threading

import pytest

import tli_state as S
from intelligence import chat_continuity, context, memory
from intelligence.input_budget import TextBudget


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(S, 'CONVERSATIONS_FILE', str(tmp_path / 'conversations.json'))
    monkeypatch.setattr(context.devices, 'node', lambda: {'id': 'fixture-host', 'name': 'Fixture'})
    monkeypatch.setattr(context.devices, 'get', lambda ident: {'id': ident, 'name': 'Fixture target'})


def exchange(note=None, answer='An earlier answer.', question='Earlier question.'):
    turn = {'role': 'assistant', 'content': answer}
    if note:
        turn['memory_context'] = {'use_saved_memory': True, 'status': 'included',
            'notes': [{key: note.get(key) for key in
                       ('id', 'revision', 'title', 'source', 'category', 'updated_at', 'device_id')}],
            'omitted_for_budget': 0}
    return [{'role': 'user', 'content': question}, turn]


def save_history(turns):
    S.save_conversations({'prior': {'id': 'prior', 'user_id': 'alice', 'messages': turns}})


def only_latest_budget(question='Continue.'):
    prior = chat_continuity.history('prior', 'alice', inspect_notes=True)
    required = context.build('alice', question)['text']
    pair_size = sum(len(turn['content']) for turn in prior['messages'][-2:])
    return TextBudget(character_limit=len('Rules.') + len(question) + len(required) + pair_size + 5,
                      max_tokens=512)


def prepare(**kwargs):
    return chat_continuity.prepare('alice', 'Continue.', 'prior', 'Rules.', **kwargs)


def test_duplicate_historical_text_does_not_count_an_omitted_note_reference():
    first = memory.save_fact('alice', 'First archived setting.', title='First')
    second = memory.save_fact('alice', 'Second archived setting.', title='Second')
    turns = exchange(first) + exchange(second)
    save_history(turns)
    memory.change('alice', first['id'], 'Corrected first setting.', expected_revision=first['revision'])
    memory.change('alice', second['id'], 'Corrected second setting.', expected_revision=second['revision'])
    result = prepare(budget=only_latest_budget())
    assert result['conversation_context']['included_exchanges'] == 1
    assert result['evidence_context']['historical_notes'] == {'checked': True, 'changed': 1, 'unavailable': 0,
        'references': [{'exchange_index': 1, 'note_id': second['id'], 'title': second['title'],
                        'revision': second['revision'], 'handle': 'N1', 'status': 'changed'}]}
    assert S.load_conversations()['prior']['messages'] == turns


def test_omitted_inspected_exchange_does_not_claim_retained_legacy_answer_was_checked():
    note = memory.save_fact('alice', 'Archived setting.', title='Earlier')
    turns = exchange(note, 'Lengthy earlier explanation. ' * 180) + exchange(answer='Later legacy answer.')
    save_history(turns)
    memory.change('alice', note['id'], None, expected_revision=note['revision'])
    result = prepare(budget=only_latest_budget())
    assert result['conversation_context']['included_exchanges'] == 1
    assert result['evidence_context']['historical_notes'] == {'checked': False, 'changed': 0, 'unavailable': 0}
    assert S.load_conversations()['prior']['messages'] == turns


def test_retained_unchanged_reference_is_still_a_real_check():
    note = memory.save_fact('alice', 'Archived setting.', title='Earlier')
    save_history(exchange(note))
    assert prepare()['evidence_context']['historical_notes'] == {'checked': True, 'changed': 0, 'unavailable': 0}


def test_unpaired_assistant_with_note_receipt_cannot_change_retained_pair_counts():
    note = memory.save_fact('alice', 'Archived setting.', title='Earlier')
    orphan = exchange(note)[1]
    turns = [orphan] + exchange(answer='Unattributed legacy answer.')
    save_history(turns)
    memory.change('alice', note['id'], None, expected_revision=note['revision'])
    result = prepare()
    assert result['conversation_context']['included_exchanges'] == 1
    assert result['evidence_context']['historical_notes'] == {'checked': False, 'changed': 0, 'unavailable': 0}


def test_note_edit_cannot_interleave_between_historical_check_and_current_note_selection(monkeypatch):
    note = memory.save_fact('alice', 'Printer cable setting before correction.', title='Printer')
    turns = exchange(note, question='What printer setting is saved?')
    save_history(turns)
    started, finished = threading.Event(), threading.Event()
    failures, interleaved = [], []
    original_build = context.build

    def edit():
        started.set()
        try:
            memory.change('alice', note['id'], 'Printer setting after correction.', expected_revision=note['revision'])
        except Exception as error:
            failures.append(error)
        finally:
            finished.set()

    worker = threading.Thread(target=edit, daemon=True)

    def build(*args, **kwargs):
        worker.start()
        assert started.wait(1), 'Synthetic note writer did not start'
        interleaved.append(finished.wait(0.2))
        return original_build(*args, **kwargs)

    monkeypatch.setattr(context, 'build', build)
    try:
        result = chat_continuity.prepare('alice', 'What printer setting is saved?', 'prior', 'Rules.')
    finally:
        worker.join(timeout=2)
    assert finished.is_set() and not worker.is_alive() and failures == []
    assert interleaved == [False], 'Note mutation interleaved between provenance and retrieval'
    assert result['memory_context']['notes'][0]['revision'] == note['revision']
    assert result['evidence_context']['historical_notes'] == {'checked': True, 'changed': 0, 'unavailable': 0}
    assert memory.list_facts('alice')[0]['revision'] != note['revision']
    assert S.load_conversations()['prior']['messages'] == turns


def test_both_opt_outs_perform_no_new_note_or_conversation_lookup(monkeypatch):
    monkeypatch.setattr(S, 'load_memory', lambda *a, **kw: pytest.fail('Saved-note lookup while disabled'))
    monkeypatch.setattr(S, 'load_conversations', lambda *a, **kw: pytest.fail('History lookup while disabled'))
    result = prepare(use_saved_memory=False, use_conversation_history=False)
    assert result['conversation_context']['status'] == result['memory_context']['status'] == 'disabled'
    assert result['evidence_context']['historical_notes'] == {'checked': False, 'changed': 0, 'unavailable': 0}
