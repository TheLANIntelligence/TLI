"""Scripted model acceptance of real task effects; no network or live user data."""
import hashlib
import json
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace

from fastapi import HTTPException, Request
import pytest

import host_runs
import task_agent
import task_process
import task_provider
import task_workspace
import tli_state as S


@pytest.fixture
def task_store(tmp_path, monkeypatch):
    data = tmp_path / 'private'
    monkeypatch.setattr(S, 'DATA_DIR', str(data))
    monkeypatch.setattr(S, 'VAULT_DIR', str(data / 'vault'))
    monkeypatch.setattr(S, 'CONVERSATIONS_FILE', str(data / 'conversations.json'))
    monkeypatch.setattr(S, '_CONV_KEY', b't' * 32)
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': False})
    root = tmp_path / 'game'
    root.mkdir()
    for directory in ('mods', 'logs', 'saves'):
        (root / directory).mkdir()
    area = task_workspace.save_area('local', name='Fixture game', read_roots=[str(root)], write_roots=[str(root / 'mods')])
    S.save_conversations({'fixture': {'id': 'fixture', 'user_id': 'local', 'messages': [], 'title': 'Fixture'}})
    yield SimpleNamespace(root=root, area=area, data=data)
    for run in list(host_runs._runs.values()):
        run.stop.set()
        if run.thread:
            run.thread.join(5)


class Run:
    owner = 'local'
    def __init__(self, ident='run-fixture', check=lambda: None):
        self.ident, self.check = ident, check
        self.entry = {'conversation_id': 'fixture'}
        self.events = []
    def bind_task(self, ident):
        self.entry['task_id'] = ident
    def emit(self, value):
        self.events.append(value)


def payload(store, **extra):
    return {'message': 'Repair this game mod error and verify the result.', 'area_id': store.area['id'],
            'area_revision': store.area['revision'], 'conversation_id': 'fixture',
            'use_conversation_history': False, **extra}


def tool(name, **arguments):
    return {'kind': 'tool', 'tool': name, 'arguments': arguments}


def final(text='Configuration repaired; game launch not verified.'):
    return {'kind': 'final', 'status': 'completed', 'text': text}


def observed(messages):
    return json.loads(messages[-1]['content'].split(': ', 1)[1])


def script(monkeypatch, steps):
    remaining = iter(steps)
    calls = []
    def complete(provider, messages, check):
        check()
        calls.append(messages)
        step = next(remaining)
        return task_provider.parse_step(step(messages) if callable(step) else step)
    monkeypatch.setattr(task_provider, 'complete', complete)
    return calls


def test_game_log_to_reversible_config_repair(task_store, monkeypatch):
    store = task_store
    config = store.root / 'mods' / 'settings.json'
    original = b'{"hotkey":"F8",}\r\n'
    config.write_bytes(original)
    (store.root / 'logs' / 'latest.log').write_text('JSONDecodeError: mods/settings.json contains a trailing comma\n')
    protected = [store.root / 'saves' / 'slot.sav', store.root / 'game.exe', store.root / 'mods' / 'plugin.dll']
    for path in protected:
        path.write_bytes(b'protected\x00sentinel')
    def correction(messages):
        evidence = observed(messages)
        assert evidence[-1]['tool'] == 'workspace_read'
        return tool('workspace_write', path=str(config), content='{"hotkey":"F8"}\n',
                    expected_sha256=evidence[-1]['result']['sha256'])
    script(monkeypatch, [tool('workspace_search', path=str(store.root), query='JSONDecodeError'),
                        tool('workspace_read', path=str(config)), correction,
                        tool('workspace_validate', path=str(config)), final()])
    run = Run()
    result = task_agent.execute(run, payload(store))
    assert result['task_status'] == 'completed'
    assert config.read_bytes() == b'{"hotkey":"F8"}\r\n'
    assert all(path.read_bytes() == b'protected\x00sentinel' for path in protected)
    assert result['agent']['receipts'][-1]['result']['valid'] is True
    write = next(item for item in result['agent']['receipts'] if item['tool'] == 'workspace_write')
    task_agent.undo('local', result['task_id'], write['result']['receipt']['id'], lambda: None)
    assert config.read_bytes() == original
    assert run.events[-1] == {'type': 'done'}


