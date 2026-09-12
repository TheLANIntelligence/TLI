"""Generic images respect memory opt-out and report their final text context."""
import base64
import io
import json
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from PIL import Image
import tli_state as S
from intelligence import chat, context, devices, memory, models, screenshots, vision

PROVIDER = {'provider': 'lmstudio', 'model': 'synthetic-vision', 'url': 'http://192.0.2.8/v1/chat/completions'}


def encoded_image():
    result = io.BytesIO(); Image.new('RGB', (16, 16), 'blue').save(result, 'PNG')
    return base64.b64encode(result.getvalue()).decode()


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(S, 'CONVERSATIONS_FILE', str(tmp_path / 'conversations.json'))
    monkeypatch.setattr(devices, 'node', lambda: {'id': 'fixture-host', 'name': 'Fixture desktop'})
    monkeypatch.setattr(models, 'image_provider', lambda: dict(PROVIDER))


@pytest.fixture
def calls(monkeypatch):
    records = []
    def post(url, **kwargs):
        records.append({'url': url, **kwargs})
        return SimpleNamespace(status_code=200, raise_for_status=lambda: None,
                               json=lambda: {'choices': [{'message': {'content': 'The printer screen shows a warning.'}}]})
    monkeypatch.setattr(chat.requests, 'post', post)
    return records


def text_input(messages):
    return ''.join(m['content'] if isinstance(m['content'], str) else ''.join(part['text'] for part in m['content'] if part['type'] == 'text') for m in messages)


def test_opt_out_never_retrieves_any_memory_and_reports_disabled(monkeypatch, calls):
    monkeypatch.setattr(memory, 'relevant', lambda *a, **kw: pytest.fail('Opt-out must not retrieve notes'))
    result = chat.image_reply('owner', 'Explain this printer image', encoded_image(), use_saved_memory=False)
    assert result['memory_context'] == {'use_saved_memory': False, 'status': 'disabled', 'notes': [], 'omitted_for_budget': 0}
    assert result['conversation_context']['status'] == 'none'
    assert result['conversation_context']['included_messages'] == 0
    assert len(calls) == 1 and calls[0]['allow_redirects'] is False
    assert calls[0]['json']['messages'][-1]['content'][1]['type'] == 'image_url'
    assert 'memory' not in result['context_categories']


def test_default_images_include_only_reported_current_notes_without_bodies_in_receipt(calls):
    fact = memory.save_fact('owner', 'The printer was last configured for A4 paper.', title='Printer paper')
    result = chat.image_reply('owner', 'Explain this printer image', encoded_image())
    receipt = result['memory_context']
    assert receipt['status'] == 'included' and receipt['use_saved_memory'] is True
    assert [note['id'] for note in receipt['notes']] == [fact['id']]
    assert receipt['notes'][0]['revision'] == fact['revision']
    assert 'text' not in receipt['notes'][0] and fact['text'] not in json.dumps(receipt)
    messages = calls[0]['json']['messages']
    assert fact['text'] in text_input(messages) and len(text_input(messages)) <= context.MAX_CHARS
    assert messages[-1]['content'][0]['text'] == 'Explain this printer image'


def test_large_question_omits_whole_note_before_attaching_image(calls):
    fact = memory.save_fact('owner', 'Printer ' + 'x' * 1900, title='Printer setup')
    question = 'Printer ' + 'q' * 9600
    result = chat.image_reply('owner', question, encoded_image())
    assert result['memory_context']['notes'] == []
    assert result['memory_context']['omitted_for_budget'] == 1
    assert result['memory_context']['status'] == 'none'
    assert 'memory' not in result['context_categories']
    messages = calls[0]['json']['messages']
    assert fact['text'] not in text_input(messages)
    assert messages[-1]['content'][0]['text'] == question
    assert len(text_input(messages)) <= context.MAX_CHARS


def test_over_budget_question_rejects_before_provider_selection_retention_or_transport(monkeypatch, calls):
    monkeypatch.setattr(models, 'image_provider', lambda: pytest.fail('Rejected text must not select/start provider'))
    monkeypatch.setattr(vision, 'retain', lambda *a: pytest.fail('Rejected text must not retain image'))
    with pytest.raises(HTTPException) as failure:
        chat.image_reply('owner', 'q' * 12000, encoded_image(), use_saved_memory=False)
    assert failure.value.status_code == 422 and 'nothing was shortened or sent' in failure.value.detail
    assert not calls


@pytest.mark.parametrize('enabled', [True, False])
def test_guided_screenshots_remain_standalone_without_generic_memory_or_receipts(enabled, monkeypatch, calls):
    monkeypatch.setattr(context, 'build', lambda *a, **kw: pytest.fail('Guided screenshot never retrieves ordinary context'))
    monkeypatch.setattr(context, 'prepare_messages', lambda *a, **kw: pytest.fail('Preserve reviewed screenshot context'))
    options = screenshots.ScreenshotOptions(task='explain', provider_key=screenshots.provider_details(PROVIDER)['key'])
    result = chat.image_reply('owner', 'Explain the visible error', encoded_image(), screenshot=options, use_saved_memory=enabled)
    assert result['screenshot_context']['actions_performed'] is False
    assert 'memory_context' not in result and 'conversation_context' not in result
    assert len(calls) == 1
    assert 'not a live view' in calls[0]['json']['messages'][0]['content']
