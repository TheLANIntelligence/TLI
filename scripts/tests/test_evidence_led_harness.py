"""Synthetic source/corpus/arm gates; no real weights, process or network calls."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import pytest

ROOT = Path(__file__).resolve().parents[2]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path); value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value); return value
h = load('evidence_test_harness', ROOT / 'scripts/evaluate_evidence_led.py')
c = load('evidence_test_capture', ROOT / 'scripts/capture_chat_routes.py')


def test_explicit_challenger_capture_has_its_actual_capability_identity():
    cases = [{'id': 'synthetic-capability', 'route_fixture': {'request': {'message': 'Explain what evidence a saved report can provide.', 'use_saved_memory': False}}}]
    value = c.capture(ROOT, cases, preset_id='qwen3_8b')
    row = value['cases'][0]
    assert row['route_consistent'] and row['status'] == 'model_request'
    text = json.dumps(row['messages'])
    assert 'qwen3_8b' in text and 'Qwen3 8B' in text and 'Qwen2.5 3B (Standard)' not in text
    assert all(r['model_calls'] == 1 and r['seed_stores_unchanged'] and r['forbidden_calls'] == [] for r in row['routes'])


def test_unsupported_preset_is_rejected_before_capture_process(monkeypatch):
    monkeypatch.setattr(c.subprocess, 'run', lambda *a, **k: pytest.fail('Must not spawn'))
    for preset in ('vision', 'new-family', '../standard', None):
        with pytest.raises(ValueError): c.capture(ROOT, [{'id': 'x'}], preset_id=preset)


def test_standard_default_remains_exactly_same_as_explicit_standard():
    case = {'id': 'synthetic-default', 'route_fixture': {'request': {'message': 'Explain saved evidence in one sentence.'}}}
    implicit = c.capture(ROOT, [case])['cases'][0]
    explicit = c.capture(ROOT, [case], preset_id='standard')['cases'][0]
    assert implicit['messages'] == explicit['messages'] and implicit['request_sha256'] == explicit['request_sha256']


def test_candidate_sources_bind_once_and_reject_later_arm_drift(tmp_path):
    h.write(tmp_path / 'policy.json', {'synthetic': True})
    h.bind_source(tmp_path, 'candidate_standard', 'a' * 64, {})
    h.bind_source(tmp_path, 'candidate_challenger', 'a' * 64, {})
    with pytest.raises(ValueError): h.bind_source(tmp_path, 'candidate_challenger', 'b' * 64, {})
    with pytest.raises(ValueError): h.bind_source(tmp_path, 'baseline_standard', 'b' * 64, {'baseline_source_fingerprint': 'a' * 64})


@pytest.mark.parametrize('override', [{'max_tokens': 128}, {'temperature': .7}, {'max_tokens': None}, {'temperature': None}])
def test_generation_overrides_cannot_be_evaluated_as_frozen_defaults(override):
    payload = {'max_tokens': 512, 'temperature': 0, **override}
    routes = {'cases': [{'status': 'model_request', 'routes': [{'payload': payload}]}]}
    with pytest.raises(ValueError, match='generation settings'):
        h.validate_generation(routes, h.GENERATION)


def test_actual_json_and_sse_generation_match_and_deterministic_has_no_payload():
    h.validate_generation({'cases': [{'status': 'model_request', 'routes': [
        {'payload': {'max_tokens': 512, 'temperature': 0, 'stream': flag}} for flag in (False, True)]},
        {'status': 'deterministic_response', 'routes': [{'payload': None}]}]}, h.GENERATION)


def test_prepared_metadata_and_final_ranges_survive_real_report_constructor():
    messages = [{'role': 'system', 'content': 'Only L7 supplied.'}, {'role': 'user', 'content': 'Read Café.'}]
    case = {'id': 'sample', 'purpose': 'Synthetic reporting contract', 'partition': 'development', 'rubric': ['Only line7'],
        'expected_mentions': ['Café'], 'unexpected_mentions': ['invented'], 'source_lines': {'sample.txt': 20}}
    route = {'id': 'sample', 'status': 'model_request', 'lane': 'actual_bundled_chat_routes', 'messages': messages,
        'request_sha256': c.digest(messages), 'routes': [{'response': {'document_context': {'documents': [
            {'name': 'sample.txt', 'line_count': 20, 'coverage': {'ranges': [[7, 7]]}}]}}}]}
    request = h.captured_requests([case], {'cases': [route]}, c)[0]
    assert request['purpose'] == case['purpose'] and request['expected_mentions'] == ['Café']
    assert request['supplied_ranges'] == {'sample.txt': [[7, 7]]}
    evaluator = load('evidence_real_report_test', ROOT / 'scripts/evaluate_ai_answers.py')
    report = evaluator.make_report([request], 'synthetic', max_tokens=512, context_tokens=4096, timeout=90, stream=True)
    assert report['cases'][0]['request_sha256'] == request['captured_request_sha256']


@pytest.mark.parametrize('status,stopped,exit_code', [('failed', True, 1), ('incomplete', True, 1), ('responses_collected', False, 1), ('responses_collected', True, 0)])
def test_collection_cli_exit_requires_complete_and_stopped(monkeypatch, tmp_path, status, stopped, exit_code):
    monkeypatch.setattr(h, 'collect_arm', lambda args: {'status': status, 'child_stopped': stopped})
    args = ['--workspace', str(tmp_path), '--arm', 'baseline_standard', '--expected-source-fingerprint', 'a' * 64,
        '--expected-policy-sha256', 'b' * 64, '--runtime-lock', str(tmp_path / 'lease'), '--collect']
    assert h.main(args) == exit_code


def test_bad_capture_cannot_reach_model_checks_or_runner(tmp_path, monkeypatch):
    folder = tmp_path / 'capture'; folder.mkdir()
    case = {'id': 'sample', 'route_fixture': {}}
    policy = {'baseline_source_fingerprint': 'a' * 64}
    h.write(tmp_path / 'policy.json', policy)
    h.write(folder / 'fixtures.json', {'cases': [case]})
    h.write(folder / 'routes.json', {'cases': [{'id': 'sample', 'lane': 'actual_bundled_chat_routes', 'route_consistent': False}]})
    h.write(folder / 'captured-requests.json', {'cases': []})
    manifest = {'arm': 'baseline_standard', 'preset_id': 'standard', 'source_fingerprint': 'a' * 64,
        'policy': h.bind(tmp_path / 'policy.json'), 'tooling': [], 'files': {p.name: h.bind(p) for p in folder.iterdir()},
        'holdout': h.bind(tmp_path / 'policy.json'), 'source_manifest': h.bind(tmp_path / 'policy.json'), 'inference_preflight': {'ok': True}}
    h.write(folder / 'capture-manifest.json', manifest)
    monkeypatch.setattr(h, 'policy_and_cases', lambda *a: (policy, [case]))
    original = h.load
    monkeypatch.setattr(h, 'load', lambda name, path: original(name, path) if name == 'evidence_capture_contract' else pytest.fail('Reached runtime/source after failed capture'))
    with pytest.raises(ValueError, match='disagree'):
        h.collect_arm(SimpleNamespace(workspace=tmp_path, capture=folder, arm='baseline_standard', expected_source_fingerprint='a' * 64,
                                     expected_policy_sha256=manifest['policy']['sha256']))


def test_full_collect_adapter_real_report_fake_runtime_stops_child(tmp_path, monkeypatch):
    source = tmp_path / 'source'; (source / 'scripts').mkdir(parents=True)
    evaluator = (ROOT / 'scripts/evaluate_ai_answers.py').read_text(encoding='utf-8')
    evaluator += "\ndef request_answer_stream(endpoint,payload,timeout):\n    assert payload['messages'][-1]['content']=='Explain Café evidence.'\n    return {'model':payload['model'],'choices':[{'message':{'content':'Café evidence only'},'finish_reason':'stop'}]}\n"
    (source / 'scripts/evaluate_ai_answers.py').write_text(evaluator, encoding='utf-8')
    (source / 'scripts/release_snapshot.py').write_text("def verify_snapshot(*args):return {'fingerprint':'" + 'a' * 64 + "'}\n")
    source_manifest = tmp_path / 'source-manifest.json'; h.write(source_manifest, {'synthetic': True})
    model = tmp_path / 'Qwen2.5-3B-Instruct-Q4_K_M.gguf'; model.write_bytes(b'synthetic-not-weights')
    binary = tmp_path / 'fake.exe'; binary.write_bytes(b'synthetic-not-executable')
    policy = {'baseline_source_fingerprint': 'a' * 64, 'runtime_sha256': h.sha(binary), 'generation': h.GENERATION,
        'models': {'standard': {'filename': model.name, 'bytes': model.stat().st_size, 'sha256': h.sha(model)}}}
    h.write(tmp_path / 'policy.json', policy)
    messages = [{'role': 'user', 'content': 'Explain Café evidence.'}]
    case = {'id': 'fake', 'purpose': 'Synthetic full adapter', 'rubric': ['Evidence only'], 'partition': 'development', 'route_fixture': {}}
    route = {'id': 'fake', 'status': 'model_request', 'lane': 'actual_bundled_chat_routes', 'messages': messages,
        'request_sha256': c.digest(messages), 'route_consistent': True, 'routes': [
            {'path': p, 'status': 'model_request', 'http_status': 200, 'messages': messages, 'model_calls': 1,
             'payload': {'messages': messages, 'max_tokens': 512, 'temperature': 0},
             'forbidden_calls': [], 'seed_stores_unchanged': True} for p in c.PATHS]}
    requests = h.captured_requests([case], {'cases': [route]}, c)
    folder = tmp_path / 'capture'; folder.mkdir()
    for name, value in [('fixtures.json', {'cases': [case]}), ('routes.json', {'cases': [route]}), ('captured-requests.json', {'version': 1, 'cases': requests})]: h.write(folder / name, value)
    manifest = {'arm': 'baseline_standard', 'preset_id': 'standard', 'phase': 'baseline', 'source': str(source), 'source_fingerprint': 'a' * 64,
        'policy': h.bind(tmp_path / 'policy.json'), 'tooling': [], 'files': {p.name: h.bind(p) for p in folder.iterdir()},
        'holdout': h.bind(tmp_path / 'policy.json'), 'source_manifest': h.bind(source_manifest), 'inference_preflight': {'ok': True}}
    h.write(folder / 'capture-manifest.json', manifest)
    monkeypatch.setattr(h, 'policy_and_cases', lambda *a: (policy, [case]))
    runner = load('full_evidence_fake_runner', ROOT / 'scripts/evaluate_isolated_model.py')
    monkeypatch.setattr(runner, 'launch_options', lambda *a: ([], None))
    monkeypatch.setattr(runner, 'resources', lambda *a: {'sufficient': True, 'total_ram_bytes': 64 * 1024**3})
    children = []; commands = []
    def launch(command, **kwargs):
        assert not children
        child = SimpleNamespace(pid=765432, stopped=False)
        child.poll = lambda: 0 if child.stopped else None
        child.terminate = lambda: setattr(child, 'stopped', True)
        child.wait = lambda timeout: 0
        children.append(child); commands.append(command); return child
    monkeypatch.setattr(runner.subprocess, 'Popen', launch)
    monkeypatch.setattr(runner, 'read_json', lambda url: {'status': 'ok'} if url.endswith('/health') else {'data': [{'id': commands[0][commands[0].index('--alias') + 1]}]})
    monkeypatch.setattr(runner, 'ProcessMetrics', lambda pid: SimpleNamespace(start=lambda: None, begin_case=lambda: None, end_case=lambda: {}, stop=lambda: {}))
    original = h.load
    monkeypatch.setattr(h, 'load', lambda name, path: runner if name == 'evidence_owned_runner' else original(name, path))
    result = h.collect_arm(SimpleNamespace(workspace=tmp_path, capture=folder, arm='baseline_standard', expected_source_fingerprint='a' * 64,
        expected_policy_sha256=manifest['policy']['sha256'], model_file=model, runtime=binary, runtime_lock=tmp_path / '.runtime.lock'))
    assert result['status'] == 'responses_collected' and result['child_stopped'] and children[0].stopped
    recorded = h.read(folder / 'collection-manifest.json'); answers = h.verified(recorded['files']['answers.json'])
    assert answers['cases'][0]['answer'] == 'Café evidence only'
    assert answers['cases'][0]['request_sha256'] == requests[0]['captured_request_sha256']
    assert '--gpu-layers' in commands[0] and commands[0][commands[0].index('--threads') + 1] == '4'
