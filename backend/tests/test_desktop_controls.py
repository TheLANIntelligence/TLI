"""Native launcher recovery with synthetic listeners and process generations."""
from types import SimpleNamespace

import pytest

import host_control as H
import host_launcher as L


@pytest.fixture
def desktop(tmp_path, monkeypatch):
    root = tmp_path / 'TLI'
    root.mkdir()
    H.installation(root, create=True)
    child = {'pid': 123456, 'created_at': 1700000000.25, 'script': 'main.py'}
    current = {'host': '0.0.0.0', 'port': 8443, 'https': True}
    saved = {**current, 'port': 9443}
    state = SimpleNamespace(root=root, child=child, current=current, saved=saved,
                            generation='running', listener='running', now=1700000010)
    monkeypatch.setattr(L, 'recorded_backend_generations', lambda _root: [dict(child)])
    monkeypatch.setattr(L, 'process_generation_state', lambda *_args: state.generation)
    monkeypatch.setattr(L, 'current_backend_settings', lambda *_args: dict(current))
    monkeypatch.setattr(L.startup_config, 'resolve', lambda *_args, **_kwargs: {'effective_next': dict(saved)})
    monkeypatch.setattr(L, 'inspect_backend', lambda _root, settings: (state.listener, 'Synthetic checked listener'))
    monkeypatch.setattr(L, 'verify_release', lambda *_args: None)
    monkeypatch.setattr(L, 'time', SimpleNamespace(time=lambda: state.now))
    monkeypatch.setattr(L, 'launch', lambda *_args, **_kwargs: pytest.fail('Unexpected launch'))
    monkeypatch.setattr(L, 'stop_owned_backend', lambda *_args, **_kwargs: pytest.fail('Unexpected shutdown'))
    return state


def test_verified_old_release_offers_restart_without_opening(desktop, monkeypatch):
    def changed(*_args):
        raise L.ReleaseVerificationError('Release changed', restart_required=True)
    monkeypatch.setattr(L, 'verify_release', changed)
    status = L.desktop_status(desktop.root)
    assert status['state'] == 'running' and status['requires_restart']
    assert status['can_stop'] and status['can_restart'] and not status['can_open']
    assert H.HEX.fullmatch(status['action_token']) and 'url' not in status
    assert 'secret' not in str(status)


def test_running_url_uses_actual_listener_not_next_preferences(desktop):
    status = L.desktop_status(desktop.root)
    assert status['url'] == 'https://localhost:8443'
    assert status['can_open'] and not status['requires_restart']


@pytest.mark.parametrize('generation,listener,expected', [
    ('unknown', 'stopped', 'unverified'), ('exited', 'stopped', 'stopped'),
    ('running', 'stopped', 'starting'), ('running', 'unavailable', 'unverified'),
])
def test_status_never_equates_probe_failure_or_free_port_with_exit(desktop, generation, listener, expected):
    desktop.generation, desktop.listener = generation, listener
    status = L.desktop_status(desktop.root)
    assert status['state'] == expected
    assert not status['can_stop'] and not status['can_restart']
    assert 'action_token' not in status and 'url' not in status


def test_setup_status_does_not_issue_confirmation_token(desktop):
    status = L.desktop_status(desktop.root, issue_token=False)
    assert status['state'] == 'running' and 'action_token' not in status


def test_release_timeout_does_not_claim_an_older_release_or_stopped(desktop, monkeypatch):
    def timeout(*_args):
        raise L.ReleaseVerificationError('Timed out')
    monkeypatch.setattr(L, 'verify_release', timeout)
    status = L.desktop_status(desktop.root)
    assert status['state'] == 'running' and status['can_stop']
    assert not status['requires_restart'] and not status['can_open']
    assert 'earlier' not in status['message'] and 'could not be confirmed' in status['message']


def test_diagnostic_process_cannot_gain_native_stop_authority(desktop, monkeypatch):
    monkeypatch.setattr(L, 'recorded_backend_generations', lambda _root: [])
    status = L.desktop_status(desktop.root)
    assert status['state'] == 'running' and not status['can_stop'] and not status['can_restart']
    assert 'action_token' not in status


