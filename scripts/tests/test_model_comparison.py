"""Only synthetic weights, fake telemetry and harness-owned loopback sockets."""
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
from pathlib import Path
import struct
import threading
import time
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


runtime = load('test_comparison_runtime', 'scripts/evaluation_runtime.py')
review = load('test_comparison_review', 'scripts/evaluate_ai_answers.py')
downloads = load('test_comparison_downloads', 'scripts/prepare_comparison_models.py')
comparison = load('test_comparison_coordinator', 'scripts/compare_model_candidates.py')
runner = load('test_comparison_runner', 'scripts/evaluate_isolated_model.py')


def test_preset_launch_flags_match_production_text_catalogue_without_manager_import():
    presets = runtime.catalogue(ROOT)
    assert len([p for p in presets.values() if not p.get('is_vision')]) == 6
    for ident, preset in presets.items():
        if preset.get('is_vision'):
            with pytest.raises(ValueError):
                runtime.launch_options(ROOT, ident, preset['filename'], 4096)
            continue
        flags, same = runtime.launch_options(ROOT, ident, preset['filename'], 4096)
        assert same == preset
        if ident.startswith('qwen3'):
            assert flags == ['--jinja', '--chat-template-kwargs', '{"enable_thinking":false}',
                             '--reasoning-budget', '0', '--reasoning-format', 'deepseek']
        else:
            assert flags == []
    manager = (ROOT / 'backend/ai/ai_manager.py').read_text(encoding='utf-8')
    assert 'cmd += preset_runtime_args(preset)' in manager
    with pytest.raises(ValueError):
        runtime.launch_options(ROOT, 'standard', 'other.gguf', 4096)
    with pytest.raises(ValueError):
        runtime.launch_options(ROOT, 'standard', presets['standard']['filename'], 8192)


def test_duplicate_workspace_lease_fails_before_work_and_releases_after_error(tmp_path):
    lock = tmp_path / 'runtime.lock'
    with pytest.raises(ValueError):
        with runtime.evaluation_lease(lock):
            with pytest.raises(RuntimeError, match='Another isolated'):
                with runtime.evaluation_lease(lock):
                    pytest.fail('A second runtime cannot own the lease')
            raise ValueError('synthetic failure')
    with runtime.evaluation_lease(lock):
        pass


def test_missing_metrics_are_unknown_and_zero_ram_is_retained():
    current = {'available': 0, 'raise': False}
    def memory():
        if current['raise']:
            raise OSError('probe failed')
        return SimpleNamespace(available=current['available'])
    fake = SimpleNamespace(Process=lambda pid: SimpleNamespace(is_running=lambda: True,
            memory_info=lambda: SimpleNamespace(rss=1024)), virtual_memory=memory, cpu_percent=lambda interval: 34)
    metrics = runtime.ProcessMetrics(123, psutil_module=fake, interval=.1)
    assert metrics.stop()['rss_peak_bytes'] is None
    metrics.begin_case(); metrics._sample(False)
    current['available'] = 500; metrics._sample()
    current['raise'] = True; metrics._sample()
    result = metrics.end_case()
    assert result['available_ram_min_bytes'] == 0 and result['rss_peak_bytes'] == 1024
    assert result['host_cpu_samples'] == 1 and result['host_cpu_mean_percent'] == 34
    assert result['probe_failures'] == 1 and result['sampling_interval_seconds'] == .1


def test_reused_or_exited_process_never_contributes_metrics():
    calls = iter([True, False])
    fake = SimpleNamespace(Process=lambda pid: SimpleNamespace(is_running=lambda: next(calls),
        memory_info=lambda: SimpleNamespace(rss=999)), virtual_memory=lambda: SimpleNamespace(available=555), cpu_percent=lambda interval: 77)
    metrics = runtime.ProcessMetrics(123, psutil_module=fake); metrics._sample()
    assert metrics.stop()['samples'] == 0


def fake_pin(payload):
    return ('test', 'publisher/model', 'a' * 40, 'synthetic.gguf', len(payload), hashlib.sha256(payload).hexdigest(), 8)


@pytest.fixture
def weights(tmp_path, monkeypatch):
    monkeypatch.setattr(downloads.shutil, 'disk_usage', lambda _: SimpleNamespace(free=8 * 1024**3))
    content = struct.pack('<4sIQQ', b'GGUF', 3, 1, 1) + b'synthetic payload'
    return tmp_path, content, fake_pin(content)


