"""Saved endpoint and publication tests; no model request or host startup."""
import json
import os
from pathlib import Path
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from types import SimpleNamespace

import pytest

import lm_studio_config as config
import tli_state as S
from providers.lmstudio import LMStudioProvider
from process_utils import hidden_process_kwargs
from routers import system_routes as routes


OLD = {"chat_url": "https://studio.example:7443/proxy/v1/chat/completions",
       "models_url": "https://studio.example:7443/proxy/v1/models"}
NEW = {"chat_url": "http://127.0.0.1:4321/v1/chat/completions",
       "models_url": "http://127.0.0.1:4321/v1/models"}


@pytest.fixture
def saved(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "LM_STUDIO_URL", OLD["chat_url"])
    monkeypatch.setattr(S, "LM_STUDIO_MODELS_URL", OLD["models_url"])
    provider = LMStudioProvider(**OLD)
    provider._report_cache = {"ts": 10**12, "report": {"ok": True, "server_url": OLD["models_url"]}}
    monkeypatch.setattr(S, "lm_provider", provider)
    monkeypatch.setattr(S, "log_debug", lambda *args, **kwargs: None)
    monkeypatch.setattr(routes, "_report_cache", {"result": {"ok": True}, "ts": 10**12, "provider": provider})
    monkeypatch.setattr(routes, "_health_cache", {"result": True, "ts": 10**12, "provider": provider})
    path = config.config_path(tmp_path)
    path.write_text(json.dumps({**OLD, "legacy_metadata": {"keep": "yes"}}), encoding="utf-8")
    return SimpleNamespace(path=path, root=tmp_path, provider=provider)


def test_missing_is_the_only_default_and_does_not_create_file(tmp_path):
    assert config.read(tmp_path) == config.DEFAULTS
    assert not config.config_path(tmp_path).exists()


@pytest.mark.parametrize("url,base", [
    ("http://localhost:1234", "http://localhost:1234/v1"),
    (" http://localhost:1234/v1/ ", "http://localhost:1234/v1"),
    ("http://[::1]:4321/v1/chat/completions", "http://[::1]:4321/v1"),
    ("https://studio.example/proxy", "https://studio.example/proxy/v1"),
    ("https://studio.example/custom/chat/completions", "https://studio.example/custom"),
])
def test_url_input_preserves_supported_hosts_and_prefixes(url, base):
    assert config.from_url(url) == {"chat_url": base + "/chat/completions", "models_url": base + "/models"}


@pytest.mark.parametrize("url", ["", "localhost:1234", "file:///tmp/model", "ftp://studio.example", "http://",
    "http://user:secret@studio.example", "http://studio.example?token=secret", "http://studio.example#part",
    "http://studio.example:0", "http://studio.example:65536", "http://studio.example:bad",
    "http://studio.example/\nsecret", "http://studio.example\\secret", "http://[bad]/", "http://studio.example/v1/models"])
def test_invalid_input_never_changes_saved_or_live_state(saved, url, browser_client):
    before = saved.path.read_bytes()
    response = browser_client.post("/system/lm_studio/url", json={"url": url})
    assert response.status_code == 400
    assert saved.path.read_bytes() == before and S.lm_provider is saved.provider
    assert S.LM_STUDIO_URL == OLD["chat_url"] and S.LM_STUDIO_MODELS_URL == OLD["models_url"]


@pytest.mark.parametrize("raw", [b"", b"{broken", b"[]", b"null", b"{}", b"\xff",
    b'{"chat_url":"http://one/v1/chat/completions"}',
    b'{"chat_url":true,"models_url":"http://one/v1/models"}',
    b'{"chat_url":"http://one/v1/chat/completions","models_url":"http://one/v1/models","models_url":"http://two/v1/models"}',
    b'{"chat_url":"http://one/v1/chat/completions","models_url":"http://one/v1/models","metadata":{"x":1,"x":2}}',
    b'{"chat_url":"http://one/v1/chat/completions","models_url":"http://one/v1/models","metadata":NaN}',
    b'{"chat_url":"http://one/v1/chat/completions","models_url":"http://one/v1/models","metadata":1e999}',
    b" " * (config.MAX_BYTES + 1)])
def test_corrupt_existing_file_is_preserved_and_never_becomes_default(saved, raw, browser_client):
    saved.path.write_bytes(raw)
    with pytest.raises(config.ConfigurationUnavailable, match="no default endpoint"):
        S.load_lm_studio_config_from_disk()
    response = browser_client.post("/system/lm_studio/url", json={"url": NEW["chat_url"]})
    assert response.status_code == 503 and "preserved" in response.json()["detail"]
    assert saved.path.read_bytes() == raw and S.lm_provider is saved.provider
    assert list(saved.root.glob(".lm-studio-*")) == []


