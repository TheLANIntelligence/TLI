"""Exercise the packaged hidden storage entrypoint using only a temporary tree."""
from __future__ import annotations
import argparse
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--backend', type=Path, required=True)
    parser.add_argument('--exe', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    backend, exe, output = args.backend.resolve(), args.exe.resolve(), args.output.resolve()
    sys.path.insert(0, str(backend))
    process = importlib.import_module('storage_scan_process')
    assert 'tli_state' not in sys.modules and 'main' not in sys.modules
    process.command = lambda: [str(exe), '--tli-storage-worker']
    report = {'synthetic': True, 'package': str(exe), 'sha256': hashlib.sha256(exe.read_bytes()).hexdigest(), 'backend': str(backend), 'checks': []}
    with tempfile.TemporaryDirectory(prefix='tli-packaged-storage-') as temporary:
        sandbox = Path(temporary)
        root = sandbox / 'fixture'
        root.mkdir()
        (root / 'AppData').mkdir()
        (root / 'ordinary.txt').write_bytes(b'hello')
        (root / 'AppData' / 'excluded.txt').write_bytes(b'cache')
        before = {str(p.relative_to(sandbox)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sandbox.rglob('*') if p.is_file()}
        original = Path.cwd()
        os.chdir(sandbox)
        try:
            for name, folder, profile, include in [('quick', root, 'quick', False), ('deep', root, 'deep', True), ('unavailable', root / 'missing', 'quick', False)]:
                frames = []
                started = time.monotonic()
                request = importlib.import_module('storage_scan_worker').validate_request({'operation':'scan','path':str(folder),'profile':profile,'include_excluded':include})
                result = process.run(request, threading.Event(), frames.append, lambda: True)
                assert result.get('worker_stopped') is True, result
                if name == 'unavailable':
                    assert result['type'] == 'error', result
                else:
                    assert result['type'] == 'result', result
                    assert result['result']['tree']['size'] == (10 if include else 5), result
                report['checks'].append({'name': name, 'passed':True,'seconds':round(time.monotonic()-started,3),'progress':frames,'result':result})
        finally:
            os.chdir(original)
        after = {str(p.relative_to(sandbox)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sandbox.rglob('*') if p.is_file()}
        assert before == after, 'Worker changed fixture or created application data'
        report['fixture_unchanged'] = True
        report['application_modules_imported_by_parent'] = any(name in sys.modules for name in ['tli_state','main','ai.ai_manager'])
        assert not report['application_modules_imported_by_parent']
    report['passed'] = True
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'passed':True,'output':str(output),'sha256':report['sha256']}))


if __name__ == '__main__':
    main()
