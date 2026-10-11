"""Synthetic authority + real loopback TLS; never use the installed host/runtime."""
import base64
from contextlib import contextmanager, closing
from datetime import datetime, timedelta, timezone
import hashlib
import http.client
import json
from pathlib import Path
import secrets
import site
import socket
import ssl
import subprocess
import sys
import threading
import time
import venv

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa
from cryptography.hazmat.primitives import hashes
from cryptography.x509.oid import NameOID

import host_control as H
import host_launcher as L
from host_control_server import HelperServer, tls_context


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def certificate(root):
    import ipaddress
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=1))
            .not_valid_after(datetime.now(timezone.utc) + timedelta(days=2))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'), x509.IPAddress(ipaddress.ip_address('127.0.0.1')),
                                                      x509.IPAddress(ipaddress.ip_address('192.168.1.10'))]), critical=False)
            .sign(key, hashes.SHA256()))
    (root / 'data/tls').mkdir(parents=True, exist_ok=True)
    (root / 'data/tls/cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (root / 'data/tls/key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))


@pytest.fixture
def host(tmp_path):
    root = tmp_path / 'installation'; (root / 'backend').mkdir(parents=True)
    write = lambda rel, value: H.write_json(root / rel, value)
    salt, pin = 'a' * 64, '2468'
    write('data/tli_pin.json', {'salt': salt, 'hash': hashlib.pbkdf2_hmac('sha256', pin.encode(), salt.encode(), 260000).hex()})
    key = ed25519.Ed25519PrivateKey.generate()
    public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
    write('data/node_identity.json', {'version': 1, 'public_key': public,
          'private_key_enc': base64.b64encode(key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())).decode(), 'dpapi': False})
    write('data/mesh/node_config.json', {'node_id': 'node-synthetic', 'node_name': 'Synthetic host'})
    backend_port = free_port()
    write('data/startup.json', {'version': 1, 'host': '0.0.0.0', 'port': backend_port, 'https': True})
    credential = 'tlic_' + secrets.token_hex(24)
    entry = {'id': 'comp_synthetic', 'owner_id': 'local', 'credential_hash': hashlib.sha256(credential.encode()).hexdigest(), 'revoked_at': None}
    write('data/companion/credentials.json', {'version': 1, 'devices': {entry['id']: entry}, 'pairings': {}, 'preferences': {}})
    certificate(root)
    cfg = H.provision(root, free_port(), pin)
    token = H.grant(root, credential, cfg['helper_id'], cfg['node_id'])
    payload = {'request_id': 'b' * 32, 'helper_id': cfg['helper_id'], 'node_id': cfg['node_id']}
    return {'root': root, 'cfg': cfg, 'credential': credential, 'token': token, 'payload': payload, 'write': write, 'entry': entry, 'pin': pin}


@contextmanager
def listening(host, controller):
    with HelperServer(('127.0.0.1', 0), controller, tls_context(host['root'])) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True)
        thread.start()
        try:
            yield server
        finally:
            server.shutdown(); thread.join(3)


def request(host, server, method='GET', body=None, *, token=None, path=None, extra=None):
    context = ssl.create_default_context(cafile=str(host['root'] / 'data/tls/cert.pem'))
    with closing(http.client.HTTPSConnection('localhost', server.server_port, context=context, timeout=4)) as connection:
        headers = {'Authorization': 'Bearer ' + (token if token is not None else host['token']), 'Content-Type': 'application/json'}
        headers.update(extra or {})
        if path is None:
            path = (H.PREFIX + '/start') if method == 'POST' else H.PREFIX + '/status?helper_id=' + host['cfg']['helper_id'] + '&node_id=' + host['cfg']['node_id']
        connection.request(method, path, body=None if body is None else json.dumps(body), headers=headers)
        response = connection.getresponse()
        return response.status, json.loads(response.read())