def test_permission_failure_preserves_state_and_does_not_publish(saved, monkeypatch):
    original = Path.open
    def denied(path, *args, **kwargs):
        if path == saved.path:
            raise PermissionError("Synthetic private path must not escape")
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, "open", denied)
    for operation in (S.load_lm_studio_config_from_disk, lambda: S.save_lm_studio_url(NEW["chat_url"])):
        with pytest.raises(config.ConfigurationUnavailable) as error:
            operation()
        assert "Synthetic private" not in str(error.value)
        assert S.lm_provider is saved.provider and S.LM_STUDIO_URL == OLD["chat_url"]


@pytest.mark.parametrize("stage", ["write", "fsync", "replace"])
def test_failed_write_keeps_prior_bytes_provider_and_cache(saved, monkeypatch, stage, browser_client):
    before = saved.path.read_bytes()
    def fail(*args, **kwargs):
        raise OSError("Synthetic private save failure")
    if stage == "write":
        original = config.tempfile.NamedTemporaryFile
        def broken(*args, **kwargs):
            stream = original(*args, **kwargs)
            stream.write = fail
            return stream
        monkeypatch.setattr(config.tempfile, "NamedTemporaryFile", broken)
    else:
        monkeypatch.setattr(config.os, stage, fail)
    response = browser_client.post("/system/lm_studio/url", json={"url": NEW["chat_url"]})
    assert response.status_code == 503 and "Synthetic private" not in response.text
    assert saved.path.read_bytes() == before
    assert S.lm_provider is saved.provider and S.lm_provider._report_cache["report"]["ok"] is True
    assert (S.LM_STUDIO_URL, S.LM_STUDIO_MODELS_URL) == (OLD["chat_url"], OLD["models_url"])
    assert list(saved.root.glob(".lm-studio-*")) == []


def test_save_is_durable_before_publication_and_keeps_model_selection(saved, monkeypatch, browser_client):
    selected = S.MODEL_CONFIG
    selected_key = S.DEFAULT_MODEL_KEY
    publish = S._publish_lm_studio
    events = []
    fsync, replace = config.os.fsync, config.os.replace
    def synced(fd):
        events.append("fsync")
        return fsync(fd)
    def replaced(source, destination):
        assert events == ["fsync"] and S.lm_provider is saved.provider
        events.append("replace")
        return replace(source, destination)
    def published(value, provider):
        assert events == ["fsync", "replace"] and config.read(saved.root) == NEW
        events.append("publish")
        publish(value, provider)
    monkeypatch.setattr(config.os, "fsync", synced)
    monkeypatch.setattr(config.os, "replace", replaced)
    monkeypatch.setattr(S, "_publish_lm_studio", published)
    response = browser_client.post("/system/lm_studio/url", json={"url": NEW["chat_url"]})
    assert response.status_code == 200 and response.json() == {"ok": True, **NEW}
    assert events == ["fsync", "replace", "publish"]
    assert S.lm_provider is not saved.provider
    assert S.lm_provider._report_cache == {"ts": 0.0, "report": None}
    assert (S.lm_provider.chat_url, S.lm_provider.models_url) == (S.LM_STUDIO_URL, S.LM_STUDIO_MODELS_URL)
    assert saved.provider.chat_url == OLD["chat_url"] and saved.provider.models_url == OLD["models_url"]
    assert json.loads(saved.path.read_text())["legacy_metadata"] == {"keep": "yes"}
    assert S.MODEL_CONFIG is selected and S.DEFAULT_MODEL_KEY == selected_key


def test_fresh_process_constructs_provider_from_saved_config_without_main_or_network(saved):
    script = """
import json, sys, requests
def forbidden(*args, **kwargs): raise AssertionError('No network during provider initialization')
requests.sessions.Session.request = forbidden
import tli_state as S
S.load_lm_studio_config_from_disk()
assert 'main' not in sys.modules
print(json.dumps({'chat_url': S.lm_provider.chat_url, 'models_url': S.lm_provider.models_url,
                  'aliases': [S.LM_STUDIO_URL, S.LM_STUDIO_MODELS_URL]}))
"""
    # The child needs an installation root; S.DATA_DIR is its data child.
    root = saved.root / "fresh"
    (root / "data").mkdir(parents=True)
    config.config_path(root / "data").write_text(json.dumps(OLD))
    env = dict(os.environ, TLI_ROOT=str(root), PYTHONPATH=str(Path(S.__file__).parent))
    child = subprocess.run([sys.executable, "-c", script], cwd=root, env=env, capture_output=True,
                           text=True, timeout=15, **hidden_process_kwargs())
    assert child.returncode == 0, child.stderr
    assert json.loads(child.stdout) == {**OLD, "aliases": [OLD["chat_url"], OLD["models_url"]]}


def test_runtime_save_and_fresh_construction_agree(saved):
    S.save_lm_studio_url(NEW["chat_url"])
    S.load_lm_studio_config_from_disk()
    assert (S.lm_provider.chat_url, S.lm_provider.models_url) == (NEW["chat_url"], NEW["models_url"])


def test_startup_preflight_surfaces_bad_saved_endpoint_without_provider_effects(saved):
    import main
    before = b"{broken"
    saved.path.write_bytes(before)
    with pytest.raises(config.ConfigurationUnavailable):
        main._validate_startup()
    assert saved.path.read_bytes() == before and S.lm_provider is saved.provider


