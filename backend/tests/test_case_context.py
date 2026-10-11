"""Reviewed case questions over synthetic encrypted stores and fake providers."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import tli_state as S
from ai import ai_routes as ai
from routers import chat_routes as lm
from intelligence import cases, case_context as C, memory, chat_continuity, answer_evidence
from intelligence.input_budget import TextBudget
from intelligence.store import private_path

PATHS = ['/api/ai/chat', '/api/ai/chat/stream', '/chat']


@pytest.fixture
def fixture(tmp_path, monkeypatch):
    monkeypatch.setattr(S,'DATA_DIR',str(tmp_path))
    monkeypatch.setattr(S,'CONVERSATIONS_FILE',str(tmp_path/'conversations.json'))
    monkeypatch.setattr(S,'load_pin_config',lambda:{'enabled':False})
    monkeypatch.setattr(S,'load_node_config',lambda:SimpleNamespace(node_id='study',node_name='Study',role='standalone',host_address=None))
    note=memory.save_fact('local','PRIVATE_LINKED_BODY: change the cable',title='Cable suggestion')
    link=cases._pointer(cases.review_evidence('local','note',note['id']))
    row=cases.save('local',cases.Create(request_id='case-fixture',title='Printer stalls',symptom='Pages stop halfway.',
        steps=[{'id':'planned','text':'Restart the router','status':'planned','outcome':'Maybe will help'},
               {'id':'skipped','text':'Replace the cable','status':'skipped','outcome':'Not done'},
               {'id':'tried','text':'Print a test page','status':'tried','outcome':'The test page still stalled'},
               {'id':'omitted','text':'PRIVATE_UNSELECTED_STEP','status':'tried','outcome':'Unselected'}],evidence=[link]).model_dump())['case']
    def forbidden(*a,**kw): pytest.fail('Selected cases cannot reach actions, probes, implicit notes, old chat or mesh')
    for target,names in [(ai,('_route_action_intent','_tool_answer','diagnostic_answer','image_reply','_find_mesh_ai_peer','_should_prefer_mesh')),
        (lm,('diagnostic_answer','image_reply','proxy_chat_to_host')),(memory,('relevant',)),(chat_continuity,('history',))]:
        for name in names: monkeypatch.setattr(target,name,forbidden)
    calls=[]
    manager=SimpleNamespace(ensure_running=lambda:True,active_preset_id='standard',base_url='http://127.0.0.1:19999',
        text_capacity=lambda:{'status':'configured','context_tokens':4096,'source':'owned_runtime_launch','model':'standard'})
    monkeypatch.setattr(ai.BundledAIManager,'get',lambda:manager)
    def complete(base,payload,**kw): calls.append(payload['messages']);return {'choices':[{'message':{'content':'Review this selected case [C1].'}}]}
    def stream(url,payload,**kw): calls.append(payload['messages']);yield json.dumps({'choices':[{'delta':{'content':'Review this selected case [C1].'}}]})
    monkeypatch.setattr(ai,'_llama_post',complete);monkeypatch.setattr(ai,'_llama_stream_raw',stream)
    monkeypatch.setattr(lm,'choose_model',lambda *a,**kw:{'id':'fixture-lm'})
    monkeypatch.setattr(S.lm_provider,'complete',lambda **kw:calls.append(kw['messages']) or {'text':'Review this selected case [C1].','model':'fixture-lm'})
    return SimpleNamespace(row=row,note=note,link=link,calls=calls,manager=manager)


def ref(fixture,**extra):
    return {'id':fixture.row['id'],'revision':fixture.row['revision'],'step_ids':['skipped','tried'],'include_resolution':False,'evidence_refs':[fixture.link],**extra}


def req(fixture,**extra):
    return ai.ChatRequest(message='What should I consider next?',case_ref=ref(fixture),use_saved_memory=False,use_conversation_history=False,**extra)


def result(response):
    assert response.status_code==200,response.text
    if 'text/event-stream' not in response.headers.get('content-type',''):return response.json()
    frames=[json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
    assert frames[-1]['type']=='done',frames
    data={}
    for frame in frames:
        if frame['type']=='meta':data.update(frame)
    data['reply']=''.join(frame['text'] for frame in frames if frame['type']=='delta');return data


def test_preparation_only_supplies_reviewed_whole_fields_and_pointer_metadata(fixture):
    before=cases.read_all('local')
    prepared=C.prepare('local',req(fixture))
    text=json.dumps(prepared['messages'])
    assert 'PRIVATE_LINKED_BODY' not in text and 'PRIVATE_UNSELECTED_STEP' not in text
    assert 'Restart the router' not in text
    assert 'Replace the cable' in text and 'The test page still stalled' in text
    assert fixture.link['revision'] in text and 'current' in text
    receipt=prepared['case_context']
    assert receipt['omitted_step_count']==2 and receipt['omitted_link_count']==0
    assert [s['status'] for s in receipt['steps']]==['skipped','tried']
    assert 'stalled' not in json.dumps(receipt) and 'symptom' not in receipt
    assert prepared['evidence_context']['sources'][0]['kind']=='case'
    assert cases.read_all('local')==before


@pytest.mark.parametrize('operation',['changed','deleted'])
def test_linked_note_changes_are_metadata_only_and_never_copy_old_or_current_body(operation,fixture):
    memory.change('local',fixture.note['id'],'NEW_PRIVATE_BODY' if operation=='changed' else None)
    prepared=C.prepare('local',req(fixture))
    assert prepared['case_context']['evidence_links'][0]['availability']==('changed' if operation=='changed' else 'unavailable')
    assert 'PRIVATE_LINKED_BODY' not in str(prepared) and 'NEW_PRIVATE_BODY' not in str(prepared)
    assert prepared['case_context']['revision']==fixture.row['revision']


@pytest.mark.parametrize('path',PATHS)
def test_all_routes_use_reviewed_case_input_and_metadata_without_history_or_tools(path,client,fixture):
    body={'message':'What should I consider next?','case_ref':ref(fixture),'brain':'lmstudio','use_saved_memory':False,'use_conversation_history':False}
    data=result(client.post(path,json=body))
    assert data['handled_by']=='case_context' and len(fixture.calls)==1
    assert len(fixture.calls[0])==2 and 'PRIVATE_LINKED_BODY' not in str(fixture.calls)
    assert data['case_context']['id']==fixture.row['id'] and data['conversation_context']['status']=='disabled'
    assert data['evidence_context']['citations']==[{'reference':'[C1]','handle':'C1'}]
    stored=next(iter(S.load_conversations().values()))['messages'][-1]
    assert stored['case_context']==data['case_context'] and 'recorded_answer' not in stored
    assert not any(key in stored for key in ('case_ref','messages','symptom','resolution','steps'))
    public=ai._public_conversation_turn(stored)
    assert public['case_context']==data['case_context']


@pytest.mark.parametrize('path',PATHS)
def test_case_outcomes_are_deterministic_and_planned_skipped_never_run(path,client,fixture,monkeypatch):
    monkeypatch.setattr(fixture.manager,'ensure_running',lambda:pytest.fail('No inference for recorded case outcomes'))
    body={'message':'Did you restart the router, and is it fixed?','case_ref':ref(fixture,step_ids=['planned','skipped','tried'])}
    data=result(client.post(path,json=body))
    assert data['handled_by']=='case_outcome' and not fixture.calls
    assert '**planned**' in data['reply'] and '**skipped**' in data['reply'] and '**tried**' in data['reply']
    assert 'not recorded as tried' in data['reply'] and 'The selected case remains open' in data['reply']
    assert data['evidence_context']['interpretation']=='backend'


@pytest.mark.parametrize('include',[False,True])
def test_user_resolution_is_optional_and_not_independent_current_health(include,fixture):
    row=fixture.row
    values={key:row[key] for key in ('title','symptom','status','archived','steps','resolution')}
    values.update(status='resolved',resolution='A rear USB port worked for my test page.',evidence=[fixture.link],expected_revision=row['revision'])
    fixture.row=cases.save('local',cases.Update(**values).model_dump(),row['id'])['case']
    request=ai.ChatRequest(message='What fixed it last time?',case_ref=ref(fixture,include_resolution=include))
    answer=C.prepare('local',request)['recorded_answer']['text']
    assert ('rear USB' in answer)==include
    assert ('not an independent test' if include else 'resolution text was not selected') in answer


@pytest.mark.parametrize('path',PATHS)
@pytest.mark.parametrize('problem',['revision','owner','step','link'])
def test_forged_stale_or_foreign_references_cannot_send_or_execute(problem,path,client,fixture):
    selected=ref(fixture)
    if problem=='revision':selected['revision']='0'*64
    elif problem=='owner':
        other=cases.save('other',cases.Create(request_id='other',title='Other owner',symptom='PRIVATE_OTHER_CASE').model_dump())['case']
        selected.update(id=other['id'],revision=other['revision'])
    elif problem=='step':selected['step_ids']=['not-in-this-case']
    else:selected['evidence_refs']=[{**fixture.link,'revision':'0'*64}]
    response=client.post(path,json={'message':'What next?','case_ref':selected,'user_id':'other'})
    assert response.status_code==(404 if problem=='owner' else 409),response.text
    assert not fixture.calls and 'PRIVATE_OTHER_CASE' not in response.text


@pytest.mark.parametrize('extra',[{'target_id':'host'},{'diagnostic_id':'report'},{'documents':[{'name':'x.txt','text':'file'}]},
    {'note_refs':[{'id':'note','revision':'a'*64}]},{'image_b64':'abc'},{'include_vault_secrets':True},{'secret_keys':['secret']},{'script_request':True},{'raw_input':'Hidden different command'}])
def test_other_context_and_action_modes_rejected_before_private_read(extra,fixture,monkeypatch):
    request=lm.ChatRequest(message='What next?',case_ref=ref(fixture),**extra)
    monkeypatch.setattr(cases,'get_case',lambda *a:pytest.fail('Exclusivity before private reads'))
    with pytest.raises(HTTPException) as error:C.prepare('local',request)
    assert error.value.status_code==422


def test_whole_selection_budget_never_silently_drops_steps(fixture):
    with pytest.raises(HTTPException) as error:C.prepare('local',req(fixture),budget=TextBudget(character_limit=1800,max_tokens=512))
    assert error.value.status_code==422
    assert not fixture.calls


def test_receipt_filters_bodies_and_rejects_false_coverage_and_case_citations_require_revision(fixture):
    receipt=C.prepare('local',req(fixture))['case_context']
    assert 'PRIVATE' not in str(C.public_receipt({**receipt,'symptom':'PRIVATE','resolution':'PRIVATE'}))
    assert C.public_receipt({**receipt,'linked_bodies_included':True}) is None
    assert C.public_receipt({**receipt,'omitted_step_count':30}) is None
    evidence=answer_evidence.build(case=receipt)
    assert answer_evidence.finalize(evidence,'[C1] [N1] [R1]')['invalid_citations']==2
    bad=copy.deepcopy(evidence);bad['sources'][0].pop('revision')
    assert answer_evidence.public_receipt(bad) is None


def test_capability_names_the_exact_standalone_protocol(client,fixture):
    response=client.get('/api/intelligence/cases/capabilities')
    assert response.status_code==200 and response.json()['case_context']==C.PROTOCOL


@pytest.mark.parametrize('path',PATHS)
@pytest.mark.parametrize('failure',['missing_key','corrupt_store'])
def test_unreadable_case_never_sends_or_replaces_private_bytes(path,failure,client,fixture):
    source=private_path('local','cases');key=Path(S.DATA_DIR)/'memory_key.bin'
    if failure=='missing_key':key.unlink()
    else:source.write_bytes(b'{unreadable synthetic store')
    before=source.read_bytes()
    response=client.post(path,json={'message':'Did you finish it?','case_ref':ref(fixture)})
    assert response.status_code==503,response.text
    assert source.read_bytes()==before and not fixture.calls
    if failure=='missing_key':assert not key.exists()


@pytest.mark.parametrize('selected',[{'step_ids':['same','same']},{'step_ids':['s'+str(n) for n in range(9)]},
    {'include_resolution':'false'},{'evidence_refs':[{'kind':'note','id':'n'+str(n),'revision':'a'*64} for n in range(9)]}])
def test_selection_limits_rejected_before_reads(selected,client,fixture,monkeypatch):
    monkeypatch.setattr(cases,'get_case',lambda *a:pytest.fail('Invalid selection must fail before private reads'))
    response=client.post('/api/ai/chat',json={'message':'What next?','case_ref':ref(fixture,**selected)})
    assert response.status_code==422 and not fixture.calls


@pytest.mark.parametrize('path',PATHS)
def test_unavailable_or_empty_provider_reports_case_failure_without_saved_answer(path,client,fixture,monkeypatch):
    if path=='/chat':monkeypatch.setattr(S.lm_provider,'complete',lambda **kw:{'text':'','model':'fixture'})
    else:monkeypatch.setattr(fixture.manager,'ensure_running',lambda:False)
    response=client.post(path,json={'message':'What should I consider next?','case_ref':ref(fixture),'brain':'lmstudio'})
    if path.endswith('/stream'):
        assert '"type": "error"' in response.text and '"type": "done"' not in response.text
    else:assert response.status_code in (409,502)
    assert 'case' in response.text and 'note question' not in response.text
    assert all(not c.get('messages') for c in S.load_conversations().values())


def test_default_selection_excludes_all_optional_case_fields_even_with_history_requested(client,fixture):
    data=result(client.post('/api/ai/chat',json={'message':'What next?',
        'case_ref':{'id':fixture.row['id'],'revision':fixture.row['revision']},'use_saved_memory':True,'use_conversation_history':True}))
    assert data['case_context']['steps']==[] and data['case_context']['evidence_links']==[]
    assert data['case_context']['resolution_included'] is False
    assert data['conversation_context']['status']=='none' and data['conversation_context']['included_messages']==0
    assert data['conversation_context']['recall_scope']['standalone_reference'] is True and 'PRIVATE_' not in str(fixture.calls)