def test_multifile_command_approval_failure_repair_and_retest(task_store, monkeypatch):
    store = task_store
    source = store.root / 'mods' / 'mod.py'
    verify = store.root / 'mods' / 'verify.py'
    command = {'executable': str(Path(sys.executable).resolve()), 'args': [str(verify)],
               'cwd': str(source.parent), 'timeout_seconds': 10}
    execution = []
    original_execute = task_process.execute
    def execute(value, check, on_output=None):
        result = original_execute(value, check, on_output)
        execution.append(result)
        return result
    monkeypatch.setattr(task_process, 'execute', execute)
    def repair(messages):
        assert json.loads(messages[-2]['content'])['user_follow_ups'] == ['Use the observed failure to repair and retest.']
        evidence = observed(messages)
        assert any(item.get('result', {}).get('exit_code') == 1 for item in evidence if isinstance(item.get('result'), dict))
        return tool('workspace_write', path=str(source), content='VALUE = 2\n', expected_sha256=evidence[-1]['result']['sha256'])
    script(monkeypatch, [tool('workspace_write', path=str(source), content='VALUE = 1\n', create=True, expected_sha256=''),
                        tool('workspace_write', path=str(verify), content='from mod import VALUE\nassert VALUE == 2\nprint("mod passed")\n', create=True),
                        tool('run_command', **command), tool('workspace_read', path=str(source)), repair,
                        tool('run_command', **command), final('Mod test passed after repairing the source.')])
    initial = task_agent.execute(Run(), payload(store))
    assert initial['task_status'] == 'needs_input' and execution == []
    task = initial['agent']
    approved = task_agent.approve('local', task['id'], task['pending']['id'], task['revision'], lambda: None)
    result = task_agent.execute(Run('run-resumed'), payload(store, resume_task_id=task['id'], expected_revision=approved['revision'],
        follow_up='Use the observed failure to repair and retest.'))
    assert result['task_status'] == 'completed'
    assert [item['exit_code'] for item in execution] == [1, 0]
    assert execution[-1]['stdout'].strip() == 'mod passed'
    assert source.read_text() == 'VALUE = 2\n'
    assert result['agent']['message'] == payload(store)['message']  # Resume request identity remains stable.


def test_foreign_owner_and_revoked_area_stop_task(task_store, monkeypatch):
    store = task_store
    source = store.root / 'mods' / 'config.json'
    source.write_text('{}')
    def revoke(messages):
        task_workspace.revoke_area('local', store.area['id'])
        return tool('workspace_write', path=str(source), content='[]', expected_sha256=hashlib.sha256(b'{}').hexdigest())
    script(monkeypatch, [revoke])
    run = Run()
    with pytest.raises(HTTPException):
        task_agent.execute(run, payload(store))
    assert source.read_text() == '{}'
    with pytest.raises(HTTPException) as foreign:
        task_agent.get('another-owner', run.entry['task_id'])
    assert foreign.value.status_code == 404
    assert task_agent.get('local', run.entry['task_id'])['status'] == 'interrupted'


def test_invalid_model_and_missing_cloud_sharing_do_not_act(task_store, monkeypatch):
    store = task_store
    calls = script(monkeypatch, [{'kind': 'tool', 'tool': 'delete_everything', 'arguments': {}}])
    run = Run()
    with pytest.raises(HTTPException) as invalid:
        task_agent.execute(run, payload(store))
    assert invalid.value.status_code == 502
    assert task_agent.get('local', run.entry['task_id'])['receipts'] == []
    with pytest.raises(HTTPException) as sharing:
        task_agent.validate_request('local', payload(store, provider={'kind': 'openai', 'model': 'fixture'}, share_context=False))
    assert sharing.value.status_code == 409 and len(calls) == 1


