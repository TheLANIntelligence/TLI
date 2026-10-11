"""Saved launch choices and readiness use temporary installations and fake runtimes."""
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response
import startup_config as config
import tli_state as S
from routers import companion_routes as routes


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "BASE_DIR", str(tmp_path))
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path / "data"))
    for name in ("TLI_HOST", "TLI_PORT", "TLI_LAN_MODE", "TLI_ENABLE_TLS", "TLI_OPEN_BROWSER"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "SERVER_BIND_HOST", "127.0.0.1", raising=False)
    monkeypatch.setattr(S, "SERVER_BIND_PORT", 8000, raising=False)
    monkeypatch.setattr(S, "TLS_ENABLED", False)


def session():
    return {"Cookie": "tli_session=" + S.create_session_token("owner")}


def test_defaults_are_read_only_and_saved_values_survive_new_resolution(tmp_path):
    assert config.resolve(tmp_path)["effective_next"] == config.DEFAULTS
    assert list(tmp_path.iterdir()) == []
    saved = {"host": "0.0.0.0", "port": 8443, "https": True}
    config.write(saved, tmp_path)
    before = config.config_path(tmp_path).read_bytes()
    assert config.resolve(tmp_path, {})["effective_next"] == saved
    assert config.config_path(tmp_path).read_bytes() == before


def test_explicit_environment_precedence_and_secure_downgrade_rejection(tmp_path):
    config.write({"host": "0.0.0.0", "port": 8443, "https": True}, tmp_path)
    resolved = config.resolve(tmp_path, {"TLI_HOST": "::1", "TLI_LAN_MODE": "1", "TLI_PORT": "9443", "TLI_ENABLE_TLS": "0"})
    assert resolved["effective_next"] == {"host": "::1", "port": 9443, "https": False}
    assert set(resolved["environment_overrides"]) == {"TLI_HOST", "TLI_LAN_MODE", "TLI_PORT", "TLI_ENABLE_TLS"}
    with pytest.raises(config.StartupConfigurationError, match="without HTTPS"):
        config.resolve(tmp_path, {"TLI_ENABLE_TLS": "0"})


@pytest.mark.parametrize("raw", [b"broken", b"{}", b'[]', b'{"version":2}', b'x' * 16385], ids=['corrupt', 'empty', 'wrong-shape', 'new-version', 'oversized'])
def test_unreadable_config_preserved_during_read_and_explicit_save(tmp_path, raw):
    path = config.config_path(tmp_path)
    path.parent.mkdir()
    path.write_bytes(raw)
    for operation in (lambda: config.resolve(tmp_path), lambda: config.write(config.DEFAULTS, tmp_path)):
        with pytest.raises(config.StartupConfigurationError, match="preserved"):
            operation()
        assert path.read_bytes() == raw


@pytest.mark.parametrize("env", [{"TLI_PORT": "0"}, {"TLI_PORT": "65536"}, {"TLI_PORT": "wrong"}, {"TLI_HOST": "bad;command"}, {"TLI_ENABLE_TLS": "maybe"}, {"TLI_LAN_MODE": "yes"}])
def test_invalid_overrides_never_fall_back(tmp_path, env):
    with pytest.raises(config.StartupConfigurationError):
        config.resolve(tmp_path, env)


def test_failed_replace_preserves_previous_saved_file(tmp_path, monkeypatch):
    config.write(config.DEFAULTS, tmp_path)
    before = config.config_path(tmp_path).read_bytes()
    monkeypatch.setattr(config.os, "replace", lambda *a: (_ for _ in ()).throw(OSError("simulated disk fault")))
    with pytest.raises(OSError):
        config.write({"host": "0.0.0.0", "port": 8443, "https": True}, tmp_path)
    assert config.config_path(tmp_path).read_bytes() == before
    assert list(config.config_path(tmp_path).parent.glob(".startup-*")) == []


def test_concurrent_saves_always_leave_a_complete_configuration(tmp_path):
    choices = [{"host": "127.0.0.1", "port": port, "https": False} for port in range(8001, 8009)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda choice: config.write(choice, tmp_path), choices))
    assert config.read(tmp_path)[0] in choices


def test_startup_api_is_desktop_owner_only_and_does_not_change_running_server(client, monkeypatch, tmp_path):
    monkeypatch.setattr(routes.auth, "credential_owner", lambda token: "owner")
    assert client.get('/api/companion/v1/startup').status_code == 401
    assert client.put('/api/companion/v1/startup', headers={"Authorization": "Bearer tlic_fake"}, json=config.DEFAULTS).status_code == 403
    assert client.put('/api/companion/v1/startup', headers={**session(), "Origin": "https://different.invalid"}, json=config.DEFAULTS).status_code == 403
    before = client.get('/api/companion/v1/startup', headers=session()).json()
    assert before['configured'] is False and before['restart_required'] is False
    saved = {"host": "0.0.0.0", "port": 8443, "https": True}
    result = client.put('/api/companion/v1/startup', headers=session(), json=saved)
    assert result.status_code == 200, result.text
    assert result.json()['saved'] == saved and result.json()['restart_required'] is True
    assert result.json()['running'] == config.DEFAULTS
    assert (S.SERVER_BIND_HOST, S.SERVER_BIND_PORT, S.TLS_ENABLED) == ('127.0.0.1', 8000, False)
    assert config.read(tmp_path)[0] == saved


