"""Installed HTML is private opaque content, never a raw same-origin file tree.

The shared conftest imports main only after establishing a temporary TLI_ROOT
and suppressing bootstrap workers. Clients below never enter lifespan/startup.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from starlette.routing import Mount

import companion_auth
import hub_store
import installed_apps as apps
import tli_state as S

APP_ID = 'desk-clock'
URL = '/apps/desk-clock/index.html'
HTML = b'<!doctype html><html><head><title>Private saved app</title></head><body><button id="counter">0</button><script>document.getElementById("counter").onclick=e=>e.target.textContent=+e.target.textContent+1;</script></body></html>'


@pytest.fixture
def served(app, tmp_path, monkeypatch):
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(S, 'PIN_CONFIG_FILE', tmp_path / 'pin.json')
    monkeypatch.setattr(S, '_active_sessions', {})
    directory = tmp_path / 'apps' / APP_ID
    directory.mkdir(parents=True)
    entry = directory / 'index.html'
    entry.write_bytes(HTML)
    manifest = directory / 'manifest.json'
    manifest.write_text(json.dumps({'id': APP_ID, 'name': 'Clock', 'version': '1.0',
        'entry': 'index.html', 'permissions': ['mesh.devices', 'settings.read'], 'unknown': {'keep': True}}))
    index = tmp_path / 'hub_installed.json'
    index.write_text(json.dumps([{'id': APP_ID, 'name': 'Clock', 'type': 'app', 'custom': 'retain'}]))
    clients = []
    def browser(*, pin=False, session=True, remote=False, extra=None):
        origin = 'https://tli.test:8443' if remote else 'http://localhost:8000'
        headers = {'Origin': origin, **(extra or {})}
        token = None
        if pin:
            S.save_pin_config('a'*64, 'b'*64)
            if session:
                token = S.create_session_token('owner')
                headers['Cookie'] = 'tli_session=' + token
        value = TestClient(app, base_url=origin, client=('192.0.2.8' if remote else '127.0.0.1', 41000), headers=headers)
        assert not app.dependency_overrides
        clients.append(value)
        return value, token
    yield SimpleNamespace(root=tmp_path, entry=entry, manifest=manifest, index=index, browser=browser, app=app)
    for client in clients:
        client.close()


def saved(env):
    return {p.relative_to(env.root).as_posix(): p.read_bytes() for p in env.root.rglob('*') if p.is_file() and p.name != 'pin.json'}


def test_main_has_no_apps_static_mount_or_anonymous_fallback(served):
    assert all(not isinstance(route, Mount) or route.path != '/apps' for route in served.app.routes)
    before = saved(served)
    browser, _ = served.browser(pin=True, session=False)
    response = browser.get(URL)
    assert response.status_code == 401 and b'Private saved app' not in response.content
    assert saved(served) == before


@pytest.mark.parametrize('mode', ['pin-anonymous', 'pin-off-lan', 'stale', 'bearer-with-cookie', 'peer', 'proxy', 'cross-origin', 'same-site', 'null-origin'])
@pytest.mark.parametrize('method', ['GET', 'HEAD'])
def test_denied_request_never_reads_app_state(served, monkeypatch, mode, method):
    extra = {'peer': {'X-TLI-Peer-Id': 'untrusted'}, 'proxy': {'X-Forwarded-For': '127.0.0.1'},
             'cross-origin': {'Origin': 'https://other.invalid'}, 'same-site': {'Sec-Fetch-Site': 'same-site'},
             'null-origin': {'Origin': 'null'}}.get(mode, {})
    browser, token = served.browser(pin=mode != 'pin-off-lan', session=mode != 'pin-anonymous',
                                    remote=mode in ('pin-off-lan', 'bearer-with-cookie'), extra=extra)
    if mode == 'stale': S.revoke_session_token(token)
    if mode == 'bearer-with-cookie':
        origin = str(browser.base_url).rstrip('/')
        invitation, _ = companion_auth.create_pairing('owner', origin, 'f'*64)
        credential = companion_auth.redeem_pairing(invitation, origin, 'f'*64, 'Synthetic phone', 'test')['credential']
        browser.headers['Authorization'] = 'Bearer ' + credential
    reader = Mock(side_effect=AssertionError('Denied request inspected installed content'))
    monkeypatch.setattr(apps, 'app_snapshot', reader)
    response = browser.request(method, URL)
    assert response.status_code in (401,403)
    reader.assert_not_called()
    assert b'Private saved app' not in response.content


@pytest.mark.parametrize('pin,remote', [(False,False), (True,False), (True,True)])
@pytest.mark.parametrize('destination', ['document','iframe'])
def test_real_middleware_preserves_opaque_policy_for_direct_and_framed_html(served, pin, remote, destination):
    before = saved(served)
    browser, _ = served.browser(pin=pin, remote=remote)
    response = browser.get(URL, headers={'Sec-Fetch-Dest': destination})
    assert response.status_code == 200, response.text
    assert response.headers['content-type'] == 'text/html; charset=utf-8'
    assert response.headers['content-security-policy'] == apps.APP_CSP
    assert response.headers['x-frame-options'] == 'SAMEORIGIN'
    assert response.headers['cache-control'] == 'no-store'
    assert response.headers['referrer-policy'] == 'no-referrer'
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert 'clipboard-read=()' in response.headers['permissions-policy']
    assert 'allow-same-origin' not in apps.APP_CSP and 'allow-forms' not in apps.APP_CSP
    assert "connect-src 'none'" in apps.APP_CSP and "frame-src 'none'" in apps.APP_CSP
    assert response.text.index('global.TLIBridge') < response.text.index('document.getElementById("counter")')
    assert response.text.startswith('<!doctype html><script>')
    assert saved(served) == before


def test_head_uses_same_authority_and_policy_without_body(served):
    browser, _ = served.browser()
    response = browser.head(URL)
    assert response.status_code == 200 and response.content == b''
    assert response.headers['content-security-policy'] == apps.APP_CSP
    assert response.headers['cache-control'] == 'no-store'


@pytest.mark.parametrize('path', ['/apps', '/apps/', '/apps/desk-clock', '/apps/desk-clock/',
    '/apps/desk-clock/manifest.json', '/apps/desk-clock/app.js', '/apps/desk-clock/style.css',
    '/apps/desk-clock/other.html', '/apps/desk-clock/sub/index.html', '/apps/desk-clock/INDEX.HTML',
    '/apps//desk-clock/index.html', '/apps/desk-clock/index.html/extra', '/apps/desk-clock%2fsub/index.html'])
def test_only_exact_entry_is_served_with_no_raw_fallback(served, monkeypatch, path):
    browser, _ = served.browser()
    read = Mock(side_effect=AssertionError('Raw path reached repository'))
    monkeypatch.setattr(apps, 'app_snapshot', read)
    response = browser.get(path)
    assert response.status_code == 404
    assert response.headers['cache-control'] == 'no-store'
    read.assert_not_called()
    assert b'Private saved app' not in response.content


@pytest.mark.parametrize('identifier', ['a%5cb', 'a%3ab', 'a%20', '%252e%252e', 'CON', 'NUL', 'com1', 'CON.txt', 'lpt9.app', 'a.' ])
def test_unsafe_identifiers_fail_without_reading_other_files(served, identifier):
    before = saved(served)
    browser, _ = served.browser()
    response = browser.get('/apps/' + identifier + '/index.html')
    assert response.status_code == 400
    assert b'Private saved app' not in response.content and saved(served) == before


def test_case_alias_and_unregistered_app_never_serve_saved_html(served):
    browser, _ = served.browser()
    for identifier in ('Desk-clock', 'unregistered'):
        response = browser.get('/apps/' + identifier + '/index.html')
        assert response.status_code == 404 and b'Private saved app' not in response.content


@pytest.mark.parametrize('target,raw', [
    ('manifest', b'{broken'), ('manifest', b'{"id":"desk-clock","id":"other"}'),
    ('manifest', b'{"id":"desk-clock","name":"Clock","entry":"other.html"}'),
    ('manifest', b'{"id":"other","name":"Clock","entry":"index.html"}'),
    ('entry', b'\xff\xfe'), ('entry', b'x'*(apps.APP_HTML_LIMIT+1)),
    ('index', b'[]'), ('index', b'{broken'),
], ids=['broken-manifest','duplicate-manifest','other-entry','other-id','non-utf8','large-entry','unregistered','broken-index'])
def test_missing_registration_or_damaged_entry_fails_closed_preserving_bytes(served, target, raw):
    getattr(served,target).write_bytes(raw)
    before = saved(served)
    browser, _ = served.browser()
    response = browser.get(URL)
    assert response.status_code == (404 if target == 'index' and raw == b'[]' else 503)
    assert response.headers['cache-control'] == 'no-store'
    assert saved(served) == before
    assert b'Private saved app' not in response.content


@pytest.mark.parametrize('journal', [b'{}', b'{interrupted', b'{"schema":1,"schema":2}'])
def test_pending_or_damaged_transaction_never_serves_a_partial_app(served, journal):
    (served.root / 'hub_pending.json').write_bytes(journal)
    before = saved(served)
    browser, _ = served.browser()
    response = browser.get(URL)
    assert response.status_code == 503
    assert b'Private saved app' not in response.content and saved(served) == before


@pytest.mark.parametrize('boundary,fail', [('open',False),('open',True),('render',False),('render',True)])
def test_revoked_access_never_discloses_content_or_error(served, monkeypatch, boundary, fail):
    browser, token = served.browser(pin=True)
    if boundary == 'open':
        original = hub_store.os.open
        def revoke(path, *args, **kwargs):
            if Path(path) == served.entry:
                S.revoke_session_token(token)
                if fail: raise OSError('PRIVATE filesystem detail')
            return original(path, *args, **kwargs)
        monkeypatch.setattr(hub_store.os, 'open', revoke)
    else:
        original = apps.render_document
        def revoke(raw):
            result = original(raw)
            S.revoke_session_token(token)
            if fail: raise ValueError('PRIVATE renderer detail')
            return result
        monkeypatch.setattr(apps, 'render_document', revoke)
    response = browser.get(URL)
    assert response.status_code == 401
    assert b'Private saved app' not in response.content and 'PRIVATE' not in response.text
    assert served.entry.read_bytes() == HTML


@pytest.mark.parametrize('target', ['entry','manifest'])
def test_hardlinked_file_is_not_served(served, target):
    path = getattr(served,target)
    link = served.root / (target + '.retained-link')
    os.link(path, link)
    before = saved(served)
    browser, _ = served.browser()
    response = browser.get(URL)
    assert response.status_code == 503 and saved(served) == before


def test_reparse_parent_is_refused_before_source_open(served, monkeypatch):
    before = served.entry.read_bytes()
    original = Path.lstat
    parent = served.entry.parent
    def reparse(path, *args, **kwargs):
        result = original(path, *args, **kwargs)
        if path == parent:
            return SimpleNamespace(st_mode=result.st_mode, st_file_attributes=0x400)
        return result
    monkeypatch.setattr(Path, 'lstat', reparse)
    browser, _ = served.browser()
    response = browser.get(URL)
    assert response.status_code == 503
    assert served.entry.read_bytes() == before


def test_main_fails_closed_if_renderer_loses_its_exact_policy(served, monkeypatch):
    monkeypatch.setattr(apps, 'APP_HEADERS', {**apps.APP_HEADERS, 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'"})
    browser, _ = served.browser()
    response = browser.get(URL)
    assert response.status_code == 200
    assert response.headers['content-security-policy'] == "sandbox; default-src 'none'; frame-ancestors 'self'"


def test_bridge_is_exact_inert_sdk_and_never_reads_runtime_source():
    sdk = Path(__file__).resolve().parents[2] / 'frontend' / 'tli-bridge.js'
    assert apps.BRIDGE_SOURCE == sdk.read_text(encoding='utf-8-sig')
    assert 'postMessage' not in apps.BRIDGE_SOURCE and 'localStorage' not in apps.BRIDGE_SOURCE
    assert 'available: false' in apps.BRIDGE_SOURCE
    rendered = apps.render_document(b'<script>window.synthetic=true;</script>')
    assert rendered.index('global.TLIBridge') < rendered.index('window.synthetic=true')


def test_safe_dotted_identifier_retains_installed_url_contract(served):
    identifier = 'org.example.app'
    directory = served.root / 'apps' / identifier
    directory.mkdir()
    (directory / 'index.html').write_bytes(HTML)
    (directory / 'manifest.json').write_text(json.dumps({'id': identifier, 'name': 'Dotted app', 'entry': 'index.html'}))
    served.index.write_text(json.dumps([{'id': identifier, 'name': 'Dotted app', 'type': 'app'}]))
    before = saved(served)
    browser, _ = served.browser()
    response = browser.get('/apps/' + identifier + '/index.html')
    assert response.status_code == 200
    assert response.headers['content-security-policy'] == apps.APP_CSP
    assert b'Private saved app' in response.content and saved(served) == before


@pytest.mark.parametrize('change', ['entry', 'journal'])
def test_change_during_snapshot_never_exposes_mixed_content(served, monkeypatch, change):
    original = hub_store.read_artifact
    changed = False
    replacement = b'<html>Concurrent replacement is retained</html>'
    def read(path, *args, **kwargs):
        nonlocal changed
        result = original(path, *args, **kwargs)
        if Path(path) == served.entry and not changed:
            changed = True
            if change == 'entry': served.entry.write_bytes(replacement)
            else: (served.root / 'hub_pending.json').write_bytes(b'{}')
        return result
    monkeypatch.setattr(hub_store, 'read_artifact', read)
    browser, _ = served.browser()
    response = browser.get(URL)
    assert response.status_code == (409 if change == 'entry' else 503)
    assert b'Private saved app' not in response.content and replacement not in response.content
    assert served.entry.read_bytes() == (replacement if change == 'entry' else HTML)
    if change == 'journal': assert (served.root / 'hub_pending.json').read_bytes() == b'{}'


def test_waiting_reader_rechecks_captured_browser_after_repository_lock(served, monkeypatch):
    import threading
    browser, token = served.browser(pin=True)
    entered = threading.Event()
    original = apps.app_snapshot
    result = []
    def waiting(*args):
        entered.set()
        return original(*args)
    monkeypatch.setattr(apps, 'app_snapshot', waiting)
    worker = threading.Thread(target=lambda: result.append(browser.get(URL)))
    with hub_store.LOCK:
        worker.start()
        assert entered.wait(timeout=3)
        S.revoke_session_token(token)
    worker.join(timeout=3)
    assert not worker.is_alive() and len(result) == 1
    assert result[0].status_code == 401
    assert b'Private saved app' not in result[0].content and served.entry.read_bytes() == HTML
