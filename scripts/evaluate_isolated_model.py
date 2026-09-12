"""Evaluate installed weights in a harness-owned CPU runtime, never live TLI.

All paths are explicit. The report directory must be new. No download, model
selection, application import, inherited llama configuration or process lookup
is used to launch/stop inference. Only the child process created here is stopped.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request
import uuid
_helper_spec = importlib.util.spec_from_file_location('isolated_evaluation_runtime', Path(__file__).with_name('evaluation_runtime.py'))
_helper = importlib.util.module_from_spec(_helper_spec)
_helper_spec.loader.exec_module(_helper)
evaluation_lease, launch_options, ProcessMetrics, source_module = (
    _helper.evaluation_lease, _helper.launch_options, _helper.ProcessMetrics, _helper.source_module)


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def child_environment():
    allowed = ('SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'COMSPEC', 'LANG')
    return {key: os.environ[key] for key in allowed if key in os.environ}


def prepared_cases(path):
    """Explicit captured-provider corpus; never mix it with default questions."""
    raw = path.read_bytes()
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError('Captured request corpus exceeds its bound')
    value = json.loads(raw)
    cases = value.get('cases') if isinstance(value, dict) else None
    if not isinstance(value, dict) or value.get('version') != 1 or not isinstance(cases, list) or not 1 <= len(cases) <= 64:
        raise ValueError('Unsupported captured request corpus')
    seen = set()
    import re
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError('Invalid captured case')
        ident = case.get('id')
        messages = case.get('messages')
        if not isinstance(ident, str) or not re.fullmatch(r'[a-z0-9-]{1,64}', ident) or ident in seen:
            raise ValueError('Invalid or duplicate captured request identity')
        seen.add(ident)
        if not isinstance(case.get('purpose'), str) or not 1 <= len(case['purpose']) <= 4096 or not isinstance(case.get('rubric'), (dict, list, str)):
            raise ValueError('Captured case requires bounded purpose and review rubric')
        if ('preparation' in case or 'document_preparation' in case or 'production_prompt' in case or not isinstance(messages, list)
                or not 1 <= len(messages) <= 64 or len(json.dumps(messages).encode()) > 128 * 1024
                or any(not isinstance(m, dict) or set(m) != {'role', 'content'} or
                       m['role'] not in ('system', 'user', 'assistant') or not isinstance(m['content'], str) for m in messages)):
            raise ValueError('Captured cases must contain bounded text-only messages, not a preparation instruction')
        actual = hashlib.sha256(json.dumps(messages, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        if case.get('captured_request_sha256') != actual:
            raise ValueError('Captured request hash mismatch')
    return cases, hashlib.sha256(raw).hexdigest()


def resources(model_size, context):
    import psutil
    memory = psutil.virtual_memory()
    # Conservative CPU-only allowance: weights, runtime/KV/work buffers and
    # 4 GiB untouched headroom. Missing probes fail, never imply compatibility.
    required = model_size * 2 + 4 * 1024**3 + context * 256 * 1024
    return {'total_ram_bytes': memory.total, 'available_ram_bytes': memory.available,
            'required_available_bytes': required, 'sufficient': memory.available >= required,
            'checked_at': datetime.now(timezone.utc).isoformat()}


def read_json(url, timeout=2):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(url, timeout=timeout) as response:
        return json.loads(response.read(128 * 1024))


def _run(args):
    source = args.source_root.resolve(strict=True)
    model, runtime = args.model_file.resolve(strict=True), args.runtime.resolve(strict=True)
    if not model.is_file() or not runtime.is_file() or model.suffix.lower() != '.gguf':
        raise ValueError('Select an installed GGUF and runtime executable.')
    if not 1024 <= args.context <= 8192 or not 1 <= args.threads <= 8:
        raise ValueError('Use 1024â€“8192 context tokens and 1â€“8 CPU threads.')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = {'schema_version': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
              'status': 'preparing', 'source_root': str(source), 'execution_mode': 'CPU',
              'context_tokens': args.context, 'threads': args.threads, 'startup_limit_seconds': 120,
              'model': {'filename': model.name, 'bytes': model.stat().st_size, 'sha256': digest(model)},
              'runtime': {'filename': runtime.name, 'sha256': digest(runtime)},
              'live_tli_contacted': False, 'selection_changed': False, 'child_stopped': False,
              'physical_user_acceptance': 'not_run'}
    extra_flags, preset = launch_options(source, getattr(args, 'preset_id', None), model, args.context)
    report['preset_id'] = getattr(args, 'preset_id', None)
    report['preset_flags'] = extra_flags
    report['generation'] = {'temperature': 0, 'stream': bool(getattr(args, 'measure_stream', False)),
                            'max_tokens': getattr(args, 'max_tokens', 512)}

    def save():
        (output / 'runtime-manifest.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')

    child = None
    telemetry = None
    evaluation = None
    report['runtime_instances'] = []
    def stop_child(reason='finished'):
        nonlocal child, telemetry
        if child is None:
            return
        instance = report['runtime_instances'][-1]
        if telemetry is not None:
            instance['telemetry'] = telemetry.stop(); telemetry = None
        instance['stop_reason'] = reason
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait(timeout=10)
        instance['child_stopped'] = child.poll() is not None
        report['child_stopped'] = all(row.get('child_stopped') for row in report['runtime_instances'])
        save()
        if not report['child_stopped']:
            raise RuntimeError('Owned child termination is unconfirmed; no later runtime may start')
        child = None
    try:
        report['resources'] = resources(model.stat().st_size, args.context)
        if not report['resources']['sufficient']:
            report.update(status='blocked', reason='Insufficient available RAM for an independent runtime; live TLI was not stopped.')
            return report
        if preset and report['resources']['total_ram_bytes'] < preset['min_ram_gb'] * 1024**3:
            report.update(status='blocked', reason='Preset total-memory estimate is not met.'); return report
        if preset and preset.get('min_runtime_build'):
            support = source_module('comparison_runtime_support', source / 'backend/ai/runtime_support.py').support(preset, runtime)
            report['runtime_support'] = support
            if support['state'] != 'supported':
                report.update(status='blocked', reason=support['reason']); return report
        report['runtime']['library_hashes'] = {p.name: digest(p) for p in sorted(runtime.parent.glob('*.dll'))}
        spec = importlib.util.spec_from_file_location('isolated_answer_evaluation', source / 'scripts/evaluate_ai_answers.py')
        evaluation = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(evaluation)
        captured = getattr(args, 'prepared_corpus', None)
        if captured is not None:
            if getattr(args, 'extra_corpus', []) or args.case:
                raise ValueError('Captured request corpus cannot be mixed or silently filtered')
            cases, corpus_hash = prepared_cases(Path(captured).resolve(strict=True))
            # Exercise the actual frozen report constructor before any runtime
            # launch; messages are already captured and require no preparation.
            preflight = evaluation.make_report(cases, corpus_hash, max_tokens=args.max_tokens,
                timeout=args.timeout, context_tokens=args.context, stream=bool(getattr(args, 'measure_stream', False)))
            if len(preflight['cases']) != len(cases) or any(row.get('request_sha256') != case['captured_request_sha256']
                    for row, case in zip(preflight['cases'], cases)):
                raise ValueError('Frozen evaluator changed captured request messages')
            report['captured_request_corpus'] = {'path': str(Path(captured).resolve()), 'sha256': corpus_hash}
        else:
            cases, corpus_hash = evaluation.load_cases(additional=getattr(args, 'extra_corpus', []))
        report['corpus_sha256'] = corpus_hash
        report['source_before'] = evaluation.source_identity()
        report['additional_corpora'] = [{'path': str(Path(p).resolve()), 'sha256': digest(p)} for p in getattr(args, 'extra_corpus', [])]
        if args.case:
            if set(args.case) - {case['id'] for case in cases}:
                raise ValueError('Unknown evaluation case.')
            cases = [case for case in cases if case['id'] in args.case]
        repeat_ids = getattr(args, 'repeat_case', [])
        repeats = getattr(args, 'repeats', 3)
        if not 1 <= repeats <= 5 or len(repeat_ids) > 3 or len(set(repeat_ids)) != len(repeat_ids):
            raise ValueError('Use at most three distinct timing questions and one to five repeats')
        selected_repeats = [c for c in cases if c['id'] in repeat_ids]
        if len(selected_repeats) != len(repeat_ids) or any(not c.get('timing_probe') or c.get('partition') == 'heldout' for c in selected_repeats):
            raise ValueError('Timing repeats must name declared development probes, never held-out cases')
        alias = 'tli-synthetic-' + uuid.uuid4().hex
        with (output / 'runtime.log').open('w', encoding='utf-8') as log:
            endpoint = None
            def start_child():
                nonlocal child, telemetry, endpoint
                if child is not None:
                    raise RuntimeError('Previous owned child must stop before another can launch')
                resource = resources(model.stat().st_size, args.context)
                if not resource['sufficient']:
                    raise RuntimeError('Available RAM no longer supports a fresh isolated child')
                with socket.socket() as reserved:
                    reserved.bind(('127.0.0.1', 0)); port = reserved.getsockname()[1]
                command = [str(runtime), '-m', str(model), '--host', '127.0.0.1', '--port', str(port),
                    '--ctx-size', str(args.context), '--threads', str(args.threads), '--threads-batch', str(args.threads),
                    '--gpu-layers', '0', '--parallel', '1', '--no-webui', '--alias', alias,
                    '--temp', '0', '--top-p', '0.9', '--repeat-penalty', '1.15'] + extra_flags
                startup_started = time.monotonic()
                child = subprocess.Popen(command, cwd=output, env=child_environment(), stdout=log, stderr=subprocess.STDOUT,
                    **({'creationflags': subprocess.CREATE_NO_WINDOW} if sys.platform == 'win32' else {}))
                endpoint = f'http://127.0.0.1:{port}'
                instance = {'instance': len(report['runtime_instances']) + 1, 'pid': child.pid,
                    'endpoint': endpoint, 'launch_args': command, 'resources': resource,
                    'child_stopped': False, 'started_at': datetime.now(timezone.utc).isoformat()}
                report['runtime_instances'].append(instance)
                report.update(status='starting', child_pid=child.pid, child_stopped=False, port=port,
                    model_alias=alias, launch_args=command)
                telemetry = ProcessMetrics(child.pid); telemetry.start(); save()
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    if child.poll() is not None:
                        raise RuntimeError('Harness runtime exited during startup')
                    try:
                        models = read_json(endpoint + '/v1/models')
                        if alias not in {item.get('id') for item in models.get('data', [])}:
                            raise RuntimeError('Allocated port does not serve the harness model identity')
                        if read_json(endpoint + '/health').get('status') == 'ok':
                            break
                    except (OSError, ValueError):
                        time.sleep(.25)
                else:
                    raise TimeoutError('Harness runtime exceeded the 120-second startup limit')
                instance['startup_ms'] = round((time.monotonic() - startup_started) * 1000, 3)
                report.setdefault('startup_ms', instance['startup_ms'])
                report['status'] = 'evaluating'; save()
            start_child()
            measured_stream = bool(getattr(args, 'measure_stream', False))
            completed_requests = 0
            restart_failed = False
            def not_sent(reason, cause=None):
                error = RuntimeError(reason)
                error.evaluation_metrics = {'request_sent': False,
                    'runtime_startup_error_type': type(cause).__name__ if cause else None}
                return error
            def transport(_reported_endpoint, payload, timeout):
                nonlocal completed_requests, restart_failed
                if restart_failed:
                    raise not_sent('A replacement runtime could not start or stop safely; this question was not sent')
                restarted = child is None
                if restarted:
                    try:
                        start_child()
                    except Exception as error:
                        restart_failed = True
                        raise not_sent('A replacement runtime could not start; this question was not sent', error) from error
                if child.poll() is not None:
                    stop_child('unexpected_exit'); restart_failed = True
                    raise not_sent('Owned runtime exited before the request')
                telemetry.begin_case()
                instance = report['runtime_instances'][-1]
                common = {'request_sent': True, 'runtime_instance': instance['instance'], 'runtime_restarted_before_request': restarted,
                    'runtime_startup_ms': instance['startup_ms'], 'loopback_endpoint': endpoint}
                try:
                    response = (evaluation.request_answer_stream if measured_stream else evaluation.request_answer)(
                        endpoint + '/v1/chat/completions', payload, timeout)
                    response.setdefault('_evaluation_metrics', {}).update(common, resources=telemetry.end_case())
                    return response
                except Exception as error:
                    metrics = getattr(error, 'evaluation_metrics', {})
                    metrics.update(common, resources=telemetry.end_case()); error.evaluation_metrics = metrics
                    # Never retry this question or enqueue behind unconfirmed
                    # cancelled work. Only the next question may use a new child.
                    try:
                        stop_child('request_timeout' if isinstance(error, TimeoutError) else 'request_transport_failure')
                    except Exception:
                        restart_failed = True
                    raise
                finally:
                    completed_requests += 1
                    print(json.dumps({'preset': report['preset_id'], 'completed_requests': completed_requests}), flush=True)
            answers = evaluation.make_report(cases, corpus_hash, endpoint=endpoint, model=alias,
                                              max_tokens=args.max_tokens, timeout=args.timeout,
                                              transport=transport, stream=measured_stream,
                                              **({'context_tokens': args.context} if 'context_tokens' in inspect.signature(evaluation.make_report).parameters else {}))
            if captured is not None:
                by_id = {case['id']: case for case in cases}
                for row in answers['cases']:
                    original = by_id[row['id']]
                    row['input_source'] = ('captured_chat_route' if original.get('route_lane') == 'actual_bundled_chat_routes'
                                           else 'handwritten_provider_fixture')
                    row['captured_request_sha256'] = original['captured_request_sha256']
                    if row.get('request_sha256') != original['captured_request_sha256']:
                        raise ValueError('Provider input differs from the explicitly captured request')
                answers['preparation_scope'] = 'Previously captured actual Chat-route provider messages or explicitly labeled raw-provider controls; no implicit preparation or request routing occurs inside this inference runner.'
                answers['captured_request_corpus'] = report['captured_request_corpus']
            answers['runtime_identity'] = {'model_sha256': report['model']['sha256'],
                'runtime_sha256': report['runtime']['sha256'], 'execution_mode': 'CPU', 'context_tokens': args.context}
            (output / 'answers.json').write_text(json.dumps(answers, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
            report['status'] = 'responses_collected' if all(c['status'] == 'response_received' for c in answers['cases']) else 'incomplete'
            report['answer_report_sha256'] = digest(output / 'answers.json')
            report['quality_review'] = 'not_run'
            timing = []
            for repetition in range(repeats):
                for case in selected_repeats:
                    one = evaluation.make_report([case], corpus_hash, endpoint=endpoint, model=alias,
                        max_tokens=args.max_tokens, timeout=args.timeout, context_tokens=args.context,
                        transport=transport, stream=measured_stream)
                    timing.append({'repetition': repetition + 1, 'case': one['cases'][0]})
            (output / 'timing-repeats.json').write_text(json.dumps(timing, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
            # A timing-request restart must not leave the completed report in
            # the transient "evaluating" state set during child startup.
            report['status'] = 'responses_collected' if all(c['status'] == 'response_received' for c in answers['cases']) else 'incomplete'
            report['timing_repeat_failures'] = sum(row['case']['status'] != 'response_received' for row in timing)
    except Exception as exc:
        report.update(status='failed', error_type=type(exc).__name__, reason=str(exc))
    finally:
        try:
            stop_child()
        except Exception as stop_error:
            report.update(status='failed', reason='Owned runtime termination could not be confirmed', stop_error_type=type(stop_error).__name__)
        values = [row.get('telemetry', {}) for row in report['runtime_instances']]
        cpu_samples = sum(row.get('host_cpu_samples', 0) for row in values)
        def observed(field, operation):
            samples = [row[field] for row in values if row.get(field) is not None]
            return operation(samples) if samples else None
        report['telemetry'] = {'samples': sum(row.get('samples', 0) for row in values),
            'rss_peak_bytes': observed('rss_peak_bytes', max),
            'available_ram_min_bytes': observed('available_ram_min_bytes', min),
            'host_cpu_peak_percent': observed('host_cpu_peak_percent', max),
            'host_cpu_samples': cpu_samples,
            'host_cpu_mean_percent': sum((row.get('host_cpu_mean_percent') or 0) * row.get('host_cpu_samples', 0) for row in values) / cpu_samples if cpu_samples else None,
            'probe_failures': sum(row.get('probe_failures', 0) for row in values),
            'scope': 'Sampled owned-child RSS and aggregate host pressure across all recorded runtime instances.'}
        report['runtime_restarts'] = max(0, len(report['runtime_instances']) - 1)
        if evaluation is not None:
            report['source_after'] = evaluation.source_identity()
            report['source_unchanged'] = report.get('source_before') == report['source_after']
            if not report['source_unchanged']:
                report.update(status='failed', reason='Relevant source changed during evaluation; this candidate is invalid.')
            report['additional_corpora_unchanged'] = report.get('additional_corpora') == [
                {'path': str(Path(p).resolve()), 'sha256': digest(p)} for p in getattr(args, 'extra_corpus', [])]
            if not report['additional_corpora_unchanged']:
                report.update(status='failed', reason='Additional evaluation questions changed during this candidate.')
        if report['runtime_instances']:
            report['artifacts_unchanged'] = (digest(model) == report['model']['sha256']
                and digest(runtime) == report['runtime']['sha256']
                and {p.name: digest(p) for p in sorted(runtime.parent.glob('*.dll'))} == report['runtime']['library_hashes'])
            if not report['artifacts_unchanged']:
                report.update(status='failed', reason='Model or runtime artifacts changed during this comparison candidate.')
        save()
    return report


def run(args):
    # Every candidate in a comparison passes the same workspace lock explicitly.
    # A concurrent command fails before starting another runtime.
    lock = getattr(args, 'runtime_lock', None) or (args.output.resolve().parent / '.tli-evaluation.lock')
    with evaluation_lease(lock):
        return _run(args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--model-file', type=Path, required=True)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--context', type=int, default=4096)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--max-tokens', type=int, default=512)
    parser.add_argument('--timeout', type=float, default=60)
    parser.add_argument('--case', action='append', default=[])
    parser.add_argument('--preset-id')
    parser.add_argument('--extra-corpus', type=Path, action='append', default=[])
    parser.add_argument('--prepared-corpus', type=Path, help='Use only a hash-bound captured-provider corpus; do not load default fixtures')
    parser.add_argument('--measure-stream', action='store_true')
    parser.add_argument('--runtime-lock', type=Path)
    parser.add_argument('--repeat-case', action='append', default=[])
    parser.add_argument('--repeats', type=int, default=3)
    result = run(parser.parse_args())
    print(json.dumps(result, indent=2))
    return 0 if result['status'] == 'responses_collected' else 1


if __name__ == '__main__':
    raise SystemExit(main())