def _request(origin=True, remote=False):
    host = '192.168.1.10' if remote else '127.0.0.1'
    headers = [(b'host', (host + ':8000').encode())]
    if origin:
        headers.append((b'origin', ('http://' + host + ':8000').encode()))
    return Request({'type': 'http', 'scheme': 'http', 'server': (host, 8000), 'client': (host, 1234),
                    'path': '/api/runs', 'method': 'POST', 'headers': headers})


def test_host_run_reconnect_identity_and_browser_authority(task_store, monkeypatch):
    store = task_store
    calls = script(monkeypatch, [final('Task finished.')])
    args = {'request_id': 'task-acceptance-' + 'a' * 20, 'kind': 'agent_task', 'payload': payload(store)}
    for request in (_request(origin=False), _request(remote=True)):
        with pytest.raises(HTTPException) as denial:
            host_runs.submit('local', request, **args)
        assert denial.value.status_code == 403
    first, created = host_runs.submit('local', _request(), **args)
    assert created
    for _ in range(200):
        result = host_runs.get(first['id'], 'local')
        if result['status'] in host_runs.TERMINAL:
            break
        time.sleep(.01)
    assert result['status'] == 'completed', result.get('error')
    duplicate, created = host_runs.submit('local', _request(), **args)
    assert not created and duplicate['id'] == first['id'] and len(calls) == 1
    host_runs._runs.clear()
    restored = host_runs.get(first['id'], 'local')
    assert restored['result']['reply'] == 'Task finished.'
    with pytest.raises(HTTPException):
        host_runs.get(first['id'], 'another-owner')


def test_interrupted_effect_journal_is_not_replayed(task_store, monkeypatch):
    store = task_store
    source = store.root / 'mods' / 'created.json'
    active = {'ok': True, 'writes': 0}
    original = task_workspace.dispatch
    def effect(*args, **kwargs):
        result = original(*args, **kwargs)
        if args[2] == 'workspace_write':
            active['writes'] += 1
            active['ok'] = False
        return result
    monkeypatch.setattr(task_workspace, 'dispatch', effect)
    script(monkeypatch, [tool('workspace_write', path=str(source), content='{}', create=True)])
    def check():
        if not active['ok']:
            raise HTTPException(401, 'Session revoked after effect')
    run = Run(check=check)
    with pytest.raises(HTTPException):
        task_agent.execute(run, payload(store))
    assert source.read_text() == '{}'
    task = task_agent.get('local', run.entry['task_id'])
    assert task['status'] == 'interrupted'
    # A new authorized run may inspect state; it must not replay the prior
    # effect or any pending action from the interrupted run.
    active['ok'] = True
    def confirmed(messages):
        evidence = observed(messages)
        assert evidence[-1]['tool'] == 'workspace_read'
        assert evidence[-1]['result']['content'] == '{}'
        assert any(item['tool'] == 'workspace_write' for item in evidence)
        return final('Inspected the existing file; no edit was repeated.')
    calls = script(monkeypatch, [tool('workspace_read', path=str(source)), confirmed])
    resumed = task_agent.execute(Run('run-inspect'), payload(store, resume_task_id=task['id'], expected_revision=task['revision']))
    assert resumed['task_status'] == 'completed' and active['writes'] == 1
    assert len(calls) == 2 and source.read_text() == '{}'
    assert sum(item['tool'] == 'workspace_write' for item in resumed['agent']['receipts']) == 1


def test_large_read_keeps_edit_hash_and_structured_provider_evidence(task_store, monkeypatch):
    source = task_store.root / 'mods' / 'large.json'
    original = json.dumps({'padding': 'x' * 30000, 'enabled': False}) + '\r\n'
    source.write_bytes(original.encode())
    expected = hashlib.sha256(original.encode()).hexdigest()
    def correction(messages):
        evidence = observed(messages)
        result = evidence[-1]['result']
        assert result['path'] == str(source) and result['sha256'] == expected
        assert result['encoding'] == 'utf-8' and result['newline'] == repr('\r\n')
        assert result['truncated'] is True
        return tool('workspace_write', path=str(source), content='{"enabled":true}\n', expected_sha256=result['sha256'])
    script(monkeypatch, [tool('workspace_read', path=str(source)), correction,
                        tool('workspace_validate', path=str(source)), final()])
    result = task_agent.execute(Run(), payload(task_store))
    receipt = result['agent']['receipts'][0]['result']
    assert len(receipt['content']) > 20000 and receipt['sha256'] == expected
    assert receipt['encoding'] == 'utf-8' and receipt['total_lines'] == 1
    assert source.read_bytes() == b'{"enabled":true}\r\n'