def test_download_publishes_exact_pinned_bytes_without_touching_selection(weights):
    directory, payload, row = weights
    selection = directory / 'active_model.json'; selection.write_text('{"active":"existing"}')
    status = downloads.install(row, directory, opener=SimpleNamespace(open=lambda *a, **kw: io.BytesIO(payload)))
    assert status == 'downloaded_verified'
    assert (directory / row[3]).read_bytes() == payload
    assert selection.read_text() == '{"active":"existing"}'
    assert not list(directory.glob('*.part-*'))


@pytest.mark.parametrize('mode', ['hash', 'oversize', 'cancel', 'network'])
def test_download_failures_remove_only_owned_partial_and_preserve_existing_files(weights, mode):
    directory, payload, row = weights
    original = directory / 'working.gguf'; original.write_bytes(b'original')
    class Stream(io.BytesIO):
        def read(self, size):
            if mode == 'cancel':
                raise KeyboardInterrupt()
            if mode == 'network':
                raise OSError('synthetic connection failure')
            return super().read(size)
    stream = Stream(payload + b'over' if mode == 'oversize' else payload[:-1] + b'X')
    with pytest.raises((ValueError, OSError, KeyboardInterrupt)):
        downloads.install(row, directory, opener=SimpleNamespace(open=lambda *a, **kw: stream))
    assert original.read_bytes() == b'original'
    assert not (directory / row[3]).exists() and not list(directory.glob('*.part-*'))


def test_low_disk_and_conflicting_filename_never_open_network(weights, monkeypatch):
    directory, payload, row = weights
    opener = SimpleNamespace(open=lambda *a, **kw: pytest.fail('No download should start'))
    monkeypatch.setattr(downloads.shutil, 'disk_usage', lambda _: SimpleNamespace(free=1))
    with pytest.raises(ValueError, match='free space'):
        downloads.install(row, directory, opener=opener)
    (directory / row[3]).write_bytes(b'keep')
    with pytest.raises(ValueError, match='retained'):
        downloads.install(row, directory, opener=opener)
    assert (directory / row[3]).read_bytes() == b'keep'
    bad = (*row[:3], '../escape.gguf', *row[4:])
    with pytest.raises(ValueError, match='inside'):
        downloads.install(bad, directory, opener=opener)


def test_atomic_publication_cannot_overwrite_concurrent_target(weights, monkeypatch):
    directory, payload, row = weights
    real_link = downloads.os.link
    def raced(source, target):
        target.write_bytes(b'concurrent result')
        return real_link(source, target)
    monkeypatch.setattr(downloads.os, 'link', raced)
    with pytest.raises(FileExistsError):
        downloads.install(row, directory, opener=SimpleNamespace(open=lambda *a, **kw: io.BytesIO(payload)))
    assert (directory / row[3]).read_bytes() == b'concurrent result'
    assert not list(directory.glob('*.part-*'))


@contextmanager
def loopback(chunks, *, status=200, delay=0):
    calls = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            self.send_response(status); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
            try:
                for chunk in chunks:
                    if delay:
                        time.sleep(delay)
                    self.wfile.write(chunk); self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}', calls
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)


def frame(content='', model='synthetic', finish=None, **extra):
    return b'data: ' + json.dumps({'model': model, 'choices': [{'delta': {'content': content, **extra}, 'finish_reason': finish}]}, ensure_ascii=False).encode() + b'\n\n'


def test_true_stream_timing_and_unicode_survive_split_bytes():
    value = frame('Café 音楽') + frame('', finish='stop') + b'data: [DONE]\n\n'
    chunks = [value[i:i+1] for i in range(len(value))]
    with loopback(chunks) as (endpoint, calls):
        result = review.request_answer_stream(endpoint, {'model': 'synthetic', 'messages': []}, 2)
    assert result['choices'][0]['message']['content'] == 'Café 音楽'
    assert calls[0]['stream'] is True
    metrics = result['_evaluation_metrics']
    assert 0 <= metrics['first_token_ms'] <= metrics['completion_ms']
    assert len(value) - 1 <= metrics['response_bytes'] <= len(value)  # trailing blank byte may remain unread after DONE


