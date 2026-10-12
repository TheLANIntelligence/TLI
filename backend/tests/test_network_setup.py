"""Synthetic installations only: never inspect/apply the real Windows firewall."""
import copy
import base64
import hashlib
import hmac
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import host_control as H
import network_setup as N
import startup_config


@pytest.fixture
def setup(tmp_path, monkeypatch):
    root = tmp_path / 'installation'
    root.mkdir()
    (root / 'TLI_Network_Setup.ps1').write_text('# test helper only')
    H.installation(root, create=True)
    H.write_json(root / 'data/tli_pin.json', {'hash': 'a' * 64, 'salt': 'b' * 64})
    firewall = {'supported': True, 'status': 'ready', 'reason': 'Private network', 'profiles': ['Private'], 'legacy_rules': []}
    calls = []
    monkeypatch.setattr(N, 'inspect_firewall', lambda _: copy.deepcopy(firewall))
    monkeypatch.setattr(N, '_firewall_request', lambda root, row: calls.append(copy.deepcopy(row)))
    monkeypatch.setattr(N.tls_cert, '_local_ipv4_addresses', lambda: ['192.168.5.20'])
    monkeypatch.setattr(N.socket, 'gethostname', lambda: 'test-host')
    monkeypatch.setattr(N.subprocess, 'Popen', lambda *a, **k: pytest.fail('Real subprocess is forbidden'))
    monkeypatch.setattr(N.subprocess, 'run', lambda *a, **k: pytest.fail('Real subprocess is forbidden'))
    return SimpleNamespace(root=root, firewall=firewall, calls=calls)


def perform(setup, action='prepare', **kwargs):
    preview = N.preview(setup.root, 'session-one', action, **kwargs)
    ident = hashlib.sha256(preview['preview_id'].encode()).hexdigest()[:32]
    N.confirm(setup.root, 'session-one', preview['preview_id'], ident)
    result = N.dispatch(setup.root, 'session-one', ident)
    return preview, ident, result


def helper_result(setup, ident, result):
    raw = json.dumps(result).encode()
    signature = hmac.new(bytes.fromhex(H.installation(setup.root)['secret']), raw, hashlib.sha256).hexdigest()
    H.write_json(H.path_for(setup.root, f'network-firewall-{ident}-result.json'), {'payload': base64.b64encode(raw).decode(), 'signature': signature})


def test_read_only_status_never_creates_identity_tls_or_startup(setup):
    (setup.root / 'data/host_control/installation.json').unlink()
    result = N.status(setup.root, {'host': '127.0.0.1', 'port': 8000, 'https': False})
    assert result['certificate']['status'] == 'missing'
    assert result['installation_id'] is None and result['manual_restart']
    assert not (setup.root / 'data/tls').exists()
    assert not (setup.root / 'data/startup.json').exists()
    assert not (setup.root / 'data/host_control/installation.json').exists()


def test_prepare_is_staged_review_then_once_only_commit(setup):
    preview = N.preview(setup.root, 'session-one', 'prepare', port=8443)
    assert preview['settings'] == {'host': '0.0.0.0', 'port': 8443, 'https': True}
    assert preview['next_url'] == 'https://localhost:8443'
    assert preview['certificate']['status'] == 'ready'
    assert not (setup.root / 'data/tls').exists()
    assert not (setup.root / 'data/startup.json').exists()
    accepted = N.confirm(setup.root, 'session-one', preview['preview_id'], 'a' * 32)
    assert accepted['status'] == 'accepted' and not (setup.root / 'data/tls').exists()
    assert N.confirm(setup.root, 'session-one', preview['preview_id'], 'a' * 32)['duplicate']
    result = N.dispatch(setup.root, 'session-one', 'a' * 32)
    assert result['status'] == 'completed'
    cert_bytes = (setup.root / 'data/tls/cert.pem').read_bytes()
    assert startup_config.read(setup.root)[0] == preview['settings']
    assert N.dispatch(setup.root, 'session-one', 'a' * 32)['status'] == 'completed'
    assert (setup.root / 'data/tls/cert.pem').read_bytes() == cert_bytes
    assert not setup.calls


