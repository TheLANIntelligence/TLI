"""Four explicit isolated arms: three new-corpus comparisons and one regression.

Capture does not load a model. --collect is a separate, explicit owned-runtime
operation using frozen source, fixture, policy, tool and publisher-artifact hashes.
Legacy studies and live TLI selection/data are never edited.
"""
from __future__ import annotations
import argparse
import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
ARMS = {'baseline_standard': 'standard', 'candidate_standard': 'standard',
        'candidate_challenger': 'qwen3_8b', 'final_regression': 'standard'}
TOOLS = ('evaluate_evidence_led.py', 'capture_chat_routes.py', 'evaluate_answer_reliability.py', 'evaluate_isolated_model.py')
GENERATION = {'cpu_threads': 4, 'context_tokens': 4096, 'max_output_tokens': 512,
              'temperature': 0, 'stream': True, 'startup_limit_seconds': 120,
              'request_limit_seconds': 90, 'parallel': 1, 'retries_per_question': 0}


def require(ok, message):
    if not ok: raise ValueError(message)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); sys.modules[name] = module
    spec.loader.exec_module(module); return module


def read(path): return json.loads(Path(path).read_text(encoding='utf-8'))


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while chunk := stream.read(4 * 1024 * 1024): digest.update(chunk)
    return digest.hexdigest()


def bind(path): return {'path': str(Path(path).resolve()), 'sha256': sha(path)}


def write(path, value):
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2); stream.write('\n')


def verified(binding):
    require(sha(binding['path']) == binding['sha256'], 'Bound artifact changed')
    return read(binding['path'])


def policy_and_cases(work, expected_policy, arm):
    require(arm in ARMS, 'Unsupported study arm')
    path = work / 'policy.json'
    require(sha(path) == expected_policy, 'Frozen policy differs')
    policy = read(path)
    require(policy.get('generation') == GENERATION, 'Policy generation settings do not match this bounded evaluator')
    freeze = read(work / 'corpus-freeze.json')
    require(freeze['policy_sha256'] == expected_policy and policy['frozen_before_answers'] is True, 'Policy was not frozen before answers')
    require(policy['arms'][arm]['preset_id'] == ARMS[arm], 'Arm preset differs from frozen protocol')
    names = ['retained-regression.json'] if arm == 'final_regression' else ['development.json', 'heldout.json', 'raw-controls.json']
    cases = []
    for name in names:
        binding = policy['corpora'][name]
        value = verified(binding)['cases']
        require(len(value) == binding['cases'], 'Corpus count differs')
        cases.extend(copy.deepcopy(value))
    expected = 55 if arm == 'final_regression' else 44
    require(len(cases) == len({c['id'] for c in cases}) == expected, 'Frozen corpus identity/count differs')
    if arm != 'final_regression':
        require(sum(c['partition'] == 'heldout' for c in cases) == 24 and
                len({c['family'] for c in cases if c['partition'] == 'heldout'}) == 12, 'Heldout coverage differs')
        require(sum(c['partition'] == 'development' for c in cases) == 12 and
                sum(c['partition'] == 'handwritten_stress' for c in cases) == 8, 'Development/control coverage differs')
    return policy, cases


def bind_source(work, arm, fingerprint, policy):
    if arm == 'baseline_standard':
        require(fingerprint == policy['baseline_source_fingerprint'], 'Baseline source differs from frozen policy')
        return
    path = work / 'candidate-source-binding.json'
    value = {'schema_version': 1, 'source_fingerprint': fingerprint, 'policy_sha256': sha(work / 'policy.json'),
             'bound_before_candidate_collection': True}
    if path.exists(): require(read(path) == value, 'Candidate arms must use the same frozen source')
    else: write(path, value)


def captured_requests(cases, routes, capture):
    by_id = {c['id']: c for c in cases}; requests = []
    for row in routes['cases']:
        case = by_id[row['id']]
        if row.get('status') != 'model_request' and row.get('lane') != 'handwritten_provider_fixture': continue
        messages = row['messages']
        require(capture.digest(messages) == row['request_sha256'], 'Capture request hash differs')
        request = {'id': row['id'], 'messages': messages, 'captured_request_sha256': row['request_sha256'],
            'purpose': case.get('purpose') or 'Frozen evidence-led study question', 'partition': case['partition'],
            'route_lane': row['lane'], 'family': case.get('family'), 'rubric': case.get('rubric', case.get('expected', {})),
            'required_markers': case.get('required_markers', []), 'forbidden_markers': case.get('forbidden_markers', []),
            'timing_probe': case.get('timing_probe', False)}
        for key in ('expected_mentions', 'unexpected_mentions', 'source_lines', 'supplied_ranges'):
            if key in case: request[key] = copy.deepcopy(case[key])
        if row.get('routes'):
            document = row['routes'][-1].get('response', {}).get('document_context') or {}
            for entry in document.get('documents', []):
                request.setdefault('source_lines', {})[entry['name']] = entry['line_count']
                if entry.get('coverage'): request.setdefault('supplied_ranges', {})[entry['name']] = entry['coverage']['ranges']
        requests.append(request)
    return requests