def test_concurrent_action_does_not_send_another_stop_request(desktop):
    token = L.desktop_status(desktop.root)['action_token']
    with H.FileLock(H.path_for(desktop.root, 'desktop-action.lock')):
        with pytest.raises(H.HostControlError, match='launch lock'):
            L.desktop_action(desktop.root, 'restart', token)


def test_future_confirmation_is_not_accepted(desktop):
    token = L.desktop_status(desktop.root)['action_token']
    desktop.now -= 60
    with pytest.raises(H.HostControlError):
        L.desktop_action(desktop.root, 'restart', token)


@pytest.mark.parametrize('change', ['generation', 'settings', 'expired', 'tampered', 'foreign'])
def test_stale_or_untrusted_confirmation_never_stops_a_process(desktop, change):
    token = L.desktop_status(desktop.root)['action_token']
    if change == 'generation':
        desktop.child['created_at'] += 1
    elif change == 'settings':
        desktop.saved['port'] += 1
    elif change == 'expired':
        desktop.now += 120
    elif change == 'tampered':
        token = 'f' * 64
    else:
        desktop.listener = 'unavailable'
    with pytest.raises(H.HostControlError, match='review'):
        L.desktop_action(desktop.root, 'restart', token)


def test_restart_waits_for_exact_exit_and_starts_once_at_reviewed_settings(desktop, monkeypatch):
    token = L.desktop_status(desktop.root)['action_token']
    calls = []
    def stop(root, *, expected_child, settings):
        assert root == desktop.root and expected_child == desktop.child
        assert settings == desktop.current
        calls.append('stop')
        desktop.generation, desktop.listener = 'exited', 'stopped'
    def launch(root, *, open_browser, wait_seconds, progress, settings):
        assert root == desktop.root and not open_browser and wait_seconds == 300
        assert settings == desktop.saved
        calls.append('start')
        return {'backend_state': 'running', 'url': 'https://localhost:9443'}
    monkeypatch.setattr(L, 'stop_owned_backend', stop)
    monkeypatch.setattr(L, 'launch', launch)
    desktop.now += 45  # A later status poll does not invalidate inline review.
    assert L.desktop_action(desktop.root, 'restart', token)['url'] == 'https://localhost:9443'
    assert calls == ['stop', 'start']
    with pytest.raises(H.HostControlError):
        L.desktop_action(desktop.root, 'restart', token)
    assert calls == ['stop', 'start']


@pytest.mark.parametrize('outcome', ['unknown_exit', 'changed_settings', 'shutdown_timeout'])
def test_restart_does_not_run_after_uncertain_stop_or_changed_settings(desktop, monkeypatch, outcome):
    token = L.desktop_status(desktop.root)['action_token']
    def stop(*_args, **_kwargs):
        if outcome == 'shutdown_timeout':
            H._fail('Shutdown timed out', 503)
        desktop.generation = 'unknown' if outcome == 'unknown_exit' else 'exited'
        if outcome == 'changed_settings':
            desktop.saved['port'] += 1
    monkeypatch.setattr(L, 'stop_owned_backend', stop)
    with pytest.raises(H.HostControlError):
        L.desktop_action(desktop.root, 'restart', token)


def test_stop_confirmation_does_not_implicitly_restart(desktop, monkeypatch):
    token = L.desktop_status(desktop.root)['action_token']
    monkeypatch.setattr(L, 'stop_owned_backend', lambda *_args, **_kwargs: setattr(desktop, 'generation', 'exited'))
    assert L.desktop_action(desktop.root, 'stop', token) is None


def test_current_listener_uses_only_identified_process_startup_fields(tmp_path, monkeypatch):
    import psutil
    child = {'pid': 123456, 'created_at': 1700000000.25, 'script': 'main.py'}
    monkeypatch.setattr(L, 'process_generation_state', lambda *_args: 'running')
    monkeypatch.setattr(psutil, 'Process', lambda _pid: SimpleNamespace(environ=lambda: {
        'TLI_HOST': '0.0.0.0', 'TLI_PORT': '8443', 'TLI_ENABLE_TLS': '1',
        'SECRET': 'never-return', 'TLI_ROOT': 'foreign-root'}))
    monkeypatch.setattr(L.startup_config, 'read', lambda _root: ({'host': '127.0.0.1', 'port': 9443, 'https': True}, True))
    assert L.current_backend_settings(tmp_path, child) == {'host': '0.0.0.0', 'port': 8443, 'https': True}