def test_actual_report_to_sse_transport_uses_canonical_endpoint():
    cases, corpus = review.load_cases()
    body = [frame('The current Printer paper note says Letter.'), frame('', finish='stop'), b'data: [DONE]\n\n']
    with loopback(body) as (endpoint, calls):
        report = review.make_report(cases[:1], corpus, endpoint=endpoint, model='synthetic',
            max_tokens=512, timeout=2, stream=True, transport=review.request_answer_stream)
    assert len(calls) == 1 and calls[0]['messages'] == cases[0]['messages']
    assert calls[0]['stream'] is True
    assert report['cases'][0]['status'] == 'response_received'
    assert report['cases'][0]['timing']['first_token_ms'] is not None


@pytest.mark.parametrize('endpoint', ['http://127.0.0.1:1/other/v1/chat/completions',
    'http://127.0.0.1:1/v1/chat/completions?key=private', 'http://user:pass@127.0.0.1:1/v1/chat/completions',
    'http://192.0.2.1:1/v1/chat/completions', 'http://127.0.0.1:1/v1/chat/completions#fragment'])
def test_canonical_streaming_path_does_not_relax_endpoint_scope(endpoint):
    with pytest.raises(ValueError):
        review.request_answer_stream(endpoint, {'messages': []}, 1)


@pytest.mark.parametrize('chunks', [[frame('partial')], [frame('x'), frame('y', model='other'), b'data: [DONE]\n'],
    [b'data: {"error":"synthetic failure"}\n\n'], [b'data: {invalid}\n\n']])
def test_incomplete_error_malformed_and_changed_identity_are_not_usable_answers(chunks):
    with loopback(chunks) as (endpoint, calls), pytest.raises(ValueError):
        review.request_answer_stream(endpoint, {'model': 'synthetic', 'messages': []}, 2)
    assert len(calls) == 1


def test_stream_total_deadline_is_not_reset_by_dribbling_bytes():
    with loopback([b':\n\n'] * 20, delay=.08) as (endpoint, calls):
        start = time.monotonic()
        with pytest.raises(TimeoutError) as error:
            review.request_answer_stream(endpoint, {'messages': []}, .3)
        assert time.monotonic() - start < 1
    assert error.value.evaluation_metrics['first_token_ms'] is None and len(calls) == 1


def test_redirect_and_response_size_fail_without_retry(monkeypatch):
    with loopback([], status=302) as (endpoint, calls), pytest.raises(ValueError):
        review.request_answer_stream(endpoint, {'messages': []}, 2)
    assert len(calls) == 1
    monkeypatch.setattr(review, 'MAX_STREAM_BYTES', 16)
    with loopback([frame('oversized')]) as (endpoint, calls), pytest.raises(ValueError, match='bounded'):
        review.request_answer_stream(endpoint, {'messages': []}, 2)


def test_native_sized_512_token_stream_fits_wire_budget_without_expanding_text_budget():
    event = {'choices':[{'index':0,'delta':{'content':'word'},'finish_reason':None}],
        'created':1788867400, 'model':'synthetic', 'system_fingerprint':'b7896-0e3e7a1',
        'object':'chat.completion.chunk', 'id':'chatcmpl-'+'b'*69}
    native = b'data: '+json.dumps(event,separators=(',',':')).encode()+b'\n\n'
    payload = [native]*512+[frame('',finish='length'),b'data: [DONE]\n\n']
    assert sum(map(len,payload)) > 128*1024
    cases, corpus=review.load_cases()
    with loopback(payload) as (endpoint,calls):
        result=review.make_report(cases[:1],corpus,endpoint=endpoint,model='synthetic',
            max_tokens=512,timeout=3,stream=True,transport=review.request_answer_stream)
    value=result['cases'][0]
    assert len(calls)==1 and calls[0]['max_tokens']==512
    assert value['status']=='response_received' and value['finish_reason']=='length'
    assert value['answer']=='word'*512
    assert value['timing']['response_bytes'] > 128*1024
    assert result['limits']['max_response_bytes']==128*1024 and result['limits']['max_stream_bytes']==512*1024


def test_stream_text_remains_bounded_independently_of_envelope(monkeypatch):
    monkeypatch.setattr(review,'MAX_RESPONSE_BYTES',16)
    with loopback([frame('x'*17),b'data: [DONE]\n\n']) as (endpoint,_),pytest.raises(ValueError,match='answer text'):
        review.request_answer_stream(endpoint,{'messages':[]},2)