@pytest.mark.parametrize('change', ['session', 'expiry', 'settings', 'pin', 'helper', 'instance'])
def test_confirmation_rejects_changed_review(setup, monkeypatch, change):
    preview = N.preview(setup.root, 'session-one', 'prepare')
    session = 'session-one'
    if change == 'session': session = 'session-two'
    elif change == 'expiry': monkeypatch.setattr(N.time, 'time', lambda: preview['expires_at'] + 1)
    elif change == 'settings': startup_config.write({'host': '127.0.0.1', 'port': 9000, 'https': False}, setup.root)
    elif change == 'pin': (setup.root / 'data/tli_pin.json').write_text('{}')
    elif change == 'helper': (setup.root / 'TLI_Network_Setup.ps1').write_text('# modified')
    elif change == 'instance': monkeypatch.setattr(N, 'INSTANCE', 'new-process')
    with pytest.raises(H.HostControlError):
        N.confirm(setup.root, session, preview['preview_id'], 'a' * 32)
    assert not (setup.root / 'data/tls').exists() and not setup.calls


def test_revocation_at_dispatch_preserves_original_files(setup):
    preview = N.preview(setup.root, 'session-one', 'prepare')
    N.confirm(setup.root, 'session-one', preview['preview_id'], 'a' * 32)
    def revoked(): H._fail('PIN session revoked.', 401)
    result = N.dispatch(setup.root, 'session-one', 'a' * 32, revoked)
    assert result['status'] == 'failed' and not (setup.root / 'data/tls').exists()
    assert N.dispatch(setup.root, 'session-one', 'a' * 32)['status'] == 'failed'


def test_fresh_owner_can_resume_receipt_but_cannot_replay_old_confirmation(setup, monkeypatch):
    _, ident, result = perform(setup)
    monkeypatch.setattr(N, 'INSTANCE', 'new-process')
    resumed = N.receipt(setup.root, ident)
    assert resumed['status'] == result['status'] == 'completed'
    assert resumed['installation_id'] == H.installation(setup.root)['installation_id']
    encoded = json.dumps(resumed)
    assert not any(secret in encoded for secret in ('session-one', 'private_key', 'secret', 'principal', 'snapshot'))


def test_abandoned_accepted_operation_is_failed_and_fresh_review_allowed_without_replay(setup, monkeypatch):
    preview = N.preview(setup.root, 'session-one', 'prepare')
    N.confirm(setup.root, 'session-one', preview['preview_id'], 'a' * 32)
    monkeypatch.setattr(N, 'INSTANCE', 'new-process')
    assert N.receipt(setup.root, 'a' * 32)['status'] == 'failed'
    assert N.dispatch(setup.root, 'session-one', 'a' * 32)['status'] == 'failed'
    assert not (setup.root / 'data/tls').exists()
    assert N.preview(setup.root, 'new-session', 'prepare')['preview_id']


def test_existing_certificate_is_preserved_until_separate_repair(setup):
    _, _, _ = perform(setup)
    original = [(setup.root / 'data/tls' / name).read_bytes() for name in ('cert.pem', 'key.pem')]
    _, _, result = perform(setup, port=8555)
    assert result['status'] == 'completed'
    assert [(setup.root / 'data/tls' / name).read_bytes() for name in ('cert.pem', 'key.pem')] == original
    old_fingerprint = N.certificate_status(setup.root)['fingerprint']
    preview, ident, result = perform(setup, 'repair_certificate')
    assert preview['certificate']['previous_fingerprint'] == old_fingerprint
    assert preview['certificate']['fingerprint'] != old_fingerprint
    assert any('phones' in warning and 'peers' in warning for warning in preview['warnings'])
    assert result['status'] == 'completed'
    for name, data in zip(('cert', 'key'), original):
        assert H.path_for(setup.root, f'network-backup-{ident}-{name}.pem').read_bytes() == data


