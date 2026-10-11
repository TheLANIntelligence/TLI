"""Evaluate the frozen next-check checkpoint using actual synthetic Chat routes.

Prospective questions are bound separately from source. Raw answers are never
rewritten or automatically called correct. Model lifecycle belongs exclusively
to the existing isolated evaluation runner.
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

import release_snapshot
import evaluate_isolated_model

MODEL_SHA = '9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94'
RUNTIME_SHA = '3b0ada0e76b1cc5668c7e2bbac7784a6e978de9535aa2ad1f749893f79456e58'


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def frozen_cases(source, policy_path, expected_policy_hash):
    if sha(policy_path) != expected_policy_hash:
        raise ValueError('Confirmation policy changed; preserve the frozen questions.')
    policy = read(policy_path)
    original = source / 'scripts/fixtures/tli_dependable_computers_quality.json'
    prospective = policy_path.parent / 'questions.json'
    if (policy.get('frozen_before_answers') is not True
            or sha(original) != policy['retained_regression_sha256']
            or sha(prospective) != policy['confirmation_sha256']):
        raise ValueError('Question inputs differ from the prospective policy.')
    regression = read(original)['cases']
    confirmation = read(prospective)['cases']
    cases = [{**case, 'partition': 'retained_regression'} for case in regression] + confirmation
    if len(regression) != 8 or len(confirmation) != 12 or len({x['id'] for x in cases}) != 20:
        raise ValueError('Expected eight retained and twelve distinct prospective questions.')
    return cases, policy


def prepared_requests(routes, fixtures):
    by_id = {row['id']: row for row in fixtures}
    rows = routes.get('cases', [])
    if len(rows) != len(by_id) or {row['id'] for row in rows} != set(by_id):
        raise ValueError('Route capture omitted or duplicated a question.')
    requests = []
    for row in rows:
        if row.get('route_consistent') is not True or row.get('status') not in {'model_request', 'deterministic_response'}:
            raise ValueError('Both actual Chat routes must complete consistently before collection.')
        for route in row.get('routes', []):
            if route.get('http_status') != 200 or route.get('forbidden_calls') or route.get('seed_stores_unchanged') is not True:
                raise ValueError('Capture crossed an execution or preservation boundary.')
        if len(row.get('routes', [])) != 2:
            raise ValueError('Both JSON and SSE routes are required.')
        if row['status'] == 'model_request':
            if not row.get('messages') or not row.get('request_sha256'):
                raise ValueError('A provider request must retain its actual supplied messages.')
            requests.append({'id': row['id'], 'purpose': by_id[row['id']]['purpose'],
                'rubric': by_id[row['id']]['rubric'], 'partition': by_id[row['id']]['partition'],
                'messages': row['messages'], 'captured_request_sha256': row['request_sha256'], 'route_lane': row['lane']})
    return requests


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--snapshot-manifest', type=Path, required=True)
    parser.add_argument('--policy', type=Path, required=True)
    parser.add_argument('--policy-sha256', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--collect', action='store_true')
    parser.add_argument('--model-file', type=Path)
    parser.add_argument('--runtime', type=Path)
    parser.add_argument('--runtime-lock', type=Path)
    args = parser.parse_args()
    source = args.source_root.resolve(strict=True)
    snapshot = release_snapshot.verify_snapshot(source, args.snapshot_manifest)
    fixtures, policy = frozen_cases(source, args.policy.resolve(strict=True), args.policy_sha256)
    out = args.output.resolve(); out.mkdir(parents=True, exist_ok=False)
    manifest = {'schema_version': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
        'source_fingerprint': snapshot['fingerprint'], 'source_files': snapshot['file_count'],
        'policy_sha256': args.policy_sha256, 'confirmation_sha256': policy['confirmation_sha256'],
        'kind': 'actual_chat_routes_retained_and_prospective', 'status': 'capturing',
        'live_tli_contacted': False, 'selection_changed': False, 'model_recommendation_changed': False,
        'model_quality_assessment': 'not_run', 'physical_acceptance': 'not_run'}
    def save():
        (out/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')
    save()
    try:
        spec = importlib.util.spec_from_file_location('frozen_finish_fix_capture', source/'scripts/capture_chat_routes.py')
        capture = importlib.util.module_from_spec(spec); spec.loader.exec_module(capture)
        routes = capture.capture(source, fixtures, sys.executable, 'standard')
        requests = prepared_requests(routes, fixtures)
        for name, value in [('routes.json', routes), ('captured-requests.json', {'version': 1, 'cases': requests})]:
            (out/name).write_text(json.dumps(value, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')
        manifest.update(status='captured', total_questions=len(fixtures), provider_requests=len(requests),
            deterministic_responses=len(fixtures)-len(requests), routes_sha256=sha(out/'routes.json'),
            captured_requests_sha256=sha(out/'captured-requests.json'))
        save()
        if args.collect and requests:
            if not all((args.model_file, args.runtime, args.runtime_lock)):
                raise ValueError('Supply the existing model, runtime and isolated evaluation lock.')
            if sha(args.model_file) != MODEL_SHA or sha(args.runtime) != RUNTIME_SHA:
                raise ValueError('The evaluated Standard model/runtime artifacts changed.')
            result = evaluate_isolated_model.run(SimpleNamespace(source_root=source, model_file=args.model_file,
                runtime=args.runtime, output=out/'runtime', context=4096, threads=4, max_tokens=512, timeout=90,
                case=[], preset_id='standard', extra_corpus=[], prepared_corpus=out/'captured-requests.json',
                measure_stream=True, runtime_lock=args.runtime_lock, repeat_case=[], repeats=3))
            manifest.update(status=result['status'], child_stopped=result['child_stopped'])
        elif args.collect:
            manifest.update(status='deterministic_only', child_started=False, child_stopped=True)
        manifest['source_unchanged'] = release_snapshot.verify_snapshot(source, args.snapshot_manifest)['fingerprint'] == snapshot['fingerprint']
    except Exception as error:
        manifest.update(status='failed', error=str(error))
    finally:
        save()
    print(json.dumps(manifest))
    return 0 if manifest['status'] in {'captured', 'responses_collected', 'deterministic_only'} else 1


if __name__ == '__main__':
    raise SystemExit(main())
