"""Explicit local desktop restart/quit with a detached, fixed-installation helper.

The HTTP boundary authenticates the desktop browser. This service independently
binds confirmation to a session principal, installation, process generation and
reviewed settings. No application imports, network listener, process killing, or
background work occurs on import.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import secrets
import threading
import time

import host_control as H
import host_launcher as L
import startup_config

PROTOCOL = 'host-lifecycle-v1'
PREVIEW_SECONDS = 60
MAX_PREVIEWS = 32
MAX_OPERATIONS = 64
MAX_BYTES = 256 * 1024
TERMINAL = {'completed', 'failed'}
STATUSES = {'accepted', 'stopping', 'restarting', 'completed', 'failed', 'uncertain'}
_lock = threading.RLock()


def _principal(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 4096:
        H._fail('A current desktop session is required.', 401)
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _request(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{32,64}', value):
        H._fail('A 32–64 character hexadecimal request ID is required.', 422)
    return value


def _read(root):
    try:
        value = H.read_json(H.path_for(root, 'lifecycle.json'), MAX_BYTES)
    except FileNotFoundError:
        return {'version': 1, 'previews': [], 'operations': []}
    if (not isinstance(value, dict) or set(value) != {'version', 'previews', 'operations'} or value['version'] != 1
            or not isinstance(value['previews'], list) or len(value['previews']) > MAX_PREVIEWS
            or not isinstance(value['operations'], list) or len(value['operations']) > MAX_OPERATIONS):
        H._fail('Desktop lifecycle receipts are unreadable. No operation was replayed.', 503)
    for row in value['previews'] + value['operations']:
        if (not isinstance(row, dict) or not H.REQUEST.fullmatch(str(row.get('id', '')))
                or not H.HEX.fullmatch(str(row.get('principal', ''))) or row.get('action') not in {'restart', 'quit'}
                or type(row.get('at')) not in (int, float) or not math.isfinite(row['at'])
                or type(row.get('expires_at')) not in (int, float) or not math.isfinite(row['expires_at'])):
            H._fail('Desktop lifecycle receipts are unreadable. No operation was replayed.', 503)
    if any(row.get('status') not in STATUSES for row in value['operations']):
        H._fail('Desktop lifecycle status is unconfirmed. No operation was replayed.', 503)
    if any(len({row['id'] for row in value[key]}) != len(value[key]) for key in ('previews', 'operations')):
        H._fail('Desktop lifecycle receipt IDs are ambiguous. No operation was replayed.', 503)
    return value


def _write(root, value):
    if len(json.dumps(value, separators=(',', ':'), allow_nan=False).encode()) > MAX_BYTES:
        H._fail('The bounded desktop lifecycle receipt store is full.', 503)
    H.write_json(H.path_for(root, 'lifecycle.json'), value)


def _prune(value, now):
    # Expired previews can never authorize a replay. Active/unconfirmed receipts
    # are retained even if a helper crashes; age is not proof of process exit.
    value['previews'] = [row for row in value['previews'] if row['expires_at'] > now]
    value['operations'] = [row for row in value['operations'] if row['status'] not in TERMINAL or now - row['at'] < 86400]
    while len(value['operations']) >= MAX_OPERATIONS:
        terminal = next((row for row in value['operations'] if row['status'] in TERMINAL), None)
        if terminal is None:
            break
        value['operations'].remove(terminal)


def _settings(root):
    return {'current_settings': startup_config.resolve(root)['effective_next'],
            'next_settings': startup_config.resolve(root, environ={})['effective_next']}


def _reconcile_exited(root, value, current_child):
    """An explicit desktop relaunch may resolve an abandoned old receipt.

    Only recorded exited generations allow reconciliation. This never retries,
    starts or stops a process and never treats a failed probe as proof of exit.
    """
    changed = False
    for row in value['operations']:
        if row['status'] in TERMINAL or row.get('child') == current_child:
            continue
        if L.process_generation_state(root, row.get('child')) != 'exited':
            continue
        helper = row.get('helper')
        if helper is None:
            # A helper cannot consume accepted intent without its recorded
            # generation; uncertain intent is also explicitly non-consumable.
            safe = row['status'] in {'accepted', 'uncertain'}
        else:
            safe = L.process_generation_state(root, helper) == 'exited'
        if safe:
            row.update(status='failed', updated_at=time.time(), backend_exit_confirmed=True,
                       message='An earlier operation ended without a final receipt. Its old process exited; the current desktop launch remains available. Nothing was replayed.')
            changed = True
    if changed:
        _write(root, value)
    return value


def _current(root):
    identity = H.installation(root)
    if os.environ.get('TLI_MANAGED_CHILD') != identity['installation_id']:
        H._fail('Open TLI with its desktop launcher to use Restart or Quit. This diagnostic session is not a managed desktop process.')
    children = {row['pid']: row for row in L.recorded_backend_children(root)}
    child = children.get(os.getpid())
    if len(children) != 1 or child is None or L.process_generation_state(root, child) != 'running':
        H._fail('This running backend does not match one recorded desktop process. No process was adopted or stopped.')
    L.python_path(root, windowless=True)
    script = root / 'backend' / 'host_lifecycle.py'
    if not script.is_file() or script.is_symlink():
        H._fail('The desktop lifecycle helper is unavailable. Restart from the local desktop launcher.', 503)
    return identity, child


def _public(row, *, duplicate=False):
    return {'protocol': PROTOCOL, 'request_id': row['id'], 'action': row['action'],
            'status': row['status'], 'accepted': True, 'duplicate': duplicate,
            'message': row.get('message', 'The explicit desktop operation was accepted.'),
            'current_url': startup_config.browser_url(row['current_settings']),
            'next_url': startup_config.browser_url(row['next_settings']),
            'requested_at': row['at'], 'updated_at': row.get('updated_at', row['at']),
            'backend_exit_confirmed': row.get('backend_exit_confirmed', False)}


def capabilities(root):
    root = H.root_path(root)
    try:
        identity, child = _current(root)
        settings = _settings(root)
        with _lock, H.FileLock(H.path_for(root, 'lifecycle-state.lock')):
            value = _reconcile_exited(root, _read(root), child)
        active = next((row for row in value['operations'] if row['status'] not in TERMINAL), None)
        return {'protocol': PROTOCOL, 'available': active is None, 'managed': True,
                'restart': active is None, 'quit': active is None,
                'capabilities': {'restart': active is None, 'quit': active is None},
                'actions': ['restart', 'quit'] if active is None else [],
                'instance_id': hashlib.sha256(f"{identity['installation_id']}:{child['pid']}:{child['created_at']}".encode()).hexdigest(),
                'current_url': startup_config.browser_url(settings['current_settings']),
                'next_url': startup_config.browser_url(settings['next_settings']),
                'pending': active is not None,
                'reason': 'An earlier desktop operation is still running or unconfirmed.' if active else 'Restart and Quit are available for this managed desktop process.'}
    except Exception as error:
        return {'protocol': PROTOCOL, 'available': False, 'managed': False, 'actions': [], 'pending': False,
                'restart': False, 'quit': False,
                'capabilities': {'restart': False, 'quit': False},
                'reason': str(getattr(error, 'detail', 'Desktop lifecycle is unavailable for this session.'))}


def preview(root, principal, action):
    if action not in {'restart', 'quit'}:
        H._fail('Choose Restart TLI or Quit TLI.', 422)
    root, principal = H.root_path(root), _principal(principal)
    with _lock, H.FileLock(H.path_for(root, 'lifecycle-state.lock')):
        identity, child = _current(root)
        value, now = _reconcile_exited(root, _read(root), child), time.time()
        _prune(value, now)
        if any(row['status'] not in TERMINAL for row in value['operations']):
            H._fail('A desktop operation is already running or unconfirmed. No second operation was started.')
        if len(value['previews']) >= MAX_PREVIEWS:
            H._fail('Too many pending desktop confirmations. Wait one minute.', 429)
        row = {'id': secrets.token_hex(16), 'principal': principal, 'action': action, 'at': now,
               'expires_at': now + PREVIEW_SECONDS, 'installation_id': identity['installation_id'],
               'child': child, **_settings(root)}
        value['previews'].append(row); _write(root, value)
    return {'protocol': PROTOCOL, 'preview_id': row['id'], 'action': action, 'expires_at': row['expires_at'],
            'current_url': startup_config.browser_url(row['current_settings']),
            'next_url': startup_config.browser_url(row['next_settings']),
            'consequences': ['Active chats, scans, file operations and device work may be interrupted.',
                             'TLI will request normal backend shutdown; it will not force-close unrelated programs.',
                             'The current browser tab stays open.' if action == 'restart' else 'This browser tab stays open. Use the desktop launcher to open TLI again.']}


def _signature(identity, row):
    signed = {key: row[key] for key in ('id', 'preview_id', 'principal', 'action', 'at', 'expires_at', 'installation_id', 'child', 'current_settings', 'next_settings')}
    return hmac.new(bytes.fromhex(identity['secret']), b'tli-desktop-lifecycle-v1:' +
                    json.dumps(signed, sort_keys=True, separators=(',', ':'), allow_nan=False).encode(), hashlib.sha256).hexdigest()


def confirm(root, principal, preview_id, request_id):
    root, principal = H.root_path(root), _principal(principal)
    _request(preview_id); _request(request_id)
    with _lock, H.FileLock(H.path_for(root, 'lifecycle-state.lock')):
        value, now = _read(root), time.time()
        previous = next((row for row in value['operations'] if row['id'] == request_id), None)
        if previous:
            if previous['principal'] != principal:
                H._fail('This desktop receipt is unavailable for this session.', 404)
            if previous.get('preview_id') != preview_id:
                H._fail('This request ID belongs to another desktop confirmation.')
            return _public(previous, duplicate=True)
        _prune(value, now)
        row = next((row for row in value['previews'] if row['id'] == preview_id and row['principal'] == principal), None)
        if row is None:
            H._fail('This desktop confirmation expired or is unavailable for this session. Review the action again.', 410)
        if any(item['status'] not in TERMINAL for item in value['operations']):
            H._fail('A desktop operation is already running or unconfirmed. No second operation was started.')
        identity, child = _current(root)
        if (row['installation_id'] != identity['installation_id'] or row['child'] != child
                or any(row[key] != setting for key, setting in _settings(root).items())):
            H._fail('The managed process or startup settings changed. Review the desktop action again.')
        operation = {**row, 'id': request_id, 'preview_id': preview_id, 'at': now,
                     'expires_at': now + PREVIEW_SECONDS, 'status': 'accepted', 'updated_at': now}
        operation['proof'] = _signature(identity, operation)
        value['previews'].remove(row); value['operations'].append(operation)
        _write(root, value)  # HTTP response must flush before dispatch starts a helper.
        return _public(operation)


def dispatch(root, principal, request_id):
    """Invoke only after the accepted HTTP response, with fresh authorization."""
    root, principal = H.root_path(root), _principal(principal)
    _request(request_id)
    with _lock, H.FileLock(H.path_for(root, 'lifecycle-state.lock')):
        value = _read(root)
        operation = next((row for row in value['operations'] if row['id'] == request_id and row['principal'] == principal), None)
        if operation is None:
            H._fail('This desktop receipt is unavailable for this session.', 404)
        if operation['status'] != 'accepted' or operation.get('dispatch_at') is not None:
            return _public(operation, duplicate=True)
        identity, child = _current(root)
        if (operation['child'] != child or operation['installation_id'] != identity['installation_id']
                or any(operation[key] != setting for key, setting in _settings(root).items())
                or not 0 <= time.time() - operation['at'] < PREVIEW_SECONDS):
            operation.update(status='failed', updated_at=time.time(), message='The managed process or settings changed before dispatch. No stop was requested.')
            _write(root, value)
            return _public(operation)
        operation['dispatch_at'] = time.time()
        _write(root, value)  # durable non-replayable dispatch reservation
        try:
            helper = L.spawn_fixed(root, 'host_lifecycle.py', ('--request', request_id), settings=operation['current_settings'])
            operation['helper'] = helper
            _write(root, value)
        except Exception as error:
            # Process creation may have succeeded before identity/receipt capture.
            # Block automatic retry; the helper cannot consume uncertain intent.
            operation.update(status='uncertain', message='The lifecycle helper start could not be confirmed. No automatic retry was scheduled.', updated_at=time.time())
            _write(root, value)
        return _public(operation)


def cancel_pending(root, principal, request_id):
    """Drop undispatched intent if the API's session or operation grant ended."""
    root, principal = H.root_path(root), _principal(principal)
    _request(request_id)
    with _lock, H.FileLock(H.path_for(root, 'lifecycle-state.lock')):
        value = _read(root)
        row = next((row for row in value['operations'] if row['id'] == request_id and row['principal'] == principal), None)
        if row is not None and row['status'] == 'accepted' and row.get('dispatch_at') is None:
            row.update(status='failed', updated_at=time.time(), message='The desktop session ended before dispatch. No stop was requested.')
            _write(root, value)
        return row is not None and row['status'] == 'failed'