def test_bad_certificate_requires_explicit_repair_and_preserves_malformed_original(setup):
    target = setup.root / 'data/tls/cert.pem'
    target.parent.mkdir()
    target.write_bytes(b'legacy-invalid-public-certificate')
    with pytest.raises(H.HostControlError, match='separate repair review'):
        N.preview(setup.root, 'session-one', 'prepare')
    preview, ident, result = perform(setup, 'repair_certificate')
    assert result['status'] == 'completed' and N.certificate_status(setup.root)['status'] == 'ready'
    assert H.path_for(setup.root, f'network-backup-{ident}-cert.pem').read_bytes() == b'legacy-invalid-public-certificate'


def test_changed_stage_is_not_installed(setup):
    preview = N.preview(setup.root, 'session-one', 'prepare')
    N._stage_paths(setup.root, preview['preview_id'])[1].write_bytes(b'changed')
    N.confirm(setup.root, 'session-one', preview['preview_id'], 'a' * 32)
    result = N.dispatch(setup.root, 'session-one', 'a' * 32)
    assert result['status'] == 'failed' and not (setup.root / 'data/tls').exists()


def test_second_tls_replace_failure_restores_complete_original_pair(setup, monkeypatch):
    perform(setup)
    original = [(setup.root / 'data/tls' / name).read_bytes() for name in ('cert.pem', 'key.pem')]
    preview = N.preview(setup.root, 'session-one', 'repair_certificate')
    N.confirm(setup.root, 'session-one', preview['preview_id'], 'a' * 32)
    real_replace = N.os.replace
    def fail_key(source, destination):
        if 'network-stage-' in str(source) and str(source).endswith('-key.pem'):
            raise OSError('Synthetic interrupted replacement')
        return real_replace(source, destination)
    monkeypatch.setattr(N.os, 'replace', fail_key)
    result = N.dispatch(setup.root, 'session-one', 'a' * 32)
    assert result['status'] == 'failed' and 'restored' in result['message']
    assert [(setup.root / 'data/tls' / name).read_bytes() for name in ('cert.pem', 'key.pem')] == original


@pytest.mark.parametrize('status', ['public_network', 'managed_policy', 'unavailable', 'unsupported'])
def test_firewall_policy_blocks_unsupported_application(setup, status):
    perform(setup)
    setup.firewall.update(status=status, reason='Explicit platform policy block')
    with pytest.raises(H.HostControlError, match='policy block'):
        N.preview(setup.root, 'session-one', 'firewall')
    assert not setup.calls


def test_firewall_requires_separate_review_and_scoped_manifest(setup):
    perform(setup, port=8443)
    assert not setup.calls
    preview, ident, result = perform(setup, 'firewall')
    assert result['status'] == 'applying' and len(setup.calls) == 1
    assert preview['firewall']['rules'] == [{'protocol': 'TCP', 'port': 8443}, {'protocol': 'UDP', 'port': 5353}, {'protocol': 'UDP', 'port': 47474}]
    assert preview['firewall']['profile'] == 'Private'
    assert preview['firewall']['remote_addresses'] == 'LocalSubnet'
    N.dispatch(setup.root, 'session-one', ident)
    assert len(setup.calls) == 1
    helper_result(setup, ident, {'request_id': ident, 'status': 'failed', 'message': 'UAC denied'})
    assert N.receipt(setup.root, ident)['message'] == 'UAC denied'
    assert not N.receipt(setup.root, ident)['restart_required']


def test_legacy_rules_require_explicit_opt_in_and_revalidate_before_dispatch(setup):
    perform(setup)
    setup.firewall['legacy_rules'] = [{'name': 'old', 'display_name': 'TLI-Web'}]
    preview = N.preview(setup.root, 'session-one', 'firewall')
    assert not preview['firewall']['migrate_legacy'] and any('broad' in w for w in preview['warnings'])
    accepted = N.confirm(setup.root, 'session-one', preview['preview_id'], 'a' * 32)
    setup.firewall['legacy_rules'][0]['name'] = 'changed'
    assert N.dispatch(setup.root, 'session-one', 'a' * 32)['status'] == 'failed'
    assert not setup.calls
    preview = N.preview(setup.root, 'session-one', 'firewall', migrate_legacy=True)
    assert preview['firewall']['migrate_legacy']


def test_invalid_result_never_reports_success(setup):
    perform(setup)
    _, ident, _ = perform(setup, 'firewall')
    helper_result(setup, ident, {'request_id': 'f' * 32, 'status': 'completed', 'message': 'wrong'})
    assert N.receipt(setup.root, ident)['status'] == 'uncertain'


