"""Frozen-source, sequential comparison of TLI's six existing text presets.

Offline preparation by default. --collect explicitly launches only owned CPU
runtimes, with verified evaluation weights and a required source fingerprint.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
from pathlib import Path
from types import SimpleNamespace


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while chunk := stream.read(4 * 1024**2):
            value.update(chunk)
    return value.hexdigest()


def frozen_inputs(source, snapshot_manifest, expected, workspace):
    snapshot = module('comparison_snapshot', source / 'scripts/release_snapshot.py')
    verified = snapshot.verify_snapshot(source, snapshot_manifest)
    if verified['fingerprint'] != expected:
        raise ValueError('Source fingerprint differs from the explicitly selected candidate')
    pins = module('comparison_pins', source / 'scripts/prepare_comparison_models.py')
    evaluator = module('comparison_questions', source / 'scripts/evaluate_ai_answers.py')
    heldout, policy_file = workspace / 'sealed/heldout.json', workspace / 'sealed/policy.json'
    development = source / 'scripts/fixtures/tli_answer_development.json'
    policy = json.loads(policy_file.read_text(encoding='utf-8'))
    if not policy.get('frozen_before_answers') or digest(heldout) != policy['heldout_sha256'] or digest(development) != policy['development_sha256']:
        raise ValueError('Frozen corpus or scoring policy no longer matches its recorded identity')
    for name, value in policy['original_corpus_sha256'].items():
        if digest(source / 'scripts/fixtures' / name) != value:
            raise ValueError('The original comparison corpus changed')
    sealed = json.loads(heldout.read_text(encoding='utf-8'))['cases']
    if len(sealed) != 24 or len({case['family'] for case in sealed}) != 12:
        raise ValueError('Held-out family coverage is incomplete')
    cases, corpus = evaluator.load_cases(additional=[development, heldout])
    if len(cases) != 55:
        raise ValueError('The comparison requires all 23 original, 8 development and 24 held-out questions')
    return pins, evaluator, cases, {
        'snapshot': verified, 'corpus_sha256': corpus, 'policy_sha256': digest(policy_file),
        'heldout_sha256': digest(heldout), 'development_sha256': digest(development),
        'generation': policy['generation'], 'timing_repeats': policy['repeats'],
        'policy': policy, 'source': str(source),
    }


def same_inputs(initial, current):
    fields = ('corpus_sha256', 'policy_sha256', 'heldout_sha256', 'development_sha256')
    if any(initial[key] != current[key] for key in fields):
        raise ValueError('Frozen evaluation inputs changed during the comparison; this candidate is invalid')


def percentile(values, fraction=.95):
    values = sorted(value for value in values if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value))
    return values[max(0, math.ceil(len(values) * fraction) - 1)] if values else None


def measured_summary(directory):
    """No quality inference from timing, response count, or mechanical flags."""
    path = directory / 'answers.json'
    if not path.is_file():
        return {'responses': 0, 'quality_review': 'not_run'}
    answers = json.loads(path.read_text(encoding='utf-8'))
    cases = answers['cases']
    received = [case for case in cases if case['status'] == 'response_received']
    repeat_path = directory / 'timing-repeats.json'
    repeats = json.loads(repeat_path.read_text(encoding='utf-8')) if repeat_path.is_file() else []
    return {'responses': len(received), 'requested_cases': len(cases),
            'not_run': sum(c['status'] in ('not_run', 'prepared', 'preparation_failed') for c in cases),
            'timeouts': sum(c.get('error_type') == 'TimeoutError' and c['status'] == 'failed' for c in cases),
            'first_token_p95_ms': percentile([c.get('timing', {}).get('first_token_ms') for c in received]),
            'completion_p95_ms': percentile([c.get('timing', {}).get('completion_ms') for c in received]),
            'timing_repeat_count': len(repeats),
            'repeat_first_token_p95_ms': percentile([x['case'].get('timing', {}).get('first_token_ms') for x in repeats]),
            'repeat_completion_p95_ms': percentile([x['case'].get('timing', {}).get('completion_ms') for x in repeats]),
            'quality_review': 'not_run', 'physical_acceptance': 'not_run'}


def run(args):
    source, workspace = args.source_root.resolve(), args.workspace.resolve()
    if source == workspace or source.is_relative_to(workspace / 'model-weights'):
        raise ValueError('Source and evaluation artifact locations must be separate')
    pins, evaluator, cases, plan = frozen_inputs(source, args.snapshot_manifest, args.expected_source_fingerprint, workspace)
    if plan['policy_sha256'] != args.expected_policy_sha256:
        raise ValueError('Scoring policy differs from the explicitly frozen policy fingerprint')
    if not args.collect:
        prepared = evaluator.make_report(cases, plan['corpus_sha256'], max_tokens=512, timeout=90, context_tokens=4096, stream=True)
        plan.update(mode='offline_preparation', preparation=prepared, inference_started=False)
        if args.output:
            args.output.mkdir(parents=True, exist_ok=False)
            (args.output / 'preparation.json').write_text(json.dumps(plan, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        return plan
    if args.output is None:
        raise ValueError('Collection requires a new output directory')
    # Only the ignored evaluation workspace may receive generated artifacts.
    output = args.output.resolve()
    if not output.is_relative_to(workspace) or output == workspace:
        raise ValueError('Comparison output must be a new child of its evaluation workspace')
    runner = module('comparison_runner', source / 'scripts/evaluate_isolated_model.py')
    runtime = args.runtime.resolve()
    generation = {'cpu_threads': 4, 'context_tokens': 4096, 'max_output_tokens': 512,
                  'temperature': 0, 'stream': True, 'startup_limit_seconds': 120,
                  'request_limit_seconds': 90, 'parallel': 1}
    if plan['generation'] != generation:
        raise ValueError('Frozen generation policy differs from the implemented common conditions')
    with runner.evaluation_lease(workspace / '.comparison.lock'):
        output.mkdir(parents=True, exist_ok=False)
        manifest = {**plan, 'schema_version': 1, 'mode': 'explicit_isolated_comparison',
                    'created_at': datetime.now(timezone.utc).isoformat(), 'models': [],
                    'live_tli_contacted': False, 'selection_changed': False,
                    'quality_verdict': 'Not assessed; no default change follows from this collection.',
                    'order': [pin[0] for pin in pins.PINS],
                    'timing_scope': 'Sequential CPU runs; aggregate host load is observed, not experimentally controlled. Three repeated development probes per model.'}
        def save():
            (output / 'comparison.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        save()
        for pin in pins.PINS:
            ident, _, _, filename, size, sha, _ = pin
            model = workspace / 'model-weights' / filename
            if not pins.valid(model, size, sha):
                manifest['models'].append({'preset_id': ident, 'status': 'artifact_invalid', 'runtime_started': False})
                save(); continue
            # Recheck the complete snapshot before each runtime; a previous run
            # cannot make changed prompts eligible for later candidates.
            same_inputs(plan, frozen_inputs(source, args.snapshot_manifest, args.expected_source_fingerprint, workspace)[3])
            result = runner.run(SimpleNamespace(source_root=source, model_file=model, runtime=runtime,
                output=output / ident, context=4096, threads=4, max_tokens=512, timeout=90, case=[],
                preset_id=ident, extra_corpus=[source / 'scripts/fixtures/tli_answer_development.json', workspace / 'sealed/heldout.json'],
                measure_stream=True, runtime_lock=workspace / '.runtime.lock',
                repeat_case=plan['timing_repeats']['case_ids'], repeats=3))
            entry = {'preset_id': ident, 'status': result['status'], 'child_stopped': result['child_stopped'],
                     'startup_ms': result.get('startup_ms'), 'telemetry': result.get('telemetry'),
                     'runtime_restarts': result.get('runtime_restarts'),
                     'runtime_instances': result.get('runtime_instances'),
                     'timing_repeat_failures': result.get('timing_repeat_failures'),
                     'files': {p.name: digest(p) for p in sorted((output / ident).iterdir()) if p.is_file()},
                     'measurements': measured_summary(output / ident)}
            manifest['models'].append(entry); save()
            same_inputs(plan, frozen_inputs(source, args.snapshot_manifest, args.expected_source_fingerprint, workspace)[3])
            if result.get('child_pid') and not result['child_stopped']:
                raise RuntimeError('Owned runtime termination is unconfirmed; later candidates cannot start')
        same_inputs(plan, frozen_inputs(source, args.snapshot_manifest, args.expected_source_fingerprint, workspace)[3])
        manifest['source_unchanged'] = True
        manifest['completed_at'] = datetime.now(timezone.utc).isoformat(); save()
        return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--snapshot-manifest', type=Path, required=True)
    parser.add_argument('--expected-source-fingerprint', required=True)
    parser.add_argument('--expected-policy-sha256', required=True)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--runtime', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--collect', action='store_true')
    args = parser.parse_args()
    if args.collect and not args.runtime:
        parser.error('--collect requires an explicit runtime path')
    result = run(args)
    print(json.dumps({key: value for key, value in result.items() if key not in {'preparation', 'policy'}}, indent=2))
    if result['mode'] == 'offline_preparation':
        return int(any(c['status'] == 'preparation_failed' for c in result['preparation']['cases']))
    return int(any(item['status'] != 'responses_collected' for item in result['models']))


if __name__ == '__main__':
    raise SystemExit(main())
