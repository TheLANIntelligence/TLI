"""Capture actual Chat inputs, then optionally evaluate in an owned CPU runtime.

This small development smoke check cannot declare a validated model winner.
All evidence is synthetic; models, runtime and source are explicit inputs.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import sys

import capture_chat_routes as capture
import evaluate_isolated_model as runner
import release_snapshot


def sha(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as handle:
        while block := handle.read(1024 * 1024):
            value.update(block)
    return value.hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source-root', type=Path, required=True)
    p.add_argument('--snapshot-manifest', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--collect', action='store_true')
    p.add_argument('--model-file', type=Path)
    p.add_argument('--runtime', type=Path)
    p.add_argument('--runtime-lock', type=Path)
    args = p.parse_args()
    source = args.source_root.resolve(strict=True)
    snapshot = release_snapshot.verify_snapshot(source, args.snapshot_manifest)
    fixture = source / 'scripts/fixtures/tli_dependable_computers_quality.json'
    corpus = json.loads(fixture.read_text(encoding='utf-8'))
    if corpus.get('frozen_before_answers') is not True or len(corpus.get('cases', [])) != 8:
        raise ValueError('Expected the frozen eight-question development corpus')
    out = args.output.resolve(); out.mkdir(parents=True, exist_ok=False)
    manifest = {'schema_version': 1, 'started_at': datetime.now(timezone.utc).isoformat(),
        'source_fingerprint': snapshot['fingerprint'], 'source': str(source),
        'corpus_sha256': sha(fixture), 'kind': 'development_smoke', 'status': 'capturing',
        'live_tli_contacted': False, 'selection_changed': False, 'model_quality_assessment': 'not_run',
        'physical_acceptance': 'not_run', 'limitations': [
            'Eight development questions, not an unseen holdout or model comparison.',
            'Actual synthetic JSON/SSE routes capture supplied input; model answers are collected in an isolated runtime.',
            'No production model recommendation or default changes. Previous model-quality failures remain open.']}
    def save():
        (out/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')
    save()
    try:
        routes = capture.capture(source, corpus['cases'], sys.executable, 'standard')
        if any(row['route_consistent'] is not True or row['status'] not in ('model_request', 'deterministic_response') for row in routes['cases']):
            raise ValueError('Actual JSON/SSE routing did not pass the capture gate')
        by_id = {row['id']: row for row in corpus['cases']}
        requests = [{'id': row['id'], 'purpose': by_id[row['id']]['purpose'], 'rubric': by_id[row['id']]['rubric'],
            'messages': row['messages'], 'captured_request_sha256': row['request_sha256'],
            'route_lane': row['lane']} for row in routes['cases'] if row['status'] == 'model_request']
        for name, value in [('routes.json', routes), ('captured-requests.json', {'version': 1, 'cases': requests})]:
            (out/name).write_text(json.dumps(value, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')
        manifest.update(status='captured', model_requests=len(requests), deterministic_responses=len(routes['cases'])-len(requests),
            captured_requests_sha256=sha(out/'captured-requests.json'), routes_sha256=sha(out/'routes.json'))
        save()
        if args.collect:
            if not all((args.model_file, args.runtime, args.runtime_lock)):
                raise ValueError('Collection requires explicit model, runtime and evaluation lock')
            # Exact retained Standard artifact and previously evaluated runtime.
            if sha(args.model_file) != '9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94':
                raise ValueError('Weights differ from the retained Standard evaluation artifact')
            if sha(args.runtime) != '3b0ada0e76b1cc5668c7e2bbac7784a6e978de9535aa2ad1f749893f79456e58':
                raise ValueError('Runtime differs from the retained evaluation artifact')
            result = runner.run(SimpleNamespace(source_root=source, model_file=args.model_file, runtime=args.runtime,
                output=out/'runtime', context=4096, threads=4, max_tokens=512, timeout=90, case=[], preset_id='standard',
                extra_corpus=[], prepared_corpus=out/'captured-requests.json', measure_stream=True,
                runtime_lock=args.runtime_lock, repeat_case=[], repeats=3))
            manifest.update(status=result['status'], child_stopped=result['child_stopped'])
        manifest['source_unchanged'] = release_snapshot.verify_snapshot(source, args.snapshot_manifest)['fingerprint'] == snapshot['fingerprint']
    except Exception as error:
        manifest.update(status='failed', error=str(error))
    finally:
        save()
    print(json.dumps(manifest))
    return 0 if manifest['status'] in ('captured', 'responses_collected') else 1


if __name__ == '__main__':
    raise SystemExit(main())