def test_unsigned_windows_result_cannot_claim_completion(setup):
    perform(setup)
    _, ident, _ = perform(setup, 'firewall')
    H.write_json(H.path_for(setup.root, f'network-firewall-{ident}-result.json'), {'request_id': ident, 'status': 'completed', 'message': 'forged'})
    assert N.receipt(setup.root, ident)['status'] == 'uncertain'


def test_expired_firewall_without_claim_is_terminal_and_can_be_reviewed_again(setup, monkeypatch):
    perform(setup)
    _, ident, result = perform(setup, 'firewall')
    monkeypatch.setattr(N.time, 'time', lambda: result['expires_at'] + 1)
    assert N.receipt(setup.root, ident)['status'] == 'failed'
    assert N.preview(setup.root, 'new-session', 'firewall')['preview_id']
    assert len(setup.calls) == 1


def test_expired_firewall_with_live_claim_stays_blocked_until_exact_generation_exits(setup, monkeypatch):
    import psutil
    perform(setup)
    _, ident, result = perform(setup, 'firewall')
    claim = {'request_id': ident, 'pid': 98765, 'created_at': 1234.5}
    raw = json.dumps(claim).encode()
    signature = hmac.new(bytes.fromhex(H.installation(setup.root)['secret']), raw, hashlib.sha256).hexdigest()
    H.write_json(H.path_for(setup.root, f'network-firewall-{ident}-claim'), {'payload': base64.b64encode(raw).decode(), 'signature': signature})
    monkeypatch.setattr(N.time, 'time', lambda: result['expires_at'] + 1)
    monkeypatch.setattr(psutil, 'Process', lambda pid: SimpleNamespace(create_time=lambda: 1234.5))
    assert N.receipt(setup.root, ident)['status'] == 'uncertain'
    with pytest.raises(H.HostControlError, match='unconfirmed'):
        N.preview(setup.root, 'new-session', 'firewall')
    assert N._read(setup.root)['receipts'][-1]['status'] == 'uncertain'
    def exited(pid): raise psutil.NoSuchProcess(pid)
    monkeypatch.setattr(psutil, 'Process', exited)
    assert N.receipt(setup.root, ident)['status'] == 'failed'
    monkeypatch.setattr(N, '_program', lambda: 'C:\\fixed\\python.exe')
    assert N.preview(setup.root, 'new-session', 'firewall')['preview_id']


def test_receipt_integrity_fails_closed(setup):
    _, ident, _ = perform(setup)
    path = H.path_for(setup.root, 'network_setup.json')
    value = json.loads(path.read_text())
    value['receipts'][0]['settings']['port'] = 1234
    path.write_text(json.dumps(value))
    with pytest.raises(H.HostControlError, match='integrity'):
        N.receipt(setup.root, ident)


def test_store_and_preview_boundaries_are_bounded(setup, monkeypatch):
    for _ in range(N.MAX_PREVIEWS): N.preview(setup.root, 'session-one', 'prepare')
    with pytest.raises(H.HostControlError, match='Too many'):
        N.preview(setup.root, 'session-one', 'prepare')
    now = N.time.time()
    monkeypatch.setattr(N.time, 'time', lambda: now + N.TTL + 1)
    N.preview(setup.root, 'session-one', 'prepare')
    assert len(list(H.path_for(setup.root, 'unused').parent.glob('network-stage-*.pem'))) == 2


def test_helper_source_has_narrow_fixed_commands_without_executing_it():
    source = (Path(__file__).resolve().parents[2] / 'TLI_Network_Setup.ps1').read_text()
    assert '-Profile Private -RemoteAddress LocalSubnet -Program $tliRequest.program' in source
    assert "protocol='UDP';port=5353" in source and "protocol='UDP';port=47474" in source
    assert '-Verb RunAs -WindowStyle Hidden' in source and '[IO.FileMode]::CreateNew' in source
    assert 'Invoke-Expression' not in source and 'Set-NetConnectionProfile' not in source
    assert 'HMACSHA256' in source and 'Get-FileHash' in source
