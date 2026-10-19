import json
import os
from pathlib import Path
import sys
import time

from fastapi import HTTPException
import pytest

import task_process as runner


def command(tmp_path, code, timeout=10):
    return {'executable': str(Path(sys.executable).resolve()), 'args': ['-c', code],
            'cwd': str(tmp_path), 'timeout_seconds': timeout}


def test_real_command_output_environment_and_nonzero_exit(tmp_path, monkeypatch):
    monkeypatch.setenv('TLI_CLOUD_API_KEY', 'must-not-leak')
    seen = []
    code = "import os,sys; print(os.environ.get('TLI_CLOUD_API_KEY', 'absent')); print('error',file=sys.stderr); sys.exit(7)"
    result = runner.execute(command(tmp_path, code), lambda: None, seen.append)
    assert result['exit_code'] == 7 and result['status'] == 'failed'
    assert result['stdout'].strip() == 'absent' and result['stderr'].strip() == 'error'
    assert not result['sandboxed'] and result['execution_scope'] == 'host_account'
    assert {item['stream'] for item in seen} == {'stdout', 'stderr'}


def test_fingerprint_is_argument_and_executable_bound(tmp_path):
    original = runner.normalize_command(command(tmp_path, 'print(1)'))
    assert runner.command_fingerprint(original) == runner.command_fingerprint(original)
    assert runner.command_fingerprint(original) != runner.command_fingerprint({**original, 'args': ['-c', 'print(2)']})
    with pytest.raises(HTTPException, match='changed'):
        runner.normalize_command({**original, 'executable_sha256': '0' * 64})
    with pytest.raises(HTTPException):
        runner.normalize_command({**original, 'env': {'SECRET': 'bad'}})


def test_timeout_and_bounded_output(tmp_path, monkeypatch):
    result = runner.execute(command(tmp_path, 'import time; time.sleep(30)', timeout=1), lambda: None)
    assert result['timed_out'] and result['stop_reason'] == 'timeout'
    monkeypatch.setattr(runner, 'MAX_OUTPUT', 8192)
    result = runner.execute(command(tmp_path, "print('x'*100000)"), lambda: None)
    assert result['output_truncated'] and len(result['stdout'].encode()) <= 8192


def test_revocation_stops_owned_command(tmp_path):
    stop_at = time.monotonic() + .3
    def check():
        if time.monotonic() >= stop_at:
            raise HTTPException(401, 'Task authority revoked')
    with pytest.raises(HTTPException, match='revoked'):
        runner.execute(command(tmp_path, 'import time; time.sleep(30)'), check)
    assert time.monotonic() < stop_at + 6


@pytest.mark.skipif(os.name != 'nt', reason='Windows job and console contract')
def test_windows_no_console_and_descendant_cleanup(tmp_path):
    import psutil
    code = ("import ctypes,json,subprocess,sys; "
            "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); "
            "print(json.dumps({'pid':child.pid,'console':ctypes.windll.kernel32.GetConsoleWindow()}),flush=True)")
    result = runner.execute(command(tmp_path, code), lambda: None)
    observed = json.loads(result['stdout'])
    assert observed['console'] == 0
    assert not psutil.pid_exists(observed['pid'])


def test_invalid_commands_never_launch(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('No process should launch')
    monkeypatch.setattr(runner.subprocess, 'Popen', forbidden)
    with pytest.raises(HTTPException):
        runner.execute({'executable': 'python', 'cwd': str(tmp_path), 'args': []}, lambda: None)
    with pytest.raises(HTTPException):
        runner.execute(command(tmp_path, 'print(1)', timeout=0), lambda: None)
    with pytest.raises(HTTPException, match='ambiguous'):
        runner.execute({**command(tmp_path, 'print(1)'), 'cwd': str(tmp_path / 'folder. ')}, lambda: None)