def test_selected_provider_change_stops_before_effect(task_store, monkeypatch):
    source = task_store.root / 'mods' / 'new.json'
    endpoint = {'model': 'fixture-model-a'}
    monkeypatch.setattr(task_provider, 'binding', lambda provider: dict(endpoint))
    def changed(messages):
        endpoint['model'] = 'fixture-model-b'
        return tool('workspace_write', path=str(source), content='{}', create=True)
    script(monkeypatch, [changed])
    run = Run()
    with pytest.raises(HTTPException, match='endpoint or resource changed'):
        task_agent.execute(run, payload(task_store))
    assert not source.exists()
    task = task_agent.get('local', run.entry['task_id'])
    assert task['status'] == 'interrupted' and task['receipts'] == []


def test_uncertain_file_journal_preserves_task_recovery_receipt(task_store, monkeypatch):
    source = task_store.root / 'mods' / 'config.json'
    source.write_text('{}')
    original_save, count = task_workspace._save, 0
    def fail_final(*args):
        nonlocal count
        count += 1
        if count == 2:
            raise task_workspace.security_state.SecurityStateUnavailable('fixture journal failure')
        original_save(*args)
    monkeypatch.setattr(task_workspace, '_save', fail_final)
    script(monkeypatch, [tool('workspace_write', path=str(source), content='[]', expected_sha256=hashlib.sha256(b'{}').hexdigest())])
    result = task_agent.execute(Run(), payload(task_store))
    assert result['task_status'] == 'needs_input' and source.read_text() == '[]'
    receipt = result['agent']['receipts'][-1]['result']
    assert receipt['outcome'] == 'unknown' and receipt['receipt']['task_id'] == result['task_id']
    task_agent.undo('local', result['task_id'], receipt['receipt']['id'], lambda: None)
    assert source.read_text() == '{}'


def test_restart_marks_task_interrupted_without_replaying_effect(task_store, monkeypatch):
    store = task_store
    source = store.root / 'mods' / 'restart.json'
    calls = script(monkeypatch, [tool('workspace_write', path=str(source), content='{}', create=True), final()])
    value = task_agent.execute(Run('run-restart-fixture'), payload(store))
    task = task_agent._read('local', value['task_id'])
    task['status'] = 'running'
    task['receipts'][-1]['outcome'] = 'started'
    # Emulate a crash after the workspace committed its own durable journal,
    # before the enclosing task could save the returned operation identity.
    operation_id = task['receipts'][-1].pop('result')['receipt']['id']
    task_agent._write(task)
    journal = store.data / 'workspace' / 'runs.json'
    journal.parent.mkdir(parents=True, exist_ok=True)
    entry = {'id': 'run-restart-fixture', 'owner': 'local', 'request_id': 'restart-request', 'digest': 'fixture',
             'kind': 'agent_task', 'status': 'running', 'conversation_id': 'fixture', 'task_id': task['id']}
    journal.write_text(json.dumps({'version': 1, 'runs': {'run-restart-fixture': entry}}))
    monkeypatch.setattr(host_runs, '_loaded_path', None)
    recovered = task_agent.get('local', task['id'])
    assert recovered['status'] == 'interrupted'
    assert any(receipt['outcome'] == 'unknown' for receipt in recovered['receipts'])
    assert source.read_text() == '{}' and len(calls) == 2
    assert host_runs.state('run-restart-fixture', 'local') == 'interrupted'
    assert any(receipt.get('result', {}).get('receipt', {}).get('id') == operation_id
               for receipt in recovered['receipts'])
    task_agent.undo('local', task['id'], operation_id, lambda: None)
    assert not source.exists() and len(calls) == 2