def test_helper_grant_is_separate_and_revocation_and_owner_changes_are_live(host):
    root = host['root']
    assert host['token'].startswith('tlih_') and host['token'] != host['credential']
    assert H.authorize(root, host['token'])[1] == 'comp_synthetic'
    with pytest.raises(H.HostControlError) as e:
        H.authorize(root, host['credential'])
    assert e.value.status == 401
    host['entry']['revoked_at'] = '2026-09-17T12:00:00Z'
    host['write']('data/companion/credentials.json', {'version': 1, 'devices': {'comp_synthetic': host['entry']}, 'pairings': {}, 'preferences': {}})
    with pytest.raises(H.HostControlError) as e:
        H.authorize(root, host['token'])
    assert e.value.status == 401


@pytest.mark.parametrize('change', ['pin', 'tls', 'node', 'settings', 'disabled', 'root'])
def test_helper_fails_closed_when_bound_authority_changes(host, change):
    root = host['root']
    if change == 'pin': host['write']('data/tli_pin.json', {'enabled': False})
    if change == 'tls': certificate(root)
    if change == 'node': host['write']('data/mesh/node_config.json', {'node_id': 'different'})
    if change == 'settings': host['write']('data/startup.json', {'version': 1, 'host': '127.0.0.1', 'port': 8000, 'https': False})
    if change == 'disabled': host['write']('data/host_control/helper.json', {**host['cfg'], 'enabled': False})
    if change == 'root':
        value = H.installation(root); value['root'] = str(root.parent); host['write']('data/host_control/installation.json', value)
    with pytest.raises((H.HostControlError, ValueError)):
        H.authorize(root, host['token'])


def test_duplicate_is_durable_and_uncertain_spawn_is_never_replayed(host):
    launches = []
    def uncertain(*args): launches.append(1); raise OSError('Lost process result')
    controller = H.Controller(host['root'], probe=lambda *_: ('stopped', 'Not listening'), launch=uncertain)
    with pytest.raises(H.HostControlError) as e:
        controller.start(host['token'], host['payload'])
    assert e.value.status == 503
    restarted = H.Controller(host['root'], probe=lambda *_: ('stopped', 'Not listening'), launch=uncertain)
    duplicate = restarted.start(host['token'], host['payload'])
    assert duplicate['duplicate'] and not duplicate['accepted'] and not duplicate['can_start']
    assert duplicate['backend_state'] == 'unavailable'
    with pytest.raises(H.HostControlError):
        restarted.start(host['token'], {**host['payload'], 'request_id': 'c' * 32})
    assert len(launches) == 1


def test_already_running_success_is_not_replayed_after_backend_stops(host):
    controller = H.Controller(host['root'], probe=lambda *_: ('running', 'Owned proof'), launch=lambda *_: pytest.fail('No launch'))
    first = controller.start(host['token'], host['payload'])
    assert not first['accepted'] and not first['duplicate']
    restarted = H.Controller(host['root'], probe=lambda *_: ('stopped', 'Now stopped'), launch=lambda *_: pytest.fail('No replay'))
    duplicate = restarted.start(host['token'], host['payload'])
    assert duplicate['duplicate'] and not duplicate['accepted'] and not duplicate['can_start']
    assert duplicate['backend_state'] == 'stopped'


def test_exact_target_payload_and_rate_limits_precede_process_creation(host):
    launches = []
    controller = H.Controller(host['root'], probe=lambda *_: ('stopped', 'Not listening'), launch=lambda *_: launches.append(1) or {'pid': -1}, clock=lambda: 1000)
    for bad in [{**host['payload'], 'command': 'anything'}, {**host['payload'], 'node_id': 'wrong'}, {**host['payload'], 'request_id': 'bad'}]:
        with pytest.raises(H.HostControlError): controller.start(host['token'], bad)
    assert not launches
    first = controller.start(host['token'], host['payload'])
    assert first['backend_state'] == 'starting' and first['accepted']
    with pytest.raises(H.HostControlError) as e:
        controller.start(host['token'], {**host['payload'], 'request_id': 'c' * 32})
    assert e.value.status == 429 and len(launches) == 1