def test_startup_api_rejects_insecure_or_failed_save_without_claiming_success(client, tmp_path, monkeypatch):
    config.write(config.DEFAULTS, tmp_path)
    before = config.config_path(tmp_path).read_bytes()
    response = client.put('/api/companion/v1/startup', headers=session(), json={**config.DEFAULTS, 'host': '0.0.0.0'})
    assert response.status_code == 409
    monkeypatch.setattr(config.os, 'replace', lambda *a: (_ for _ in ()).throw(OSError('simulated')))
    response = client.put('/api/companion/v1/startup', headers=session(), json={**config.DEFAULTS, 'port': 9000})
    assert response.status_code == 503 and 'previous' in response.json()['detail']
    assert config.config_path(tmp_path).read_bytes() == before


def test_saved_https_launch_uses_config_without_starting_real_server(tmp_path, monkeypatch):
    import main, uvicorn, tls_cert, launch_checks, security_state
    config.write({'host': '0.0.0.0', 'port': 8443, 'https': True}, tmp_path)
    calls = []
    monkeypatch.setattr(security_state, 'validate_existing_security', lambda: None)
    monkeypatch.setattr(launch_checks, 'check_port', lambda host, port: calls.append(('port', host, port)))
    monkeypatch.setattr(tls_cert, 'ensure_tls_cert', lambda *a: True)
    monkeypatch.setattr(uvicorn, 'run', lambda *a, **kw: calls.append(('run', kw)))
    main._tli_run_server()
    assert calls[0] == ('port', '0.0.0.0', 8443)
    assert calls[1][1]['ssl_certfile'] and calls[1][1]['port'] == 8443
    assert calls[1][1]['timeout_graceful_shutdown'] == 30


def test_failed_certificate_or_security_check_never_starts_http(tmp_path, monkeypatch):
    import main, uvicorn, tls_cert, launch_checks, security_state
    config.write({'host': '0.0.0.0', 'port': 8443, 'https': True}, tmp_path)
    monkeypatch.setattr(security_state, 'validate_existing_security', lambda: None)
    monkeypatch.setattr(launch_checks, 'check_port', lambda *a: None)
    monkeypatch.setattr(tls_cert, 'ensure_tls_cert', lambda *a: False)
    monkeypatch.setattr(uvicorn, 'run', lambda *a, **kw: pytest.fail('Started server after failed preflight'))
    with pytest.raises(RuntimeError, match='HTTP was not started'):
        main._tli_run_server()
    monkeypatch.setattr(security_state, 'validate_existing_security', lambda: (_ for _ in ()).throw(security_state.SecurityStateUnavailable('PIN configuration')))
    with pytest.raises(security_state.SecurityStateUnavailable):
        main._tli_run_server()


def test_clean_process_resolves_saved_choices_without_importing_application(tmp_path):
    config.write({'host': '0.0.0.0', 'port': 8443, 'https': True}, tmp_path)
    env = dict(os.environ, TLI_ROOT=str(tmp_path), PYTHONPATH=str(Path(config.__file__).parent))
    child = subprocess.run([sys.executable, '-c', 'import json,sys,startup_config; print(json.dumps(startup_config.resolve())); assert "tli_state" not in sys.modules and "main" not in sys.modules'], env=env, cwd=tmp_path, capture_output=True, text=True, timeout=10)
    assert child.returncode == 0, child.stderr
    assert json.loads(child.stdout)['effective_next'] == {'host': '0.0.0.0', 'port': 8443, 'https': True}


@pytest.mark.parametrize('host,url', [('0.0.0.0', 'https://localhost:8443'), ('::1', 'https://[::1]:8443'), ('192.168.1.2', 'https://192.168.1.2:8443')])
def test_browser_url_uses_resolved_address(host, url):
    assert config.browser_url({'host': host, 'port': 8443, 'https': True}) == url


@pytest.mark.parametrize('healthy,installed,mesh,expected', [(True, True, False, 'available'), (False, True, False, 'unavailable'), (False, False, True, 'unknown'), (False, False, False, 'unknown')])
def test_ai_availability_is_separate_from_host_connection(tmp_path, monkeypatch, healthy, installed, mesh, expected):
    from ai.ai_manager import BundledAIManager
    path = tmp_path / 'fixture.gguf'
    if installed:
        path.write_bytes(b'never loaded')
    manager = SimpleNamespace(cfg=SimpleNamespace(model_path=path), is_healthy=lambda: healthy, active_preset_id='lite')
    monkeypatch.setattr(BundledAIManager, 'get', lambda: manager)
    monkeypatch.setattr(routes, '_node', lambda: {'id': 'host', 'name': 'Sample TLI'})
    monkeypatch.setattr(routes, '_recent_mesh_ai', lambda: mesh)
    monkeypatch.setattr(routes.models, 'image_provider', lambda: (_ for _ in ()).throw(HTTPException(409, 'Unavailable')))
    monkeypatch.setattr(S, 'lm_provider', SimpleNamespace(_report_cache={}))
    data = routes.bootstrap(Response(), 'owner')
    assert data['node']['id'] == 'host' and data['ai']['status'] == expected
    assert data['capabilities']['chat'] == (expected == 'available')


def test_lm_readiness_uses_recent_observation_without_inference(monkeypatch):
    report = {'ok': True, 'chat_ok': True, 'checked_at': S.now_iso()}
    cache = {'ts': time.time(), 'report': report}
    monkeypatch.setattr(S, 'lm_provider', SimpleNamespace(_report_cache=cache, health_report=lambda: pytest.fail('Generated inference during readiness')))
    assert routes._ai_readiness(None, False, False, False)['status'] == 'available'
    report['chat_ok'] = False
    assert routes._ai_readiness(None, False, False, False)['status'] == 'unavailable'
    cache['ts'] -= 31
    assert routes._ai_readiness(None, False, False, False)['status'] == 'unknown'