def test_slow_first_body_byte_obeys_total_deadline():
    with loopback([frame('late'),b'data: [DONE]\n\n'],delay=.5) as (endpoint,_):
        started=time.monotonic()
        with pytest.raises(TimeoutError) as error:
            review.request_answer_stream(endpoint,{'messages':[]},.2)
        assert time.monotonic()-started<.8
    assert error.value.evaluation_metrics['first_token_ms'] is None


def test_dribbling_http_headers_cannot_extend_total_deadline():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_POST(self):
            self.rfile.read(int(self.headers['Content-Length']))
            try:
                for byte in b'HTTP/1.0 200 OK\r\nContent-Type: text/event-stream\r\n\r\n':
                    self.wfile.write(bytes([byte]));self.wfile.flush();time.sleep(.04)
            except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        started=time.monotonic()
        with pytest.raises(TimeoutError):
            review.request_answer_stream(f'http://127.0.0.1:{server.server_port}',{'messages':[]},.2)
        assert time.monotonic()-started<.8
    finally:
        server.shutdown();server.server_close();thread.join(timeout=2)


def test_startup_identity_probe_cannot_follow_another_listener_redirect():
    calls = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            calls.append(self.path)
            self.send_response(302)
            self.send_header('Location', f'http://127.0.0.1:{self.server.server_port}/unrelated-service')
            self.end_headers()
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        with pytest.raises(Exception):
            runner.read_json(f'http://127.0.0.1:{server.server_port}/v1/models')
        assert calls == ['/v1/models']
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)


def test_original_corpus_stays23_and_development_probes_are_explicit():
    original, digest = review.load_cases()
    cases, expanded = review.load_cases([ROOT / 'scripts/fixtures/tli_answer_development.json'])
    assert len(original) == 23 and len(cases) == 31 and original == cases[:23] and digest != expanded
    assert sum(bool(case.get('timing_probe')) for case in cases) == 3
    assert all(c['id'].startswith('dev-') for c in cases if c.get('timing_probe'))


def test_timing_statistics_do_not_convert_missing_to_zero_or_quality():
    assert comparison.percentile([None]) is None
    assert comparison.percentile([None, 1, 9, 2]) == 9
    assert comparison.percentile([False, 0, float('nan')]) == 0