def test_real_tls_listener_rejects_original_credential_wrong_identity_origin_and_revoked_phone(host):
    launches = []
    controller = H.Controller(host['root'], probe=lambda *_: ('stopped', 'Not listening'), launch=lambda *_: launches.append(1) or {'pid': -1})
    with listening(host, controller) as server:
        assert request(host, server)[1]['backend_state'] == 'stopped'
        assert request(host, server, token=host['credential'])[0] == 401
        assert request(host, server, path=H.PREFIX + '/status?helper_id=wrong&node_id=node-synthetic')[0] == 409
        assert request(host, server, extra={'Origin': 'https://evil.example'})[0] == 403
        assert request(host, server, 'POST', {**host['payload'], 'path': 'elsewhere'})[0] == 422
        host['entry']['revoked_at'] = 'now'
        host['write']('data/companion/credentials.json', {'version': 1, 'devices': {'comp_synthetic': host['entry']}, 'pairings': {}, 'preferences': {}})
        assert request(host, server, 'POST', host['payload'])[0] == 401
    assert launches == []


def test_foreign_occupied_backend_is_never_reused_or_replaced(host):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    class Foreign(BaseHTTPRequestHandler):
        def do_GET(self):
            body = b'{"schema_version":1,"proof":"fake","installation_id":"fake"}'
            self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
        def log_message(self, *args): pass
    settings = {**host['cfg']['backend'], 'https': False}
    with ThreadingHTTPServer(('127.0.0.1', settings['port']), Foreign) as foreign:
        thread = threading.Thread(target=foreign.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True); thread.start()
        try:
            assert L.inspect_backend(host['root'], settings)[0] == 'unavailable'
            assert L.inspect_backend(host['root'], host['cfg']['backend'])[0] == 'unavailable', 'TLS cannot fall back to HTTP'
        finally: foreign.shutdown(); thread.join(3)


