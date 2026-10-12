"""Reviewed local network preparation. Never mutates configuration on a read.

The HTTP boundary is local owner-only. The elevated helper accepts only a signed,
expiring, fixed-installation firewall request; it never imports application code.
Receipts contain no session, PIN, private key, or device credentials.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time

import host_control as H
import startup_config
import tls_cert
from process_utils import hidden_process_kwargs

TTL = 300
MAX_BYTES = 512 * 1024
MAX_PREVIEWS = 8
MAX_RECEIPTS = 64
INSTANCE = secrets.token_hex(16)
LOCK = threading.RLock()
ACTIONS = {'prepare', 'firewall', 'repair_certificate'}


def _id(value):
    if not isinstance(value, str) or not H.REQUEST.fullmatch(value):
        H._fail('A hexadecimal setup receipt ID is required.', 422)
    return value


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def _sign(identity, row):
    return hmac.new(bytes.fromhex(identity['secret']), _canonical(row), hashlib.sha256).hexdigest()


def _file(root, relative):
    root = H.root_path(root)
    path = root / relative
    if not path.is_relative_to(root):
        H._fail('The setup path is outside this installation.')
    for part in [path, *path.parents]:
        if part == root.parent:
            break
        if part.is_symlink() or part.exists() and getattr(part.lstat(), 'st_file_attributes', 0) & 0x400:
            H._fail('Linked network setup files are not supported.')
    return path


def _digest(path):
    try:
        if path.stat().st_size > 1024 * 1024:
            H._fail('A setup authority file is unexpectedly large.')
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


def _snapshot(root):
    return {name: _digest(_file(root, name)) for name in
            ('data/startup.json', 'data/tls/cert.pem', 'data/tls/key.pem', 'data/tli_pin.json', 'TLI_Network_Setup.ps1')}


def _read(root):
    try:
        state = H.read_json(H.path_for(root, 'network_setup.json'), MAX_BYTES)
    except FileNotFoundError:
        return {'version': 1, 'previews': [], 'receipts': []}
    if (not isinstance(state, dict) or set(state) != {'version', 'previews', 'receipts'} or state['version'] != 1
            or not isinstance(state['previews'], list) or len(state['previews']) > MAX_PREVIEWS
            or not isinstance(state['receipts'], list) or len(state['receipts']) > MAX_RECEIPTS):
        H._fail('Setup receipts are unreadable. Nothing was replayed.', 503)
    identity = H.installation(root)
    for row in state['previews'] + state['receipts']:
        if (not isinstance(row, dict) or row.get('action') not in ACTIONS
                or not H.REQUEST.fullmatch(str(row.get('id', '')))
                or not hmac.compare_digest(str(row.get('signature', '')), _sign(identity, {k: v for k, v in row.items() if k != 'signature'}))):
            H._fail('Setup receipt integrity could not be verified. Nothing was replayed.', 503)
    for key in ('previews', 'receipts'):
        if len({row['id'] for row in state[key]}) != len(state[key]):
            H._fail('Setup receipt IDs are ambiguous.', 503)
    return state


def _write(root, state):
    identity = H.installation(root)
    for row in state['previews'] + state['receipts']:
        row.pop('signature', None)
        row['signature'] = _sign(identity, row)
    if len(_canonical(state)) > MAX_BYTES:
        H._fail('The bounded setup receipt store is full.', 503)
    H.write_json(H.path_for(root, 'network_setup.json'), state)


def _stage_paths(root, ident):
    _id(ident)
    return tuple(H.path_for(root, f'network-stage-{ident}-{part}.pem') for part in ('cert', 'key'))


def _prune(root, state):
    expired = [row for row in state['previews'] if row['expires_at'] <= time.time()]
    state['previews'] = [row for row in state['previews'] if row not in expired]
    referenced = {row.get('preview_id') for row in state['receipts'] if row['status'] in {'accepted', 'applying', 'uncertain'}}
    for row in expired:
        if row['id'] not in referenced:
            for path in _stage_paths(root, row['id']):
                path.unlink(missing_ok=True)
    while len(state['receipts']) >= MAX_RECEIPTS:
        removable = next((row for row in state['receipts'] if row['status'] in {'completed', 'failed'}), None)
        if not removable:
            H._fail('Unconfirmed setup receipts require local review before another operation.')
        state['receipts'].remove(removable)
        for path in _stage_paths(root, removable['preview_id']):
            path.unlink(missing_ok=True)
        for suffix in ('request.json', 'result.json', 'claim', 'launch', 'decision'):
            H.path_for(root, f'network-firewall-{removable["id"]}-{suffix}').unlink(missing_ok=True)


def certificate_status(root, paths=None):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    from cryptography.x509.oid import ExtendedKeyUsageOID
    cert_path, key_path = paths or (_file(root, 'data/tls/cert.pem'), _file(root, 'data/tls/key.pem'))
    result = {'status': 'missing', 'fingerprint': None, 'names': [], 'reason': 'A certificate will be created only after you confirm secure network preparation.'}
    if not cert_path.exists() and not key_path.exists():
        return result
    result['status'] = 'repair_required'
    try:
        _digest(cert_path); _digest(key_path)  # Bound both reads before parsing.
        # Public fingerprint is useful even if the old private key is missing.
        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
        result['fingerprint'] = cert.fingerprint(hashes.SHA256()).hex()
        names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        result['names'] = sorted([*names.get_values_for_type(x509.DNSName), *map(str, names.get_values_for_type(x509.IPAddress))])
        cert = tls_cert.validate_tls_certificate(str(cert_path), str(key_path))
        hostname = socket.gethostname().rstrip('.').lower()
        stable = hostname if hostname.endswith('.local') else hostname + '.local'
        for name in ('localhost', stable):
            tls_cert.certificate_bundle(str(cert_path), str(key_path), name)
        if cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
            raise ValueError('A dedicated server certificate is required.')
        if ExtendedKeyUsageOID.SERVER_AUTH not in cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value:
            raise ValueError('The certificate must explicitly permit TLS server authentication.')
        result.update(status='ready', reason='Existing certificate and stable local hostname are valid.')
    except Exception as error:
        result['reason'] = str(error) if isinstance(error, ValueError) else 'The existing certificate needs an explicit local repair review for its key, validity, names or server constraints.'
    return result


def _powershell():
    return Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'


def _program():
    # Windows venv launchers may redirect to a different process image. Firewall
    # application filters must bind the running image, not its launcher stub.
    import psutil
    return str(Path(psutil.Process(os.getpid()).exe()).resolve())


def inspect_firewall(root):
    base = {'supported': os.name == 'nt', 'status': 'unsupported', 'reason': 'Automatic firewall setup is available on Windows only.', 'profiles': [], 'legacy_rules': []}
    if not base['supported']:
        return base
    try:
        script = _file(root, 'TLI_Network_Setup.ps1')
        if not script.is_file():
            raise ValueError('The fixed Windows network setup helper is missing.')
        result = subprocess.run([str(_powershell()), '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                                 '-File', str(script), '-Action', 'Inspect'], capture_output=True, timeout=12,
                                **hidden_process_kwargs())
        if result.returncode or len(result.stdout) > 65536:
            raise ValueError('Windows firewall policy could not be inspected. No rule was changed.')
        value = H.decode_json(result.stdout.decode('utf-8-sig'))
        if not isinstance(value, dict) or value.get('status') not in {'ready', 'public_network', 'managed_policy', 'unavailable'}:
            raise ValueError('Windows returned an unsupported firewall inspection result.')
        return {**base, **value, 'supported': True}
    except Exception as error:
        return {**base, 'status': 'unavailable', 'reason': str(error)}


def status(root, running):
    root = H.root_path(root)
    try:
        identity = H.installation(root)['installation_id']
    except H.HostControlError:
        identity = None
    return {'schema_version': 1, 'installation_id': identity, 'running': running,
            'startup': startup_config.resolve(root), 'certificate': certificate_status(root), 'firewall': inspect_firewall(root),
            'manual_restart': os.environ.get('TLI_MANAGED_CHILD') != identity or not identity}


def _public(row):
    fields = ('action', 'installation_id', 'settings', 'next_url', 'certificate', 'firewall', 'warnings', 'expires_at')
    result = {key: row[key] for key in fields}
    if 'status' in row:
        result.update(request_id=row['id'], status=row['status'], message=row['message'], restart_required=row['action'] != 'firewall' and row['status'] == 'completed')
    else:
        result['preview_id'] = row['id']
    return {'schema_version': 1, **result}


def preview(root, principal, action, *, port=None, migrate_legacy=False, running=None):
    if action not in ACTIONS or type(migrate_legacy) is not bool:
        H._fail('Unsupported setup action.', 422)
    if action != 'prepare' and port is not None or action != 'firewall' and migrate_legacy:
        H._fail('These options do not belong to the selected setup action.', 422)
    root = H.root_path(root)
    with LOCK, H.FileLock(H.path_for(root, 'network_setup.lock')), startup_config.LOCK:
        identity = H.installation(root, create=True)
        H.pin_generation(root)  # independently require an existing enabled owner PIN
        state = _read(root)
        if _reconcile(root, state):
            _write(root, state)
        _prune(root, state)
        if any(row['status'] in {'accepted', 'applying', 'uncertain'} for row in state['receipts']):
            H._fail('An earlier setup action is unconfirmed. Inspect its receipt; it will not be repeated.')
        if len(state['previews']) >= MAX_PREVIEWS:
            H._fail('Too many setup previews are pending. Wait for their five-minute expiry.')
        settings = startup_config.resolve(root, environ={})['effective_next']
        if action == 'prepare':
            settings = startup_config.validate({'host': '0.0.0.0', 'port': settings['port'] if port is None else port, 'https': True}, saved=True)
        certificate, firewall = certificate_status(root), inspect_firewall(root)
        warnings = []
        if action == 'prepare' and certificate['status'] == 'repair_required':
            H._fail('The existing HTTPS certificate requires its separate repair review before secure network preparation.')
        if action == 'firewall':
            if not firewall['supported'] or firewall['status'] != 'ready':
                H._fail(firewall['reason'])
            if not settings['https'] or settings['host'] != '0.0.0.0' or certificate['status'] != 'ready':
                H._fail('Prepare secure LAN settings and a valid certificate before reviewing firewall access.')
            if firewall['legacy_rules'] and not migrate_legacy:
                warnings.append('Earlier broad TLI firewall rules remain. Review their explicit migration to make network access restricted.')
            firewall = {**firewall, 'program': _program(), 'profile': 'Private', 'remote_addresses': 'LocalSubnet',
                        'rules': [{'protocol': 'TCP', 'port': settings['port']}, {'protocol': 'UDP', 'port': 5353}, {'protocol': 'UDP', 'port': 47474}],
                        'migrate_legacy': migrate_legacy}
        ident = secrets.token_hex(16)
        row = {'id': ident, 'action': action, 'principal': hashlib.sha256(principal.encode()).hexdigest(), 'instance': INSTANCE,
               'installation_id': identity['installation_id'], 'at': time.time(), 'expires_at': time.time() + TTL,
               'settings': settings, 'next_url': startup_config.browser_url(settings), 'snapshot': _snapshot(root),
               'certificate': certificate, 'firewall': firewall, 'warnings': warnings}
        if action == 'repair_certificate' or action == 'prepare' and certificate['status'] == 'missing':
            if action == 'repair_certificate':
                if certificate['status'] == 'missing':
                    H._fail('No certificate exists. Use secure network preparation to create the first certificate.')
                backups = H.path_for(root, 'unused').parent.glob('network-backup-*.pem')
                if len({path.name.rsplit('-', 1)[0] for path in backups}) >= 8:
                    H._fail('Eight certificate recovery copies are already retained. Review them locally before another repair.')
                warnings.append('Replacing this certificate changes its fingerprint. Existing phones, trusted peers and the phone-start helper must be reviewed and paired or enabled again. Node identity is preserved.')
            paths = _stage_paths(root, ident)
            if not tls_cert.ensure_tls_cert(*map(str, paths)):
                for path in paths: path.unlink(missing_ok=True)
                H._fail('A new certificate could not be staged. Existing TLS files were preserved.')
            staged = certificate_status(root, paths)
            if staged['status'] != 'ready':
                for path in paths: path.unlink(missing_ok=True)
                H._fail('The staged certificate did not pass hostname and server checks.')
            row['certificate'] = {**staged, 'previous_fingerprint': certificate['fingerprint'], 'replacement': action == 'repair_certificate'}
            row['stage_hashes'] = [_digest(path) for path in paths]
        if action == 'prepare':
            warnings.extend(['TLI will accept encrypted connections on this computer’s network interfaces after a reviewed restart.',
                             'Windows firewall access is a separate review. No router ports or public-network rules are opened.'])
            if startup_config.resolve(root)['environment_overrides']:
                warnings.append('This process has startup environment overrides. The managed launcher uses the saved reviewed settings; a manually launched Python process must have its overrides reviewed before restarting.')
        state['previews'].append(row)
        _write(root, state)
        return _public(row)


def confirm(root, principal, preview_id, request_id):
    _id(preview_id); _id(request_id)
    with LOCK, H.FileLock(H.path_for(root, 'network_setup.lock')):
        state = _read(root)
        principal_hash = hashlib.sha256(principal.encode()).hexdigest()
        duplicate = next((row for row in state['receipts'] if row['id'] == request_id), None)
        if duplicate:
            if duplicate['preview_id'] != preview_id or duplicate['principal'] != principal_hash:
                H._fail('This request ID belongs to another reviewed action.')
            return {**_public(duplicate), 'duplicate': True}
        row = next((row for row in state['previews'] if row['id'] == preview_id), None)
        if (not row or row['principal'] != principal_hash or row['instance'] != INSTANCE or row['expires_at'] <= time.time()
                or row['snapshot'] != _snapshot(root)):
            H._fail('Setup preview expired or its session, settings or certificate changed. Review a new preview.')
        if any(item['status'] in {'accepted', 'applying', 'uncertain'} for item in state['receipts']):
            H._fail('Another setup action is already accepted. It will not be replayed.')
        _prune(root, state)
        accepted = {**row, 'id': request_id, 'preview_id': preview_id, 'status': 'accepted', 'message': 'Setup was accepted. Check this receipt for the result.'}
        state['receipts'].append(accepted)
        state['previews'].remove(row)
        _write(root, state)
        return _public(accepted)


def _install_certificate(root, row):
    sources = _stage_paths(root, row['preview_id'])
    if [_digest(path) for path in sources] != row['stage_hashes'] or certificate_status(root, sources)['status'] != 'ready':
        H._fail('Staged TLS files changed. Existing files were preserved.')
    destinations = (_file(root, 'data/tls/cert.pem'), _file(root, 'data/tls/key.pem'))
    originals = [path.read_bytes() if path.exists() else None for path in destinations]
    for name, contents in zip(('cert', 'key'), originals):
        if contents is not None:
            path = H.path_for(root, f'network-backup-{row["id"]}-{name}.pem')
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(contents); stream.flush(); os.fsync(stream.fileno())
    # Each file is replaced atomically. A process/power loss between the pair
    # fails closed at TLS startup; the complete original pair remains recoverable.
    try:
        for source, destination in zip(sources, destinations):
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, destination)
        if certificate_status(root)['status'] != 'ready':
            H._fail('The new TLS pair did not validate.')
    except Exception as error:
        recovered = True
        for index, (destination, original) in enumerate(zip(destinations, originals)):
            try:
                expected_original = hashlib.sha256(original).hexdigest() if original is not None else None
                if _digest(destination) not in {expected_original, row['stage_hashes'][index]}:
                    raise ValueError('TLS file changed independently during recovery')
                if original is None:
                    destination.unlink(missing_ok=True)
                elif _digest(destination) != expected_original:
                    temporary = H.path_for(root, f'network-restore-{row["id"]}-{index}.pem')
                    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, 'wb') as stream:
                        stream.write(original); stream.flush(); os.fsync(stream.fileno())
                    os.replace(temporary, destination)
            except Exception:
                recovered = False
        H._fail('Certificate replacement failed. The original TLS files were restored; no restart was requested.' if recovered
                else 'Certificate replacement failed and automatic recovery could not be verified. Restore the retained original pair locally before restarting.')


def _firewall_request(root, row):
    # Cross-language signature covers exact ASCII payload bytes, not differing
    # Python/PowerShell JSON serializers. No private material enters this payload.
    import base64
    identity = H.installation(root)
    payload = {'version': 1, 'request_id': row['id'], 'installation_id': identity['installation_id'],
               'expires_at': int(row['expires_at']), 'program': row['firewall']['program'], 'port': row['settings']['port'],
               'snapshot': row['snapshot'], 'legacy_rules': row['firewall']['legacy_rules'] if row['firewall']['migrate_legacy'] else []}
    raw = _canonical(payload)
    value = {'payload': base64.b64encode(raw).decode('ascii'),
             'signature': hmac.new(bytes.fromhex(identity['secret']), raw, hashlib.sha256).hexdigest()}
    H.write_json(H.path_for(root, f'network-firewall-{row["id"]}-request.json'), value)
    subprocess.Popen([str(_powershell()), '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                      '-File', str(_file(root, 'TLI_Network_Setup.ps1')), '-Action', 'Request', '-RequestId', row['id']],
                     cwd=str(H.root_path(root)), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     **hidden_process_kwargs())


def dispatch(root, principal, request_id, check=lambda: None):
    _id(request_id)
    with LOCK, H.FileLock(H.path_for(root, 'network_setup.lock')), startup_config.LOCK:
        state = _read(root)
        row = next((row for row in state['receipts'] if row['id'] == request_id), None)
        if not row or row['principal'] != hashlib.sha256(principal.encode()).hexdigest():
            H._fail('Setup action does not belong to this session.', 403)
        if row['status'] != 'accepted':
            return _public(row)
        try:
            check()
            if row['instance'] != INSTANCE or row['expires_at'] <= time.time() or row['snapshot'] != _snapshot(root):
                H._fail('Setup authority or reviewed settings changed before the action started.')
            row.update(status='applying', message='Applying the reviewed setup action. Do not submit it again.')
            _write(root, state)  # Durable no-replay boundary precedes every mutation.
            if row['action'] == 'firewall':
                current = inspect_firewall(root)
                if current['status'] != 'ready' or current['legacy_rules'] != row['firewall']['legacy_rules']:
                    H._fail('Windows network policy or existing rules changed. Review firewall access again.')
                _firewall_request(root, row)
                row['message'] = 'Review the Windows administrator prompt. Its result will appear here; the request will not be repeated.'
            else:
                if row.get('stage_hashes'):
                    _install_certificate(root, row)
                if row['action'] == 'prepare':
                    startup_config.write(row['settings'], root)
                row.update(status='completed', message='Secure startup settings are saved. Review Restart TLI to activate them.' if row['action'] == 'prepare' else 'The reviewed certificate is installed and the original material is retained for recovery. Restart TLI, then review affected connections.')
        except Exception as error:
            row.update(status='failed', message=getattr(error, 'detail', 'Setup did not complete. Inspect the saved configuration before retrying; no automatic retry occurred.'))
        _write(root, state)
        return _public(row)


def _signed_helper_value(root, path, limit=8192):
    import base64
    envelope = H.read_json(path, limit)
    if set(envelope) != {'payload', 'signature'}:
        raise ValueError('Invalid helper envelope')
    raw = base64.b64decode(envelope['payload'], validate=True)
    expected = hmac.new(bytes.fromhex(H.installation(root)['secret']), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, envelope['signature']):
        raise ValueError('Invalid helper signature')
    return H.decode_json(raw)


def _firewall_exited(root, row):
    """Expired intent with no authorizing claim cannot begin a later mutation.

    A completed claim identifies the elevated process generation. A live or
    inaccessible generation stays blocked even after expiry; a slow cmdlet may
    have started before its deadline. Reads never cancel or repeat a command.
    """
    import psutil
    path = H.path_for(root, f'network-firewall-{row["id"]}-claim')
    try:
        if not path.exists() or path.stat().st_size == 0:
            return True  # helper must validate its fully written claim + deadline
        claim = _signed_helper_value(root, path)
        if (set(claim) != {'request_id', 'pid', 'created_at'} or claim['request_id'] != row['id']
                or type(claim['pid']) is not int or claim['pid'] <= 0 or type(claim['created_at']) not in (int, float)):
            return False
        process = psutil.Process(claim['pid'])
        return abs(process.create_time() - claim['created_at']) > 0.05
    except psutil.NoSuchProcess:
        return True
    except Exception:
        return False


def _reconcile(root, state):
    changed = False
    for row in state['receipts']:
        if row['status'] not in {'accepted', 'applying', 'uncertain'}:
            continue
        if row['action'] != 'firewall':
            if row['instance'] != INSTANCE or row['expires_at'] <= time.time():
                row.update(status='failed', message='The earlier process did not finish this setup action. Inspect the current settings and certificate, then review a new action if needed. Nothing was replayed.')
                changed = True
            continue
        try:
            result = _signed_helper_value(root, H.path_for(root, f'network-firewall-{row["id"]}-result.json'))
            if (set(result) != {'request_id', 'status', 'message'} or result.get('request_id') != row['id']
                    or result.get('status') not in {'completed', 'failed'} or not isinstance(result.get('message'), str)
                    or len(result['message']) > 2048):
                raise ValueError('Invalid helper result')
            row.update(status=result['status'], message=result['message'])
            changed = True
        except FileNotFoundError:
            if row['expires_at'] <= time.time():
                if _firewall_exited(root, row):
                    row.update(status='failed', message='The reviewed firewall request expired without a final result and its elevated mutation process is no longer active. Inspect current rules and review a new action if needed; nothing was repeated.')
                else:
                    row.update(status='uncertain', message='The elevated firewall operation is still running or its process cannot be verified. Wait for Windows to finish or cancel its prompt, then check again; nothing will be repeated.')
                changed = True
        except Exception:
            if row['expires_at'] <= time.time() and _firewall_exited(root, row):
                row.update(status='failed', message='The helper result could not be verified, but the expired mutation process is no longer active. Review current Windows rules before a new action; no success or retry was assumed.')
            else:
                row.update(status='uncertain', message='The Windows helper result could not be verified. Review locally; nothing was repeated.')
            changed = True
    return changed


def receipt(root, request_id):
    _id(request_id)
    with LOCK, H.FileLock(H.path_for(root, 'network_setup.lock')):
        state = _read(root)
        row = next((row for row in state['receipts'] if row['id'] == request_id), None)
        if not row:
            H._fail('This setup receipt was not found in this installation.', 404)
        if row['installation_id'] != H.installation(root)['installation_id']:
            H._fail('Setup receipt belongs to another installation.', 403)
        if _reconcile(root, state):
            _write(root, state)
        return _public(row)