def validate_generation(routes, generation):
    require(generation == GENERATION, 'Frozen generation settings differ')
    for row in routes['cases']:
        if row.get('status') != 'model_request': continue
        for route in row['routes']:
            payload = route.get('payload')
            require(isinstance(payload, dict) and payload.get('max_tokens') == generation['max_output_tokens']
                    and payload.get('temperature') == generation['temperature'],
                    'Actual route generation settings differ from the model collection contract')


def capture_arm(args):
    work = args.workspace.resolve(strict=True); source = args.source_root.resolve(strict=True); out = args.output.resolve()
    require(out.is_relative_to(work) and out != work and not out.exists(), 'Use a new output directory under this study')
    policy, cases = policy_and_cases(work, args.expected_policy_sha256, args.arm)
    snapshot = load('evidence_snapshot', source / 'scripts/release_snapshot.py')
    verified_source = snapshot.verify_snapshot(source, args.snapshot_manifest)
    require(verified_source['fingerprint'] == args.expected_source_fingerprint, 'Unexpected frozen source')
    bind_source(work, args.arm, verified_source['fingerprint'], policy)
    tooling = [bind(HERE / name) for name in TOOLS]
    capture = load('evidence_route_capture', HERE / 'capture_chat_routes.py')
    previous = load('evidence_capture_contract', HERE / 'evaluate_answer_reliability.py')
    routes = capture.capture(source, cases, args.python, preset_id=ARMS[args.arm])
    require(all(sha(b['path']) == b['sha256'] for b in tooling), 'Capture tooling changed during execution')
    require(snapshot.verify_snapshot(source, args.snapshot_manifest)['fingerprint'] == verified_source['fingerprint'], 'Source changed during capture')
    requests = captured_requests(cases, routes, capture)
    out.mkdir(parents=True); archive = out / 'archived-tooling'; archive.mkdir()
    for binding in tooling:
        destination = archive / Path(binding['path']).name
        shutil.copyfile(binding['path'], destination)
        require(sha(destination) == binding['sha256'], 'Archived capture tooling differs')
    for name, value in [('routes.json', routes), ('fixtures.json', {'version': 1, 'cases': cases}),
                        ('captured-requests.json', {'version': 1, 'cases': requests})]: write(out / name, value)
    manifest = {'schema_version': 1, 'arm': args.arm, 'preset_id': ARMS[args.arm],
        'phase': 'baseline' if args.arm == 'baseline_standard' else 'final',
        'created_at': datetime.now(timezone.utc).isoformat(), 'source': str(source),
        'source_fingerprint': verified_source['fingerprint'], 'source_manifest': bind(args.snapshot_manifest),
        'policy': bind(work / 'policy.json'), 'holdout': policy['corpora']['heldout.json'], 'tooling': tooling,
        'files': {name: bind(out / name) for name in ('routes.json', 'fixtures.json', 'captured-requests.json')},
        'summary': previous.summary(routes), 'generation': policy['generation'], 'inference_called': False,
        'live_tli_contacted': False, 'selection_changed': False, 'physical_acceptance': 'not_run',
        'limitations': ['Actual authenticated JSON/SSE routes use synthetic owners and facts; this is not live service acceptance.',
            'Selected preset capabilities are explicitly captured per arm. Different routing and deterministic answers are not treated as raw model improvement.',
            'All prior55 cases run in the separately labeled final-regression arm; heldout questions must not guide production tuning.']}
    try:
        previous.validate_capture(routes, cases, requests)
        validate_generation(routes, policy['generation'])
        manifest['inference_preflight'] = {'ok': True}
    except ValueError as error:
        manifest['inference_preflight'] = {'ok': False, 'reason': str(error)}
    write(out / 'capture-manifest.json', manifest)
    return {'capture': bind(out / 'capture-manifest.json'), 'preflight': manifest['inference_preflight'], **manifest['summary']}


