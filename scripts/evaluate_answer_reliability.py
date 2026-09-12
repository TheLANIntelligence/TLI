"""Frozen Standard-only before/after study with a separate actual-Chat route lane.

Capture is offline. Collection is explicit and delegates the sole owned runtime
to evaluate_isolated_model. Never reads or changes live TLI or its selection.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace

HERE=Path(__file__).resolve().parent
ROOT=HERE.parent
PRESET='standard'
MODEL_SHA='9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94'
RUNTIME_SHA='3b0ada0e76b1cc5668c7e2bbac7784a6e978de9535aa2ad1f749893f79456e58'

def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec)
    sys.modules[name]=value;spec.loader.exec_module(value);return value

def sha(path):
    value=hashlib.sha256()
    with Path(path).open('rb') as stream:
        while chunk:=stream.read(4*1024*1024):value.update(chunk)
    return value.hexdigest()

def read(path):return json.loads(Path(path).read_text(encoding='utf-8'))
def write(path,value):
    assert not path.exists(),'Preserve previous evidence; use a new path'
    path.write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
def bound(path):return {'path':str(Path(path).resolve()),'sha256':sha(path)}

def frozen_cases(source,workspace,policy_hash):
    policy_file=workspace/'sealed/policy.json';policy=read(policy_file)
    assert sha(policy_file)==policy_hash and policy['frozen_before_answers'] is True
    heldout=workspace/'sealed/heldout.json';assert sha(heldout)==policy['heldout_sha256']
    values=[]
    for name,expected in policy['original_corpus_sha256'].items():
        path=source/'scripts/fixtures'/name;assert sha(path)==expected
        values.extend(read(path)['cases'])
    for value in values:value['partition']='handwritten_stress' if 'messages' in value and 'preparation' not in value and 'document_preparation' not in value else 'development'
    held=read(heldout)['cases'];assert len(held)==24 and len({c['family'] for c in held})==12
    values.extend(held)
    assert len(values)==len({v['id'] for v in values})==55
    return values,policy

def summary(routes):
    counts={}
    for case in routes['cases']:
        key=case.get('status') or case['lane'];counts[key]=counts.get(key,0)+1
    return {'positions':len(routes['cases']),'counts':counts,
        'route_inconsistencies':sum(c.get('route_consistent') is False for c in routes['cases']),
        'forbidden_effect_attempts':sum(len(r.get('forbidden_calls',[])) for c in routes['cases'] for r in c.get('routes',[]))}

def validate_capture(routes, fixtures, requests):
    """Fail before runtime startup, while retaining invalid capture evidence."""
    def require(condition, message):
        if not condition:raise ValueError(message)
    rows=routes.get('cases',[]);ids=[c['id'] for c in fixtures]
    require(len(rows)==len(ids)==len(set(ids)) and {r.get('id') for r in rows}==set(ids), 'Capture identities do not match frozen fixtures')
    require(len({r.get('id') for r in rows})==len(rows), 'Duplicate route capture')
    expected={};fixture_by_id={c['id']:c for c in fixtures}
    for row in rows:
        fixture=fixture_by_id[row['id']]
        raw='messages' in fixture and not any(key in fixture for key in ('route_fixture','preparation','document_preparation'))
        require((row.get('lane')=='handwritten_provider_fixture')==raw, 'Capture lane differs from frozen fixture contract')
        if row.get('lane')=='handwritten_provider_fixture':
            require(not row.get('routes') and row.get('route_consistent') is None, 'Raw fixture cannot claim actual routing')
        else:
            require(row.get('lane')=='actual_bundled_chat_routes' and row.get('route_consistent') is True, 'Actual routes disagree or capture is incomplete')
            require(row.get('status') in ('model_request','deterministic_response'), 'Actual route capture failed or attempted an effect')
            pair=row.get('routes',[])
            require(len(pair)==2 and {r.get('path') for r in pair}=={'/api/ai/chat','/api/ai/chat/stream'}, 'Both actual routes must be captured')
            for r in pair:
                require(r.get('status')==row['status'] and r.get('http_status')==200 and r.get('seed_stores_unchanged') is True
                    and r.get('forbidden_calls')==[], 'Actual route failed, changed a store or attempted an effect')
                require(r.get('model_calls')==(1 if row['status']=='model_request' else 0), 'Unexpected model call count')
            if row['status']=='model_request':
                require(all(r.get('messages')==row.get('messages') for r in pair), 'Captured request differs between routes')
            else:
                require(pair[0].get('handled_by')==pair[1].get('handled_by') and pair[0].get('response',{}).get('reply')==pair[1].get('response',{}).get('reply'), 'Deterministic route answers disagree')
        if row.get('status')=='model_request' or row.get('lane')=='handwritten_provider_fixture':expected[row['id']]=row
    require(len(requests)==len(expected) and len({r['id'] for r in requests})==len(requests), 'Captured model request count differs')
    for request in requests:
        row=expected.get(request['id'])
        require(row is not None and request['messages']==row.get('messages'), 'Captured input was not supplied by its recorded lane')
        digest=hashlib.sha256(json.dumps(request['messages'],sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        require(digest==request.get('captured_request_sha256')==row.get('request_sha256'), 'Captured input hash changed')
    return True

def capture_phase(args):
    source=args.source_root.resolve(strict=True);work=args.workspace.resolve(strict=True);out=args.output.resolve()
    assert out.is_relative_to(work) and out!=work and not out.exists()
    snapshot=module('reliability_snapshot',source/'scripts/release_snapshot.py')
    verified=snapshot.verify_snapshot(source,args.snapshot_manifest)
    assert verified['fingerprint']==args.expected_source_fingerprint
    cases,policy=frozen_cases(source,work,args.expected_policy_sha256)
    tooling=[bound(HERE/name) for name in ('capture_chat_routes.py','evaluate_answer_reliability.py','evaluate_isolated_model.py')]
    capture=module('reliability_capture',HERE/'capture_chat_routes.py')
    routes=capture.capture(source,cases,args.python)
    assert all(sha(item['path'])==item['sha256'] for item in tooling), 'Capture tooling changed during execution'
    assert snapshot.verify_snapshot(source,args.snapshot_manifest)['fingerprint']==verified['fingerprint']
    by_id={c['id']:c for c in cases};requests=[]
    for row in routes['cases']:
        case=by_id[row['id']]
        if row.get('status')=='model_request' or row['lane']=='handwritten_provider_fixture':
            messages=row['messages']
            assert row['request_sha256']==capture.digest(messages)
            requests.append({'id':row['id'],'messages':messages,'captured_request_sha256':row['request_sha256'],
                'purpose':case.get('purpose') or 'Frozen answer-reliability request',
                'partition':case['partition'],'route_lane':row['lane'],'family':case.get('family'),
                'rubric':case.get('rubric',case.get('expected',{})),'required_markers':case.get('required_markers',[]),
                'forbidden_markers':case.get('forbidden_markers',[]),'timing_probe':case.get('timing_probe',False)})
            for field in ('expected_mentions','unexpected_mentions','source_lines','supplied_ranges'):
                if field in case:requests[-1][field]=case[field]
            if row.get('routes'):
                docs=row['routes'][-1].get('response',{}).get('document_context') or {}
                for doc in docs.get('documents',[]):
                    requests[-1].setdefault('source_lines',{})[doc['name']]=doc['line_count']
                    if doc.get('coverage'):
                        requests[-1].setdefault('supplied_ranges',{})[doc['name']]=doc['coverage']['ranges']
    out.mkdir(parents=True)
    write(out/'routes.json',routes)
    write(out/'captured-requests.json',{'version':1,'cases':requests})
    write(out/'fixtures.json',{'version':1,'cases':cases})
    manifest={'schema_version':1,'phase':args.phase,'created_at':datetime.now(timezone.utc).isoformat(),
        'source':str(source),'source_fingerprint':verified['fingerprint'],'source_manifest':bound(args.snapshot_manifest),
        'policy':bound(work/'sealed/policy.json'),'holdout':bound(work/'sealed/heldout.json'),
        'tooling':tooling,
        'files':{name:bound(out/name) for name in ('routes.json','captured-requests.json','fixtures.json')},
        'summary':summary(routes),'generation':policy['generation'],'inference_called':False,
        'live_tli_contacted':False,'selection_changed':False,'physical_acceptance':'not_run',
        'limitations':['Synthetic auth, inventory, runtime availability and observations; not household service acceptance.',
            'Actual JSON/SSE routing and prompt building are captured. Model transport is substituted; deterministic answers are not classified as model answers.',
            'Earlier raw-provider fixtures remain a separate stress lane, not a statement of current Chat routing.',
            'Sealed answers must not guide implementation; baseline/final quality is assessed only after final tuning freeze.']}
    try:
        validate_capture(routes,cases,requests)
        manifest['inference_preflight']={'ok':True}
    except ValueError as error:
        manifest['inference_preflight']={'ok':False,'reason':str(error)}
    write(out/'capture-manifest.json',manifest)
    return {'capture':str(out/'capture-manifest.json'),'sha256':sha(out/'capture-manifest.json'),**manifest['summary']}

def collect_phase(args):
    folder=args.capture.resolve(strict=True);manifest=read(folder/'capture-manifest.json')
    for item in manifest['tooling']+list(manifest['files'].values())+[manifest['policy'],manifest['holdout'],manifest['source_manifest']]:
        assert sha(item['path'])==item['sha256'],'Captured artifact/tool changed'
    assert manifest['source_fingerprint']==args.expected_source_fingerprint
    assert manifest['policy']['sha256']==args.expected_policy_sha256
    validate_capture(read(folder/'routes.json'),read(folder/'fixtures.json')['cases'],read(folder/'captured-requests.json')['cases'])
    assert manifest.get('inference_preflight',{}).get('ok') is True, 'Capture is not approved for inference'
    assert sha(args.model_file)==MODEL_SHA and sha(args.runtime)==RUNTIME_SHA
    source=Path(manifest['source']);snapshot=module('reliability_snapshot',source/'scripts/release_snapshot.py')
    assert snapshot.verify_snapshot(source,Path(manifest['source_manifest']['path']))['fingerprint']==manifest['source_fingerprint']
    runner=module('reliability_owned_runner',HERE/'evaluate_isolated_model.py')
    output=folder/'standard';assert not output.exists()
    result=runner.run(SimpleNamespace(source_root=source,model_file=args.model_file,runtime=args.runtime,output=output,
        context=4096,threads=4,max_tokens=512,timeout=90,case=[],preset_id=PRESET,extra_corpus=[],
        prepared_corpus=folder/'captured-requests.json',measure_stream=True,runtime_lock=args.runtime_lock,
        repeat_case=[],repeats=3))
    assert snapshot.verify_snapshot(source,Path(manifest['source_manifest']['path']))['fingerprint']==manifest['source_fingerprint']
    record={'schema_version':1,'phase':manifest['phase'],'capture':bound(folder/'capture-manifest.json'),
        'source_fingerprint':manifest['source_fingerprint'],'policy':manifest['policy'],'holdout':manifest['holdout'],
        'status':result['status'],'child_stopped':result['child_stopped'],'selection_changed':False,'live_tli_contacted':False,
        'files':{p.name:bound(p) for p in output.iterdir() if p.is_file()},'physical_acceptance':'not_run',
        'quality_review':'not_run','recorded_at':datetime.now(timezone.utc).isoformat()}
    write(folder/'collection-manifest.json',record)
    return {'collection':str(folder/'collection-manifest.json'),'sha256':sha(folder/'collection-manifest.json'),
        'status':result['status'],'child_stopped':result['child_stopped']}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--workspace',type=Path,required=True)
    p.add_argument('--phase',choices=['baseline','final'])
    p.add_argument('--source-root',type=Path);p.add_argument('--snapshot-manifest',type=Path)
    p.add_argument('--expected-source-fingerprint',required=True);p.add_argument('--expected-policy-sha256',required=True)
    p.add_argument('--python',type=Path,default=Path(sys.executable));p.add_argument('--output',type=Path)
    p.add_argument('--collect',action='store_true');p.add_argument('--capture',type=Path)
    p.add_argument('--model-file',type=Path);p.add_argument('--runtime',type=Path);p.add_argument('--runtime-lock',type=Path)
    args=p.parse_args();value=collect_phase(args) if args.collect else capture_phase(args)
    print(json.dumps(value))
    if args.collect and (value['status']!='responses_collected' or value.get('child_stopped') is not True):sys.exit(1)