@pytest.mark.parametrize('failure', ['timeout', 'replacement_start', 'stop_unconfirmed', 'memory_pressure'])
def test_owned_runner_continues_only_next_question_after_confirmed_stop(tmp_path, monkeypatch, failure):
    source = tmp_path / 'source'
    (source / 'scripts').mkdir(parents=True)
    (source / 'scripts/evaluate_ai_answers.py').write_text('''
calls = []
def load_cases(additional=()):
    return [{'id':'a'}, {'id':'b'}, {'id':'c'}], 'corpus'
def source_identity():
    return {'sha256':'same'}
def request_answer_stream(endpoint, payload, timeout):
    calls.append({'endpoint':endpoint, 'id':payload['id']})
    if payload['id'] == 'a':
        raise TimeoutError('synthetic deadline')
    return {'_evaluation_metrics':{'first_token_ms':1}}
def make_report(cases, corpus, **kwargs):
    results=[]
    for case in cases:
        try:
            response = kwargs['transport'](kwargs['endpoint'], {'model':kwargs['model'],'id':case['id']}, kwargs['timeout'])
            results.append({'id':case['id'],'status':'response_received','timing':response['_evaluation_metrics']})
        except Exception as error:
            metrics = getattr(error,'evaluation_metrics',{})
            results.append({'id':case['id'],'status':'not_run' if metrics.get('request_sent') is False else 'failed','timing':metrics})
    return {'cases':results,'synthetic_transport_calls':calls}
''', encoding='utf-8')
    model, binary = tmp_path / 'fixture.gguf', tmp_path / 'runtime.exe'
    model.write_bytes(b'fixture'); binary.write_bytes(b'never execute')
    flags = ['--jinja', '--chat-template-kwargs', '{"enable_thinking":false}', '--reasoning-budget', '0', '--reasoning-format', 'deepseek']
    monkeypatch.setattr(runner, 'launch_options', lambda *a: (flags, {'min_ram_gb':8, 'min_runtime_build':5092}))
    monkeypatch.setattr(runner, 'source_module', lambda *a: SimpleNamespace(support=lambda *a: {'state':'supported'}))
    resource_checks = []
    def resources(*args):
        resource_checks.append(True)
        return {'sufficient': not (failure == 'memory_pressure' and len(resource_checks) > 2),'total_ram_bytes':64*1024**3}
    monkeypatch.setattr(runner, 'resources', resources)
    commands, children = [], []
    def launch(command, **kwargs):
        assert all(child.stopped for child in children), 'A live owned child may never overlap its replacement'
        commands.append(command)
        if failure == 'replacement_start' and len(commands) == 2:
            raise OSError('synthetic startup failure')
        owned = SimpleNamespace(pid=123456+len(children), stopped=False)
        owned.poll = lambda: 0 if owned.stopped else None
        owned.terminate = lambda: setattr(owned, 'stopped', failure != 'stop_unconfirmed')
        owned.wait = lambda timeout: 0
        children.append(owned)
        return owned
    monkeypatch.setattr(runner.subprocess, 'Popen', launch)
    monkeypatch.setattr(runner, 'read_json', lambda url: {'status':'ok'} if url.endswith('/health') else {'data':[{'id':commands[0][commands[0].index('--alias')+1]}]})
    monkeypatch.setattr(runner, 'ProcessMetrics', lambda pid: SimpleNamespace(start=lambda:None, begin_case=lambda:None, end_case=lambda:{'rss_peak_bytes':None}, stop=lambda:{}))
    result = runner.run(SimpleNamespace(source_root=source,model_file=model,runtime=binary,context=4096,threads=4,
        max_tokens=512,timeout=90,case=[],output=tmp_path/'results',preset_id='qwen3_4b',measure_stream=True))
    assert len(commands)==(2 if failure in ('timeout','replacement_start') else 1)
    assert all(command[-len(flags):]==flags for command in commands)
    assert commands[0][commands[0].index('--gpu-layers')+1]=='0'
    assert commands[0][commands[0].index('--threads')+1]=='4'
    answer=json.loads((tmp_path/'results/answers.json').read_text())
    calls = answer['synthetic_transport_calls']
    assert [row['id'] for row in calls] == (['a','b','c'] if failure == 'timeout' else ['a'])
    assert answer['cases'][0]['status'] == 'failed'
    if failure == 'timeout':
        assert calls[0]['endpoint'] != calls[1]['endpoint'] == calls[2]['endpoint']
        assert [row['status'] for row in answer['cases']] == ['failed','response_received','response_received']
        assert answer['cases'][1]['timing']['runtime_restarted_before_request'] is True
        assert answer['cases'][2]['timing']['runtime_restarted_before_request'] is False
        assert result['runtime_restarts'] == 1 and len(result['runtime_instances']) == 2
    else:
        assert [row['status'] for row in answer['cases'][1:]] == ['not_run','not_run']
    assert result['child_stopped'] is (failure != 'stop_unconfirmed')
    assert result['artifacts_unchanged']
    assert result['status'] == ('failed' if failure == 'stop_unconfirmed' else 'incomplete')


def test_frozen_policy_rejects_changed_holdout_before_reading_weights(tmp_path, monkeypatch):
    source, workspace=tmp_path/'source',tmp_path/'workspace'
    (source/'scripts/fixtures').mkdir(parents=True); (workspace/'sealed').mkdir(parents=True)
    (source/'scripts/fixtures/tli_answer_development.json').write_text('{}')
    (workspace/'sealed/heldout.json').write_text('{"modified":true}')
    (workspace/'sealed/policy.json').write_text(json.dumps({'frozen_before_answers':True,'heldout_sha256':'wrong'}))
    monkeypatch.setattr(comparison,'module',lambda *a:SimpleNamespace(verify_snapshot=lambda *a:{'fingerprint':'expected'}))
    with pytest.raises(ValueError,match='Frozen corpus'):
        comparison.frozen_inputs(source,tmp_path/'manifest.json','expected',workspace)


@pytest.mark.parametrize('changed', ['corpus_sha256', 'policy_sha256', 'heldout_sha256', 'development_sha256'])
def test_self_consistent_replaced_sealed_inputs_are_still_rejected_mid_comparison(changed):
    original = {key:'before' for key in ['corpus_sha256', 'policy_sha256', 'heldout_sha256', 'development_sha256']}
    with pytest.raises(ValueError, match='changed during'):
        comparison.same_inputs(original, {**original, changed:'after'})