def fail_dispatch(root, principal, request_id, message):
    """The HTTP layer's final authorization/resource guard rejected dispatch."""
    root, principal = H.root_path(root), _principal(principal)
    _request(request_id)
    with _lock, H.FileLock(H.path_for(root, 'lifecycle-state.lock')):
        value = _read(root)
        row = next((row for row in value['operations'] if row['id'] == request_id and row['principal'] == principal), None)
        if row is not None and row['status'] == 'accepted' and row.get('dispatch_at') is None:
            row.update(status='failed', updated_at=time.time(), message=str(message)[:500])
            _write(root, value)
        return row is not None and row['status'] == 'failed'


def receipt(root, principal, request_id):
    root, principal = H.root_path(root), _principal(principal)
    _request(request_id)
    with _lock, H.FileLock(H.path_for(root, 'lifecycle-state.lock')):
        row = next((row for row in _read(root)['operations'] if row['id'] == request_id and row['principal'] == principal), None)
        if row is None:
            H._fail('This desktop receipt is unavailable for this session.', 404)
        return _public(row)


def _transition(root, request_id, **fields):
    with H.FileLock(H.path_for(root, 'lifecycle-state.lock')):
        value = _read(root)
        row = next(row for row in value['operations'] if row['id'] == request_id)
        row.update(updated_at=time.time(), **fields)
        _write(root, value)


