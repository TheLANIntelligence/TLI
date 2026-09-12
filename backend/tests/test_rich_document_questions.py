"""Real extracted references through all existing Chat routes, fake inference."""
import copy
import hashlib
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
import tli_state as S
from intelligence import document_extraction as X, documents, input_budget, answer_evidence
from tests.test_document_extraction import docx, pdf
from tests.test_document_questions import isolated, provider, PATHS, result


@pytest.mark.parametrize('path', PATHS)
@pytest.mark.parametrize('kind', ['pdf', 'docx'])
def test_actual_extracted_document_uses_standalone_provider_and_metadata_only_history(path, kind, client, provider):
    raw = pdf('Unique source sentence.') if kind == 'pdf' else docx('<w:p><w:r><w:t>Unique source sentence.</w:t></w:r></w:p>')
    selected = X.extract('local', 'manual.' + kind, raw)
    response = client.post(path, json={'message':'What does the manual say?', 'documents':[selected]})
    assert response.status_code == 200, response.text
    data = result(response, path)
    assert data['handled_by'] == 'documents' and len(provider.calls) == 1
    payload = provider.calls[0][1]['messages']
    assert len(payload) == 3 and 'Unique source sentence.' in payload[1]['content']
    source = json.loads(payload[1]['content'].split('\n',1)[1])[0]
    assert source['extraction']['origin_ranges_for_supplied_lines'] == [{'number':1,'start':1,'end':1}]
    assert 'not visual lines' in payload[0]['content']
    receipt = data['document_context']; assert documents.public_receipt(receipt) == receipt
    assert receipt['documents'][0]['extraction']['original_sha256'] == hashlib.sha256(raw).hexdigest()
    assert 'signature' not in json.dumps(receipt)
    saved = S.load_conversations()[data['conversation_id']]
    assert 'Unique source sentence.' not in json.dumps(saved)
    assert selected['extraction']['signature'] not in json.dumps(saved)
    assert saved['messages'][-1]['document_context'] == receipt


@pytest.mark.parametrize('path', PATHS)
def test_modified_extracted_text_and_account_proofs_reject_before_any_provider(path, client, provider):
    selected = X.extract('other-user', 'fix.docx', docx())
    response = client.post(path,json={'message':'What fixed it?', 'documents':[selected]})
    assert response.status_code == 409 and not provider.calls and not provider.probes
    selected = X.extract('local', 'fix.docx', docx()); selected['text'] = 'FORGED REPAIR'
    response = client.post(path,json={'message':'What fixed it?', 'documents':[selected]})
    assert response.status_code == 409 and not provider.calls and not provider.probes


def test_final_excerpt_origin_maps_only_supplied_units_and_citations_only_real_lines():
    selected = X.extract('local', 'manual.docx', docx(''.join(f'<w:p><w:r><w:t>Paragraph {n}: ' + ('USB fix: replace cable.' if n == 250 else 'ordinary unrelated guidance ' * 3) + '</w:t></w:r></w:p>' for n in range(1,301))))
    req = SimpleNamespace(documents=[documents.Document.model_validate(selected)], message='What is the USB fix?',max_tokens=1024,temperature=None)
    budget = input_budget.TextBudget()
    prepared = documents.prepare('local',req,budget=budget)
    receipt = prepared['document_context']['documents'][0]
    assert receipt['coverage']['mode'] == 'excerpts'
    refs = json.loads(prepared['messages'][1]['content'].split('\n',1)[1])[0]
    assert 'USB fix' in refs['numbered_text']
    units = refs['extraction']['origin_ranges_for_supplied_lines']
    assert units and len(units) < 300
    assert all(any(u['start'] <= r['end'] and r['start'] <= u['end'] for r in receipt['coverage']['ranges']) for u in units)
    assert budget.fits(prepared['messages'])
    evidence = answer_evidence.finalize(prepared['evidence_context'], 'Cable [manual.docx:L250-L250]; unsupported [manual.docx:L999-L999].')
    assert evidence['citations'] == [{'reference':'[manual.docx:L250-L250]', 'handle':'D1'}]
    assert evidence['invalid_citations'] == 1


def test_receipt_rejects_fabricated_original_mapping_but_legacy_text_unchanged():
    selected = X.extract('local','fix.docx',docx())
    req=SimpleNamespace(documents=[documents.Document.model_validate(selected)], message='What fixed it?',max_tokens=1024,temperature=None)
    receipt=documents.prepare('local',req)['document_context']
    changed=copy.deepcopy(receipt); changed['documents'][0]['extraction']['units'][0]['end']=9
    assert documents.public_receipt(changed) is None
    legacy={'documents':[{'name':'old.md','sha256':'a'*64,'line_count':1,'chars':3}],'actions_performed':False}
    assert documents.public_receipt(legacy)==legacy