def test_real_helper_listener_starts_one_owned_fake_child_and_proves_ready(host):
    root = host['root']
    identity = H.installation(root)
    # Fixed synthetic child is a real separate process with an independent TLS
    # socket and challenge response. It imports no application or actual state.
    fake = root / 'backend/main.py'
    fake.write_text('''import hashlib,hmac,json,ssl,sys
from http.server import BaseHTTPRequestHandler,HTTPServer
from urllib.parse import parse_qs,urlsplit
from pathlib import Path
root=Path(__file__).parent.parent
identity=json.loads((root/'data/host_control/installation.json').read_text())
settings=json.loads((root/'data/startup.json').read_text())
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  challenge=parse_qs(urlsplit(self.path).query)['challenge'][0]
  message='tli-installation-v1:'+identity['installation_id']+':'+challenge
  body=json.dumps({'schema_version':1,'installation_id':identity['installation_id'],'proof':hmac.new(bytes.fromhex(identity['secret']),message.encode(),hashlib.sha256).hexdigest()}).encode()
  self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
server=HTTPServer(('127.0.0.1',settings['port']),Handler)
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(str(root/'data/tls/cert.pem'),str(root/'data/tls/key.pem'))
server.socket=context.wrap_socket(server.socket,server_side=True)
server.serve_forever()
''', encoding='utf-8')
    children = []
    def launch(*_):
        kwargs = {'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL, 'stdin': subprocess.DEVNULL}
        if sys.platform == 'win32': kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW
        # This stdlib-only fake uses the base interpreter directly so cleanup
        # terminates the exact owned process, not a Windows venv redirector.
        child = subprocess.Popen([getattr(sys, '_base_executable', sys.executable), str(fake)], **kwargs); children.append(child)
        return {'pid': child.pid, 'created_at': 0, 'script': 'main.py'}
    try:
        controller = H.Controller(root, launch=launch)
        with listening(host, controller) as server:
            status, first = request(host, server, 'POST', host['payload'])
            assert status == 202 and first['accepted'] and first['backend_state'] == 'starting', first
            assert request(host, server, 'POST', host['payload'])[1]['duplicate']
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                state = request(host, server)[1]
                if state['backend_state'] == 'running': break
                time.sleep(0.1)
            assert state['backend_state'] == 'running'
            assert len(children) == 1
            newer = {**host['payload'], 'request_id': 'c' * 32}
            status, existing = request(host, server, 'POST', newer)
            assert status == 200 and not existing['accepted'] and existing['backend_state'] == 'running'
            assert len(children) == 1
    finally:
        # Only terminate the exact child created by this isolated test.
        for child in children:
            child.terminate(); child.wait(timeout=5)


def test_foreign_tls_certificate_is_not_trusted(host):
    controller = H.Controller(host['root'], probe=lambda *_: ('stopped', 'Not listening'))
    with listening(host, controller) as server:
        with pytest.raises(ssl.SSLError):
            with closing(http.client.HTTPSConnection('localhost', server.server_port, context=ssl.create_default_context(), timeout=3)) as connection:
                connection.request('GET', H.PREFIX + '/status')
                connection.getresponse()


def test_metadata_off_by_default_and_has_no_secret_or_unrelated_origin(host, tmp_path):
    assert H.descriptor(tmp_path, '192.168.1.10')['available'] is False
    value = H.descriptor(host['root'], '192.168.1.10')
    assert value['available'] and value['capabilities']['wake_host'] is False
    assert 'secret' not in json.dumps(value) and 'credential' not in json.dumps(value)
    assert not H.descriptor(host['root'], '8.8.8.8')['available']
    assert not H.descriptor(host['root'], '192.168.1.11')['available']


def test_missing_or_corrupt_receipts_and_cross_process_lease_fail_closed(host):
    controller = H.Controller(host['root'], probe=lambda *_: ('stopped', 'Not listening'), launch=lambda *_: pytest.fail('No launch'))
    host['write']('data/host_control/requests.json', {'version': 1, 'requests': [{'phase': 'nonsense'}]})
    with pytest.raises(H.HostControlError) as e: controller.start(host['token'], host['payload'])
    assert e.value.status == 503
    with H.FileLock(H.path_for(host['root'], 'launch.lock')):
        with pytest.raises(H.HostControlError) as e: controller.start(host['token'], host['payload'])
        assert e.value.status == 409


def test_local_stop_requires_exact_owned_generation_and_signed_recent_request(host, monkeypatch):
    child = {'pid': 123456, 'created_at': 123.0, 'script': 'main.py'}
    monkeypatch.setattr(L, 'recorded_backend_children', lambda _: [child])
    monkeypatch.setattr(L, 'inspect_backend', lambda *_: ('running', 'Owned proof'))
    checks = iter([True, False])
    monkeypatch.setattr(L, 'child_alive', lambda *_: next(checks, False))
    result = L.stop_owned_backend(host['root'], wait_seconds=0)
    assert result['stopped']
    value = H.read_json(H.path_for(host['root'], 'stop-backend.json'))
    assert H.local_stop_requested(host['root'], child['pid'], child['created_at'], now=value['at'])
    assert not H.local_stop_requested(host['root'], child['pid'] + 1, child['created_at'], now=value['at'])
    assert not H.local_stop_requested(host['root'], child['pid'], child['created_at'] + 1, now=value['at'])
    assert not H.local_stop_requested(host['root'], child['pid'], child['created_at'], now=value['at'] + 61)
    tampered = {**value, 'at': value['at'] + 2}
    host['write']('data/host_control/stop-backend.json', tampered)
    assert not H.local_stop_requested(host['root'], child['pid'], child['created_at'], now=tampered['at'])
    value['proof'] = '0' * 64; host['write']('data/host_control/stop-backend.json', value)
    assert not H.local_stop_requested(host['root'], child['pid'], child['created_at'], now=value['at'])


def test_local_stop_refuses_foreign_or_unrecorded_backend(host, monkeypatch):
    monkeypatch.setattr(L, 'recorded_backend_children', lambda _: [])
    with pytest.raises(H.HostControlError): L.stop_owned_backend(host['root'], wait_seconds=0)
    child = {'pid': 123456, 'created_at': 123.0, 'script': 'main.py'}
    monkeypatch.setattr(L, 'recorded_backend_children', lambda _: [child])
    monkeypatch.setattr(L, 'inspect_backend', lambda *_: ('unavailable', 'Unrelated port'))
    with pytest.raises(H.HostControlError): L.stop_owned_backend(host['root'], wait_seconds=0)
    assert not H.path_for(host['root'], 'stop-backend.json').exists()


def test_main_grant_is_explicit_original_https_and_only_for_paired_phone(host, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.host_control_routes import router
    from routers.system_routes import require_session
    import tli_state as S
    monkeypatch.setattr(S, 'BASE_DIR', str(host['root']))
    monkeypatch.setattr(S, 'TLS_ENABLED', True)
    app = FastAPI(); app.include_router(router); app.dependency_overrides[require_session] = lambda: 'local'
    body = {key: host['payload'][key] for key in ('helper_id', 'node_id')}
    with TestClient(app, base_url='https://192.168.1.10') as client:
        initial = client.get('/api/host-control/v1/setup').json()
        assert initial['host_control']['available'] and 'credential' not in initial
        assert client.post('/api/host-control/v1/grant', json=body).status_code == 401
        result = client.post('/api/host-control/v1/grant', json=body, headers={'Authorization': 'Bearer ' + host['credential']})
        assert result.status_code == 200 and result.json()['credential'] == host['token']
        assert client.post('/api/host-control/v1/grant', json={**body, 'helper_id': '0' * 32}, headers={'Authorization': 'Bearer ' + host['credential']}).status_code == 409
        assert client.post('/api/host-control/v1/start', json=host['payload']).status_code == 404
    with TestClient(app, base_url='http://192.168.1.10') as client:
        assert client.post('/api/host-control/v1/grant', json=body, headers={'Authorization': 'Bearer ' + host['credential']}).status_code == 403


@pytest.mark.parametrize('managed', [None, 'different-installation'])
def test_stop_monitor_does_not_attach_to_unmanaged_or_other_installation(host, monkeypatch, managed):
    import asyncio
    from routers import host_control_routes as routes
    monkeypatch.setattr(routes.S, 'BASE_DIR', str(host['root']))
    monkeypatch.setattr(routes, '_shutdown_task', None)
    if managed is None: monkeypatch.delenv('TLI_MANAGED_CHILD', raising=False)
    else: monkeypatch.setenv('TLI_MANAGED_CHILD', managed)
    monkeypatch.setattr(routes.asyncio, 'create_task', lambda *_: pytest.fail('No monitor for an unowned process'))
    asyncio.run(routes.start_local_stop_monitor())
    assert routes._shutdown_task is None


def test_ledger_capacity_is_bounded_without_discarding_replay_history(host):
    rows = [{'request_id': format(i, '032x'), 'at': 0, 'phase': 'accepted', 'device_id': 'old'} for i in range(512)]
    host['write']('data/host_control/requests.json', {'version': 1, 'requests': rows})
    controller = H.Controller(host['root'], probe=lambda *_: ('stopped', 'Not listening'), launch=lambda *_: pytest.fail('Capacity must fail before launch'), clock=lambda: 10000)
    with pytest.raises(H.HostControlError) as error: controller.start(host['token'], host['payload'])
    assert error.value.status == 503
    assert len(H.read_json(H.path_for(host['root'], 'requests.json'))['requests']) == 512


def test_strict_json_rejects_duplicate_fields_and_nonfinite_numbers():
    for raw in ['{"request_id":"one","request_id":"two"}', '{"at":NaN}', '{"at":Infinity}']:
        with pytest.raises(ValueError): H.decode_json(raw)


def test_concurrent_first_setup_and_launch_cannot_replace_installation_identity(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    root = tmp_path / 'new-installation'; root.mkdir()
    barrier, local = threading.Barrier(2), threading.local()
    original = H.read_json
    def synchronized_read(path, limit=1024 * 1024):
        try:
            return original(path, limit)
        except FileNotFoundError:
            if Path(path).name == 'installation.json' and not getattr(local, 'first_seen', False):
                local.first_seen = True
                barrier.wait(timeout=3)
            raise
    monkeypatch.setattr(H, 'read_json', synchronized_read)
    def create():
        try: return H.installation(root, create=True)
        except H.HostControlError as error:
            assert error.status == 409
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        values = list(pool.map(lambda _: create(), range(2)))
    successful = [value for value in values if value]
    assert successful
    final = H.installation(root)
    assert all(value == final for value in successful)


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows venv redirector and hidden process lifecycle')
@pytest.mark.parametrize('record_source', ['desktop', 'helper'])
def test_windows_hidden_launcher_records_real_interpreter_and_gracefully_stops_owned_child(host, record_source):
    root = host['root']
    # Build actual redirectors/configuration whether pytest itself runs under
    # a base interpreter (as in CI) or an existing virtual environment.
    venv.EnvBuilder(with_pip=False).create(root / 'backend/.venv')
    # The isolated redirector resolves test dependencies read-only from the
    # existing environment; no dependency installs or real app import occur.
    source_root = str(Path(__file__).resolve().parents[1])
    dependencies = site.getsitepackages()
    fake = root / 'backend/main.py'
    fake.write_text('''import sys,site,json
from pathlib import Path
for dependency in %r: site.addsitedir(dependency)
sys.path.insert(0,%r)
from fastapi import FastAPI
from routers.host_control_routes import router
import tli_state as S
import uvicorn
root=Path(__file__).parent.parent
settings=json.loads((root/'data/startup.json').read_text())
S.TLS_ENABLED=True
app=FastAPI();app.include_router(router)
@app.on_event('shutdown')
async def finished(): (root/'graceful-shutdown.txt').write_text('lifespan complete')
uvicorn.run(app,host='127.0.0.1',port=settings['port'],ssl_certfile=str(root/'data/tls/cert.pem'),ssl_keyfile=str(root/'data/tls/key.pem'),log_level='warning',timeout_graceful_shutdown=3)
''' % (dependencies, source_root), encoding='utf-8')
    child = None
    try:
        child = L.spawn_fixed(root, 'main.py', settings=host['cfg']['backend'])
        assert L.child_alive(root, child)
        assert L.pending_backend(root)
        if record_source == 'desktop':
            host['write']('data/host_control/desktop-child.json', child)
        else:
            host['write']('data/host_control/requests.json', {'version': 1, 'requests': [{**host['payload'], 'phase': 'accepted', 'at': time.time(), 'device_id': 'comp_synthetic', 'child': child}]})
        deadline = time.monotonic() + 15
        state = None
        while time.monotonic() < deadline:
            state = L.inspect_backend(root, host['cfg']['backend'])[0]
            if state == 'running': break
            time.sleep(0.1)
        assert state == 'running', (root / 'data/host_control/backend.log').read_text(encoding='utf-8', errors='replace')
        result = L.stop_owned_backend(root, wait_seconds=10)
        assert result['stopped'] and not L.child_alive(root, child)
        assert (root / 'graceful-shutdown.txt').read_text() == 'lifespan complete'
    finally:
        if child and L.child_alive(root, child):
            import psutil
            process = psutil.Process(child['pid'])
            process.terminate(); process.wait(timeout=5)  # only this test-created exact generation
