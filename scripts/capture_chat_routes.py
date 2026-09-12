"""Capture real bundled POST routes in fresh synthetic, effect-bounded processes.

This does not start TLI or inference. ASGI requests use the actual JSON/SSE
handlers with a synthetic authenticated owner. Only external services, runtime
transport and thread scheduling are replaced; routing and prompt builders run.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

MAX_FIXTURE_BYTES = 512 * 1024
MAX_OUTPUT_BYTES = 4 * 1024 * 1024
PATHS = ('/api/ai/chat', '/api/ai/chat/stream')
PLACEHOLDER = 'Synthetic transport capture; this is not a model answer.'
FIXED_TIME = '2026-09-08T12:00:00Z'


def sha(value):
    return hashlib.sha256(value).hexdigest()


def digest(value):
    return sha(json.dumps(value, sort_keys=True, ensure_ascii=False).encode())


def require(value, message):
    if not value:
        raise ValueError(message)


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


def route_fixture(case):
    """Keep old fixtures intact; adapt their saved inputs to actual HTTP fields."""
    if 'route_fixture' in case:
        return copy.deepcopy(case['route_fixture'])
    if 'document_preparation' in case:
        old = case['document_preparation']
        lines = ['Retained setup journal entry, no measurement recorded.'] * old['line_count']
        for number, text in old['lines'].items():
            lines[int(number) - 1] = text
        return {'request': {'message': old['question'], 'documents': [{'name': old['name'], 'text': '\n'.join(lines)}]}}
    if 'preparation' not in case:
        return None
    old = copy.deepcopy(case['preparation'])
    request = {'message': old.pop('question')}
    for key in ('target_id', 'diagnostic_id', 'use_saved_memory', 'use_conversation_history'):
        if key in old:
            request[key] = old[key]
    if old.get('client_device_id'):
        request['device_id'] = old['client_device_id']
    return {**old, 'request': request}


def effect_guard(event, values, root, source):
    if event.startswith('socket.') or event in {'subprocess.Popen', 'os.system', 'os.fork', 'os.posix_spawn'}:
        raise RuntimeError('External effects forbidden during route capture')
    if event == 'open' and len(values) >= 3:
        path, mode, flags = values
        if isinstance(path, int):
            return
        resolved = Path(path).resolve()
        require(resolved.suffix.lower() != '.gguf' and 'private-root' not in resolved.parts and
                resolved.name not in {'answers.json', 'private-blind-key.json'}, 'Model answers, weights and private attribution are forbidden')
        writing = isinstance(mode, str) and any(c in mode for c in 'wax+') or isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC)
        if writing:
            require(resolved.is_relative_to(root), 'Writes must stay inside synthetic persistence')
        if 'data' in resolved.parts and not resolved.is_relative_to(root) and not resolved.is_relative_to(Path(sys.prefix)):
            require(resolved.is_relative_to(source) and resolved.suffix == '.py', 'Live data is forbidden')
    if event in {'os.mkdir', 'os.remove', 'os.rmdir', 'os.rename'}:
        for path in values[:2] if event == 'os.rename' else values[:1]:
            require(Path(path).resolve().is_relative_to(root), 'Filesystem mutation escaped synthetic persistence')


async def capture_child(source, cases, preset_id='standard'):
    """Run on an already-created event loop; no sockets/workers after the guard."""
    from unittest.mock import patch
    from types import SimpleNamespace
    import threading
    root = Path(os.environ['TLI_ROOT']).resolve(strict=True)
    sys.addaudithook(lambda event, values: effect_guard(event, values, root, source))
    suppressed_startup = []
    def no_thread(thread, *args, **kwargs):
        target = getattr(thread, '_target', None)
        if (thread.name == 'tli-startup-check' and getattr(target, '__qualname__', '') == '_launch_startup_self_check.<locals>._run'
                and Path(target.__code__.co_filename).resolve() == source / 'backend/ai/ai_routes.py'):
            suppressed_startup.append('tli-startup-check')
            return None
        raise RuntimeError('Workers forbidden during route capture')
    threading.Thread.start = no_thread
    sys.path.insert(0, str(source / 'backend'))
    import tli_state as state
    from ai import ai_manager
    preset = ai_manager.MODEL_PRESETS.get(preset_id)
    require(isinstance(preset, dict) and not preset.get('is_vision') and
            preset.get('ctx_size') == 4096, 'Choose a catalogued text preset with the recorded 4096 context')
    # ai_routes creates its legacy device-memory directory at import. Redirect
    # that storage root while preserving the exact production prompt bytes.
    ai_root = root / 'ai'
    (ai_root / 'prompts').mkdir(parents=True)
    (ai_root / 'prompts/system_default.txt').write_bytes((source / 'backend/ai/prompts/system_default.txt').read_bytes())
    ai_manager._ai_base_dir = lambda: ai_root
    from ai import ai_routes as ai
    from intelligence import context, memory, store, cases as journals, devices, models, diagnostics, observed_answers
    from fastapi import FastAPI, HTTPException
    import anyio.to_thread
    import httpx

    async def inline(function, *args, **kwargs):
        return function(*args)
    # Preserve real ASGI dependency/validation/response paths; only replace the
    # thread scheduler, since all synthetic work is short and sequential.
    anyio.to_thread.run_sync = inline
    app = FastAPI()
    app.include_router(ai.router)
    current = {'owner': 'synthetic-owner'}
    app.dependency_overrides[ai.require_session] = lambda: current['owner']
    context.request_user = lambda request: current['owner']
    calls, forbidden_calls = [], []
    def forbidden(name):
        def stopped(*args, **kwargs):
            forbidden_calls.append(name)
            raise RuntimeError('Synthetic forbidden operation: ' + name)
        return stopped
    manager = SimpleNamespace(active_preset_id=preset_id, base_url='http://127.0.0.1:49151',
        ensure_running=lambda: True, is_healthy=lambda: True, _transition=False,
        generation=contextlib.nullcontext, text_capacity=lambda: {'status': 'configured', 'context_tokens': 4096,
            'source': 'owned_runtime_launch', 'model': preset_id})
    ai_manager.BundledAIManager.get = lambda: manager
    ai.execute_action = forbidden('action_execution')
    diagnostics.run = forbidden('diagnostic_execution')
    ai.run_full_diagnostic = forbidden('full_diagnostic_execution')
    ai.run_startup_check = forbidden('startup_diagnostic_execution')
    ai.image_reply = forbidden('image_provider')
    ai._find_mesh_ai_peer = forbidden('mesh_discovery')
    ai._proxy_chat_to_mesh_peer = forbidden('mesh_proxy')
    ai._should_prefer_mesh = lambda: False
    state.load_pin_config = lambda: {'enabled': False}
    state.now_iso = lambda: FIXED_TIME
    state.log_debug = lambda *args, **kwargs: None
    def post(base, payload, **kwargs):
        require(base == manager.base_url, 'Unexpected provider location')
        calls.append(copy.deepcopy(payload))
        return {'model': 'synthetic-capture', 'choices': [{'message': {'content': PLACEHOLDER}, 'finish_reason': 'stop'}]}
    def stream(url, payload, **kwargs):
        require(url == manager.base_url + '/v1/chat/completions', 'Unexpected streaming provider location')
        calls.append(copy.deepcopy(payload))
        yield json.dumps({'choices': [{'delta': {'content': PLACEHOLDER}}]})
    ai._llama_post = post
    ai._llama_stream_raw = stream
    results = []
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url='http://127.0.0.1') as client:
        for case in cases:
            fixture = route_fixture(case)
            if fixture is None:
                messages = case['messages']
                if case.get('production_prompt'):
                    production = (source / 'backend/ai/prompts/system_default.txt').read_text(encoding='utf-8')
                    messages = [{'role': 'system', 'content': production + '\n\nSUPPLIED REQUEST EVIDENCE\n' + messages[0]['content']}, *messages[1:]]
                results.append({'id': case['id'], 'lane': 'handwritten_provider_fixture', 'messages': messages,
                    'request_sha256': digest(messages), 'routes': [], 'route_consistent': None})
                continue
            route_results = []
            for index, path in enumerate(PATHS):
                owner = 'eval-' + case['id'] + '-' + str(index)
                current['owner'] = owner
                calls.clear(); forbidden_calls.clear()
                host = fixture.get('host', {'id': 'fixture-host', 'name': 'Synthetic Study', 'role': 'standalone'})
                node = SimpleNamespace(node_id=host['id'], node_name=host['name'], role=host.get('role', 'standalone'), host_address=None)
                state.load_node_config = lambda: node
                rows = fixture.get('devices', [])
                by_id = {row['id']: row for row in rows}
                def get_device(ident):
                    if ident not in by_id:
                        raise HTTPException(404, 'Synthetic device is not registered')
                    return copy.deepcopy(by_id[ident])
                context.devices.node = lambda: copy.deepcopy(host)
                context.devices.get = get_device
                devices.inventory = lambda: {'node': copy.deepcopy(host), 'devices': copy.deepcopy(rows)}
                state.load_shelly_registry = lambda: copy.deepcopy(fixture.get('registry', []))
                models.bundled_capabilities = lambda: {'provider': 'bundled', 'selected': preset_id,
                    'name': preset['name'], 'running': True, 'installation_complete': True,
                    'vision': False, 'capability_source': 'synthetic preset and runtime health'}
                observed_answers._host = lambda: {'id': host['id'], 'name': host['name']}
                observations = fixture.get('observations', {})
                for method, key in (('_metrics', 'cpu'), ('_memory', 'ram'), ('_storage', 'storage'), ('_network', 'network'), ('_printers', 'printers')):
                    setattr(observed_answers, method, lambda key=key: copy.deepcopy(observations.get(key, {'ok': False, 'observed_at': None})))
                notes = [{'created_at': '2026-08-01T10:00:00Z', 'updated_at': '2026-08-01T10:00:00Z',
                    'category': 'general', 'source': 'user', 'device_id': None, 'deleted': False, **copy.deepcopy(note)}
                    for note in fixture.get('notes', [])]
                state.save_memory(owner, {'facts': notes})
                state.save_memory(owner + '-foreign', {'facts': [{'id': 'foreign-note', 'text': 'FOREIGN_OWNER_CANARY', 'title': 'Private marker'}]})
                for change in fixture.get('changes', []):
                    memory.change(owner, change['id'], change.get('text'))
                conversation = 'synthetic-conversation'
                state.save_conversations({conversation: {'id': conversation, 'user_id': owner,
                    'messages': copy.deepcopy(fixture.get('history', []))}})
                store.write_private(owner, 'diagnostics', copy.deepcopy(fixture.get('reports', [])))
                store.write_private(owner + '-foreign', 'diagnostics', copy.deepcopy(fixture.get('foreign_reports', [])))
                body = {'conversation_id': conversation, 'max_tokens': 512, 'temperature': 0,
                        **copy.deepcopy(fixture['request'])}
                if fixture.get('selected_note_ids') is not None:
                    current_notes = {note['id']: note for note in state.load_memory(owner, strict=True)['facts']}
                    body['note_refs'] = [{'id': ident, 'revision': memory.revision(current_notes[ident])} for ident in fixture['selected_note_ids']]
                if fixture.get('case'):
                    journal = {'id': 'case-' + 'a' * 32, 'title': 'Synthetic problem', 'symptom': 'Synthetic symptom',
                        'computer': None, 'status': 'open', 'archived': False, 'steps': [], 'evidence': [], 'resolution': '',
                        'created_at': '2026-08-20T10:00:00Z', 'updated_at': '2026-08-21T10:00:00Z', **copy.deepcopy(fixture['case'])}
                    selected_report = fixture.get('selected_case_report')
                    report_links = []
                    if selected_report:
                        reviewed = journals.review_evidence(owner, 'report', selected_report)
                        report_links = [journals._pointer(reviewed)]
                        journal['evidence'] = [{**reviewed, 'linked_at': FIXED_TIME}]
                    journals._write(owner, {'version': 1, 'cases': [journal], 'creates': {}})
                    body['case_ref'] = {'id': journal['id'], 'revision': journals.revision(journal),
                        'step_ids': fixture.get('selected_step_ids', []), 'include_resolution': fixture.get('include_resolution', False), 'evidence_refs': report_links}
                    if fixture.get('include_case_report_facts'):
                        require(len(report_links) == 1, 'Report facts require one explicitly selected linked report')
                        body['case_ref']['report_refs'] = report_links
                def snapshots():
                    # Conversation writes are the intended real route effect;
                    # seed notes/reports/cases/keys and every other file are immutable.
                    excluded = {Path(state.CONVERSATIONS_FILE).resolve()}
                    return {str(p.relative_to(root)): sha(p.read_bytes()) for p in root.rglob('*') if p.is_file() and p.resolve() not in excluded}
                before = snapshots()
                try:
                    response = await client.post(path, json=body)
                    if len(response.content) > 512 * 1024:
                        raise ValueError('Route response exceeded bounded output')
                    data = {}; frames = []
                    if 'text/event-stream' in response.headers.get('content-type', ''):
                        frames = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
                        for frame in frames:
                            if frame.get('type') == 'meta': data.update(frame)
                        data['reply'] = ''.join(frame.get('text', '') for frame in frames if frame.get('type') == 'delta')
                        if any(frame.get('type') == 'error' for frame in frames):
                            data['error'] = [frame.get('detail') for frame in frames if frame.get('type') == 'error']
                        data['stream_done'] = bool(frames and frames[-1].get('type') == 'done')
                    else:
                        data = response.json()
                    after = snapshots()
                    require(len(calls) <= 1, 'Route issued multiple provider requests')
                    untouched = before == after
                    if forbidden_calls:
                        status = 'blocked_effect'
                    elif not untouched:
                        status = 'unexpected_store_mutation'
                    elif response.status_code != 200 or data.get('error') or ('stream_done' in data and not data['stream_done']):
                        status = 'route_error'
                    else:
                        status = 'model_request' if calls else 'deterministic_response'
                    route_results.append({'path': path, 'http_status': response.status_code, 'status': status,
                        'handled_by': data.get('handled_by'), 'response': data if not calls else {key:value for key,value in data.items() if key != 'reply'},
                        'messages': calls[0]['messages'] if calls else None, 'payload': calls[0] if calls else None,
                        'model_calls': len(calls), 'forbidden_calls': list(forbidden_calls), 'seed_stores_unchanged': untouched,
                        'changed_files': sorted(set(before) ^ set(after) | {key for key in before.keys() & after.keys() if before[key] != after[key]})})
                except Exception as error:
                    route_results.append({'path': path, 'status': 'blocked_effect' if forbidden_calls else 'capture_failed', 'error_type': type(error).__name__,
                        'detail': str(error), 'model_calls': len(calls), 'forbidden_calls': list(forbidden_calls)})
            first, last = route_results
            consistent = first['status'] == last['status'] and first.get('messages') == last.get('messages')
            if first['status'] == last['status'] == 'deterministic_response':
                consistent = first['response'].get('reply') == last['response'].get('reply') and first.get('handled_by') == last.get('handled_by')
            chosen = last
            results.append({'id': case['id'], 'lane': 'actual_bundled_chat_routes', 'request': fixture['request'],
                'routes': route_results, 'route_consistent': consistent, 'status': chosen['status'],
                'messages': chosen.get('messages'), 'request_sha256': digest(chosen['messages']) if chosen.get('messages') is not None else None,
                'response': chosen.get('response') if chosen['status'] == 'deterministic_response' else None})
    return {'schema_version': 1, 'source': str(source), 'cases': results,
        'boundaries': {'network': False, 'inference': False, 'live_data': False, 'main_imported': False,
            'authentication': 'Synthetic authenticated owner, not a live auth acceptance test',
            'requests': 'Real JSON/SSE POST ASGI routes; sync scheduling inlined without worker threads',
            'suppressed_import_startup_workers': suppressed_startup,
            'operational_debug_log': 'Discarded in memory; no model/private text logged',
            'writes': 'Fresh synthetic stores seeded before capture; real route conversation persistence allowed; all other seeded files compared'}}


def capture(source, cases, python=None, preset_id='standard'):
    encoded = json.dumps(cases, ensure_ascii=False).encode()
    require(1 <= len(cases) <= 64 and len(encoded) <= MAX_FIXTURE_BYTES, 'Bounded corpus required')
    require(isinstance(preset_id, str) and preset_id in ('lite', 'standard', 'power', 'qwen3_1_7b', 'qwen3_4b', 'qwen3_8b'),
            'Choose an explicitly supported existing text preset')
    with tempfile.TemporaryDirectory(prefix='tli-route-capture-') as directory:
        env = {key: os.environ[key] for key in ('SystemRoot', 'WINDIR', 'PATH', 'COMSPEC') if key in os.environ}
        env.update(TLI_ROOT=directory, TEMP=directory, TMP=directory)
        completed = subprocess.run([str(python or sys.executable), '-I', '-B', str(Path(__file__).resolve()),
            '--child', '--source', str(Path(source).resolve()), '--preset-id', preset_id], input=encoded, capture_output=True, timeout=90,
            cwd=directory, env=env, **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}))
        require(completed.returncode == 0, 'Isolated route capture failed: ' + completed.stderr.decode('utf-8', errors='replace')[-2500:])
        require(len(completed.stdout) <= MAX_OUTPUT_BYTES, 'Route capture output exceeded bound')
        return json.loads(completed.stdout)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--child', action='store_true')
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--preset-id', default='standard')
    args = parser.parse_args()
    require(args.child, 'Use the capture API from a controlled evaluator')
    sys.stdout.reconfigure(encoding='utf-8'); sys.stderr.reconfigure(encoding='utf-8')
    value = json.loads(sys.stdin.buffer.read(MAX_FIXTURE_BYTES + 1))
    with contextlib.redirect_stdout(sys.stderr):
        result = asyncio.run(capture_child(args.source.resolve(strict=True), value, args.preset_id))
    print(json.dumps(result, ensure_ascii=False))