def test_two_saves_publish_the_same_complete_configuration_as_disk(saved):
    start = Barrier(2)
    def save(url):
        start.wait(timeout=3)
        return S.save_lm_studio_url(url)
    with ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(save, NEW["chat_url"])
        b = pool.submit(save, "https://second.example:9999/base/v1")
        a.result(timeout=5); b.result(timeout=5)
    current = config.read(saved.root)
    assert current == {"chat_url": S.lm_provider.chat_url, "models_url": S.lm_provider.models_url}
    assert current == {"chat_url": S.LM_STUDIO_URL, "models_url": S.LM_STUDIO_MODELS_URL}
    assert list(saved.root.glob(".lm-studio-*")) == []


@pytest.mark.parametrize("kind", ["report", "health"])
def test_late_old_health_result_cannot_be_reused_for_new_provider(saved, monkeypatch, kind):
    entered, release = Event(), Event()
    def old_result():
        entered.set()
        assert release.wait(3)
        return {"ok": True, "server_url": OLD["models_url"]} if kind == "report" else True
    monkeypatch.setattr(saved.provider, "health_report" if kind == "report" else "health_check", old_result)
    monkeypatch.setattr(routes, "_report_cache" if kind == "report" else "_health_cache", {"result": None, "ts": 0})
    call = routes.lmstudio_health_report_legacy if kind == "report" else routes.lm_studio_health_check_cached
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(call)
        assert entered.wait(3)
        try:
            S.save_lm_studio_url(NEW["chat_url"])
            monkeypatch.setattr(S.lm_provider, "health_report", lambda: {"ok": False, "server_url": NEW["models_url"]})
            monkeypatch.setattr(S.lm_provider, "health_check", lambda: False)
        finally:
            release.set()
        pending.result(timeout=3)
    result = call()
    assert result == ({"ok": False, "server_url": NEW["models_url"]} if kind == "report" else False)


def test_models_response_uses_one_provider_even_when_settings_change_during_list(saved, monkeypatch):
    def models():
        S.save_lm_studio_url(NEW["chat_url"])
        return [{"id": "original-model", "label": "original-model"}]
    monkeypatch.setattr(saved.provider, "list_models", models)
    response = routes.models_available()
    assert response["server_url"] == OLD["models_url"]
    assert response["compat"]["server_url"] == OLD["models_url"]
    assert response["models"][0]["id"] == "original-model"
    assert S.lm_provider.models_url == NEW["models_url"]


@pytest.mark.parametrize("replacement", [b"{damaged-during-save", json.dumps({**OLD, "external_edit": True}).encode(), None])
def test_external_edit_or_damage_during_fsync_is_preserved(saved, monkeypatch, replacement, browser_client):
    fsync = config.os.fsync
    def changed(fd):
        fsync(fd)
        if replacement is None:
            saved.path.unlink()
        else:
            saved.path.write_bytes(replacement)
    monkeypatch.setattr(config.os, "fsync", changed)
    response = browser_client.post("/system/lm_studio/url", json={"url": NEW["chat_url"]})
    assert response.status_code == 503
    assert (saved.path.read_bytes() if saved.path.exists() else None) == replacement
    assert S.lm_provider is saved.provider and S.LM_STUDIO_URL == OLD["chat_url"]
    assert list(saved.root.glob(".lm-studio-*")) == []


def test_late_replace_error_reports_uncertainty_without_retry_or_default(saved, monkeypatch, browser_client):
    replace = config.os.replace
    calls = []
    def uncertain(source, destination):
        calls.append(destination)
        replace(source, destination)
        raise OSError("Synthetic error after replacement")
    monkeypatch.setattr(config.os, "replace", uncertain)
    response = browser_client.post("/system/lm_studio/url", json={"url": NEW["chat_url"]})
    assert response.status_code == 503 and "not confirmed" in response.json()["detail"]
    assert "Synthetic" not in response.text and len(calls) == 1
    assert config.read(saved.root) == NEW
    assert S.lm_provider is saved.provider and S.LM_STUDIO_URL == OLD["chat_url"]
    assert list(saved.root.glob(".lm-studio-*")) == []


@pytest.mark.parametrize("broken", [False, True])
def test_linked_configuration_is_not_followed_replaced_or_defaulted(saved, broken):
    target = saved.root / "linked-settings.json"
    original = saved.path.read_bytes()
    saved.path.unlink()
    if not broken:
        target.write_bytes(original)
    try:
        saved.path.symlink_to(target)
    except OSError as error:
        pytest.skip(f"Host cannot create test symlinks: {error}")
    for operation in (S.load_lm_studio_config_from_disk, lambda: S.save_lm_studio_url(NEW["chat_url"])):
        with pytest.raises(config.ConfigurationUnavailable):
            operation()
        assert saved.path.is_symlink() and S.lm_provider is saved.provider
    assert (target.read_bytes() if target.exists() else None) == (None if broken else original)