def collect_arm(args):
    work = args.workspace.resolve(strict=True); folder = args.capture.resolve(strict=True)
    require(folder.is_relative_to(work), 'Capture must belong to this study')
    manifest = read(folder / 'capture-manifest.json')
    require(manifest['arm'] == args.arm and manifest['preset_id'] == ARMS[args.arm], 'Captured arm differs')
    policy, cases = policy_and_cases(work, args.expected_policy_sha256, args.arm)
    require(manifest['policy']['sha256'] == args.expected_policy_sha256 and manifest['source_fingerprint'] == args.expected_source_fingerprint, 'Captured policy/source differs')
    bind_source(work, args.arm, args.expected_source_fingerprint, policy)
    for binding in manifest['tooling'] + list(manifest['files'].values()) + [manifest['policy'], manifest['holdout'], manifest['source_manifest']]:
        require(sha(binding['path']) == binding['sha256'], 'Captured artifact/tool changed')
    require(read(folder / 'fixtures.json')['cases'] == cases, 'Captured corpus differs from frozen policy')
    previous = load('evidence_capture_contract', HERE / 'evaluate_answer_reliability.py')
    previous.validate_capture(read(folder / 'routes.json'), cases, read(folder / 'captured-requests.json')['cases'])
    validate_generation(read(folder / 'routes.json'), policy['generation'])
    require(manifest['inference_preflight']['ok'] is True, 'Capture preflight failed; no runtime permitted')
    model = policy['models'][ARMS[args.arm]]
    require(args.model_file.name == model['filename'] and args.model_file.stat().st_size == model['bytes']
            and sha(args.model_file) == model['sha256'], 'Model artifact differs from frozen publisher bytes')
    require(sha(args.runtime) == policy['runtime_sha256'], 'Runtime artifact differs')
    source = Path(manifest['source']); snapshot = load('evidence_snapshot', source / 'scripts/release_snapshot.py')
    require(snapshot.verify_snapshot(source, Path(manifest['source_manifest']['path']))['fingerprint'] == manifest['source_fingerprint'], 'Source changed before collection')
    runner = load('evidence_owned_runner', HERE / 'evaluate_isolated_model.py')
    output = folder / 'runtime'; require(not output.exists(), 'Preserve earlier collection, use a new capture folder')
    result = runner.run(SimpleNamespace(source_root=source, model_file=args.model_file, runtime=args.runtime, output=output,
        context=4096, threads=4, max_tokens=512, timeout=90, case=[], preset_id=ARMS[args.arm], extra_corpus=[],
        prepared_corpus=folder / 'captured-requests.json', measure_stream=True, runtime_lock=args.runtime_lock,
        repeat_case=[], repeats=3))
    require(snapshot.verify_snapshot(source, Path(manifest['source_manifest']['path']))['fingerprint'] == manifest['source_fingerprint'], 'Source changed during collection')
    require(all(sha(b['path']) == b['sha256'] for b in manifest['tooling']), 'Tooling changed during collection')
    record = {'schema_version': 1, 'arm': args.arm, 'preset_id': ARMS[args.arm], 'phase': manifest['phase'],
        'capture': bind(folder / 'capture-manifest.json'), 'source_fingerprint': manifest['source_fingerprint'],
        'policy': manifest['policy'], 'holdout': manifest['holdout'], 'status': result['status'],
        'child_stopped': result['child_stopped'], 'selection_changed': False, 'live_tli_contacted': False,
        'files': {p.name: bind(p) for p in output.iterdir() if p.is_file()}, 'physical_acceptance': 'not_run',
        'quality_review': 'not_run', 'recorded_at': datetime.now(timezone.utc).isoformat()}
    write(folder / 'collection-manifest.json', record)
    return {'collection': bind(folder / 'collection-manifest.json'), 'status': result['status'], 'child_stopped': result['child_stopped']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, required=True); parser.add_argument('--arm', choices=ARMS, required=True)
    parser.add_argument('--expected-source-fingerprint', required=True); parser.add_argument('--expected-policy-sha256', required=True)
    parser.add_argument('--source-root', type=Path); parser.add_argument('--snapshot-manifest', type=Path)
    parser.add_argument('--output', type=Path); parser.add_argument('--python', type=Path, default=Path(sys.executable))
    parser.add_argument('--collect', action='store_true'); parser.add_argument('--capture', type=Path)
    parser.add_argument('--model-file', type=Path); parser.add_argument('--runtime', type=Path)
    parser.add_argument('--runtime-lock', type=Path, required=True)
    args = parser.parse_args(argv); value = collect_arm(args) if args.collect else capture_arm(args)
    print(json.dumps(value))
    completed = (value['status'] == 'responses_collected' and value['child_stopped'] is True) if args.collect else value['preflight']['ok'] is True
    return 0 if completed else 1


if __name__ == '__main__': sys.exit(main())
