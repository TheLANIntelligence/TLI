"""Synthetic reporting/lifecycle preflight: never reads study questions or weights."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
harness=load('reliability_harness_test',ROOT/'scripts/evaluate_answer_reliability.py')
runner=load('reliability_runner_test',ROOT/'scripts/evaluate_isolated_model.py')

def input_fixture():
    messages=[{'role':'system','content':'Synthetic provided evidence only.'},{'role':'user','content':'Keep Café 音楽.'}]
    digest=hashlib.sha256(json.dumps(messages,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    return {'id':'synthetic','purpose':'Exercise actual frozen reporting schema.','rubric':['Exact supplied evidence only.'],
        'messages':messages,'captured_request_sha256':digest,'route_lane':'actual_bundled_chat_routes'}

def route_fixture():
    request=input_fixture()
    pair=[{'path':path,'http_status':200,'status':'model_request','seed_stores_unchanged':True,
        'forbidden_calls':[],'model_calls':1,'messages':request['messages']} for path in ('/api/ai/chat','/api/ai/chat/stream')]
    return {'cases':[{'id':'synthetic','lane':'actual_bundled_chat_routes','status':'model_request','route_consistent':True,
        'messages':request['messages'],'request_sha256':request['captured_request_sha256'],'routes':pair}]},[{'id':'synthetic','route_fixture':{}}],[request]

def test_good_capture_and_frozen_report_accept_exact_messages_without_inference():
    routes,fixtures,requests=route_fixture()
    assert harness.validate_capture(routes,fixtures,requests)
    review=load('actual_reliability_report_test',ROOT/'scripts/evaluate_ai_answers.py')
    report=review.make_report(requests,'synthetic',max_tokens=512,timeout=90,context_tokens=4096,stream=True)
    assert report['cases'][0]['request_sha256']==requests[0]['captured_request_sha256']
    assert report['cases'][0]['status']=='not_run'

@pytest.mark.parametrize('mode',['inconsistent','false-consistent','effect','mutation','failure','route-error','duplicate-call','missing-route','duplicate-id','raw-disguise','changed-input'])
def test_invalid_capture_cannot_pass_inference_gate(mode):
    routes,fixtures,requests=route_fixture();row=routes['cases'][0]
    if mode=='inconsistent':row['route_consistent']=False
    elif mode=='false-consistent':row['routes'][0]['messages']=[{'role':'user','content':'Changed'}]
    elif mode=='effect':row['routes'][0]['forbidden_calls']=['execute']
    elif mode=='mutation':row['routes'][0]['seed_stores_unchanged']=False
    elif mode=='failure':row['status']='capture_failed'
    elif mode=='route-error':row['status']='route_error'
    elif mode=='duplicate-call':row['routes'][0]['model_calls']=2
    elif mode=='missing-route':row['routes'].pop()
    elif mode=='duplicate-id':routes['cases'].append(copy.deepcopy(row))
    elif mode=='raw-disguise':row.update(lane='handwritten_provider_fixture',routes=[],route_consistent=None)
    else:requests[0]['messages']=[{'role':'user','content':'Changed'}]
    with pytest.raises(ValueError):harness.validate_capture(routes,fixtures,requests)

def test_full_fake_runtime_uses_real_report_and_confirms_child_stop(tmp_path,monkeypatch):
    source=tmp_path/'source';(source/'scripts').mkdir(parents=True)
    evaluator=(ROOT/'scripts/evaluate_ai_answers.py').read_text(encoding='utf-8')
    evaluator+='''\n
def request_answer_stream(endpoint,payload,timeout):
    assert payload['messages'][-1]['content']=='Keep Café 音楽.'
    return {'model':payload['model'],'choices':[{'message':{'content':'Café 音楽'},'finish_reason':'stop'}]}
'''
    (source/'scripts/evaluate_ai_answers.py').write_text(evaluator,encoding='utf-8')
    model=tmp_path/'synthetic.gguf';binary=tmp_path/'synthetic.exe'
    model.write_bytes(b'not weights');binary.write_bytes(b'not executable')
    corpus=tmp_path/'captured.json';corpus.write_text(json.dumps({'version':1,'cases':[input_fixture()]},ensure_ascii=False),encoding='utf-8')
    monkeypatch.setattr(runner,'launch_options',lambda *a:([],None))
    monkeypatch.setattr(runner,'resources',lambda *a:{'sufficient':True,'total_ram_bytes':64*1024**3})
    children=[];commands=[]
    def launch(command,**kwargs):
        assert not children
        child=SimpleNamespace(pid=123456,stopped=False)
        child.poll=lambda:0 if child.stopped else None
        child.terminate=lambda:setattr(child,'stopped',True)
        child.wait=lambda timeout:0
        children.append(child);commands.append(command);return child
    monkeypatch.setattr(runner.subprocess,'Popen',launch)
    monkeypatch.setattr(runner,'read_json',lambda url:{'status':'ok'} if url.endswith('/health') else {'data':[{'id':commands[0][commands[0].index('--alias')+1]}]})
    monkeypatch.setattr(runner,'ProcessMetrics',lambda pid:SimpleNamespace(start=lambda:None,begin_case=lambda:None,end_case=lambda:{},stop=lambda:{}))
    report=runner.run(SimpleNamespace(source_root=source,model_file=model,runtime=binary,output=tmp_path/'results',
        context=4096,threads=4,max_tokens=512,timeout=90,case=[],preset_id=None,extra_corpus=[],prepared_corpus=corpus,
        measure_stream=True,repeat_case=[],repeats=3))
    assert report['status']=='responses_collected' and report['child_stopped'] and children[0].stopped
    answers=json.loads((tmp_path/'results/answers.json').read_text(encoding='utf-8'))
    assert answers['cases'][0]['answer']=='Café 音楽'
    assert answers['cases'][0]['input_source']=='captured_chat_route'
    assert answers['cases'][0]['request_sha256']==input_fixture()['captured_request_sha256']

def test_failed_collection_cli_has_explicit_nonzero_and_stop_guard():
    import ast
    tree=ast.parse((ROOT/'scripts/evaluate_answer_reliability.py').read_text(encoding='utf-8'))
    guard=tree.body[-1].body[-1]
    for status,stopped,expected in [('failed',True,True),('incomplete',True,True),('responses_collected',False,True),('responses_collected',True,False)]:
        should_exit=eval(compile(ast.Expression(guard.test),'<guard>','eval'),{'args':SimpleNamespace(collect=True),'value':{'status':status,'child_stopped':stopped}})
        assert should_exit is expected