def run(root, request_id, *, wait_seconds=40, startup_seconds=300):
    """Independent worker. Only an accepted signed intent can request shutdown."""
    root = H.root_path(root); _request(request_id)
    with H.FileLock(H.path_for(root, 'lifecycle-worker.lock')):
        # Parent holds the state lease while recording our exact interpreter.
        # Wait briefly for that handoff; never race it by executing unrecorded.
        deadline = time.monotonic() + 10
        while True:
            try:
                with H.FileLock(H.path_for(root, 'lifecycle-state.lock')):
                    value = _read(root)
                    row = next((row for row in value['operations'] if row['id'] == request_id), None)
                    identity = H.installation(root)
                    if row is None or row['status'] != 'accepted' or row.get('dispatch_at') is None or not isinstance(row.get('helper'), dict):
                        return False
                    if row['helper'].get('pid') != os.getpid() or L.process_generation_state(root, row['helper']) != 'running':
                        return False
                    if (row.get('installation_id') != identity['installation_id'] or not 0 <= time.time() - row['at'] < PREVIEW_SECONDS
                            or not isinstance(row.get('proof'), str) or not hmac.compare_digest(row['proof'], _signature(identity, row))):
                        H._fail('The desktop lifecycle intent could not be verified.', 403)
                    if row['next_settings'] != startup_config.resolve(root, environ={})['effective_next']:
                        row.update(status='failed', updated_at=time.time(), message='Saved startup settings changed after confirmation. No stop was requested.')
                        _write(root, value); return False
                    if L.process_generation_state(root, row['child']) != 'running':
                        row.update(status='failed', updated_at=time.time(), message='The reviewed backend generation is unavailable. No stop or start was requested.')
                        _write(root, value); return False
                    row.update(status='stopping', updated_at=time.time(), message='Requesting normal shutdown of the reviewed backend.')
                    _write(root, value)
                break
            except H.HostControlError as error:
                if error.status != 409 or time.monotonic() >= deadline:
                    raise
                time.sleep(0.1)
        try:
            L.stop_owned_backend(root, wait_seconds=wait_seconds, expected_child=row['child'], settings=row['current_settings'])
            if L.process_generation_state(root, row['child']) != 'exited':
                H._fail('The old backend exit could not be confirmed. No restart was attempted.', 503)
            _transition(root, request_id, backend_exit_confirmed=True)
            if row['action'] == 'restart':
                if row['next_settings'] != startup_config.resolve(root, environ={})['effective_next']:
                    H._fail('TLI stopped, but saved settings changed before restart. Open the desktop launcher explicitly.', 409)
                _transition(root, request_id, status='restarting', message='The old backend exited. Waiting for the restarted backend to confirm readiness.')
                L.launch(root, open_browser=False, wait_seconds=startup_seconds, settings=row['next_settings'])
                message = 'TLI restarted and confirmed readiness. Reconnect this browser tab.'
            else:
                message = 'The reviewed TLI backend exited. This browser tab and the optional phone-start helper remain open.'
            _transition(root, request_id, status='completed', message=message)
            return True
        except Exception as error:
            _transition(root, request_id, status='failed', message=str(getattr(error, 'detail', 'The desktop operation did not complete. No automatic retry was scheduled.')))
            return False


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent  # never accept a root or command from argv/env
    try:
        return 0 if run(root, args.request) else 1
    except Exception:
        # Receipt stays active/unconfirmed if validation or the durable store
        # failed. Do not silently authorize a second process operation.
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
