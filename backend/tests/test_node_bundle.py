"""Portable Node archives include executable shared code, never live host state."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile

import pytest

PROJECT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("build_node", PROJECT / "build_node.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


@pytest.fixture
def source(tmp_path):
    root = tmp_path / "source"
    for name in bundle.FILES:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('TLI_VERSION = "fixture-1"\n' if name == "backend/tli_state.py" else "public fixture\n", encoding="utf-8")
    for name in ("data/node_identity.json", "data/tls/key.pem", ".env", "backend/ai/models/private.gguf", "frontend/index.html"):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("PRIVATE-MARKER", encoding="utf-8")
    return root


def test_bundle_uses_allowlist_and_preserves_existing_destination(source, tmp_path):
    target = bundle.build(source, tmp_path / "node.zip")
    with zipfile.ZipFile(target) as archive:
        assert set(archive.namelist()) == {*bundle.FILES, "node/manifest.json"}
        manifest = json.loads(archive.read("node/manifest.json"))
        assert manifest["tli_version"] == "fixture-1"
        assert manifest["contains_models"] is False and manifest["contains_dependencies"] is False
        for name in bundle.FILES:
            data = archive.read(name)
            assert b"PRIVATE-MARKER" not in data
            assert hashlib.sha256(data).hexdigest() == manifest["files"][name]
    before = target.read_bytes()
    with pytest.raises(FileExistsError):
        bundle.build(source, target)
    assert target.read_bytes() == before


def test_bundle_refuses_redirected_source_without_creating_output(source, tmp_path):
    public = source / "node" / "README.md"
    public.unlink()
    try:
        public.symlink_to(source / "data" / "node_identity.json")
    except OSError:
        pytest.skip("Creating a test symbolic link is unavailable on this account")
    target = tmp_path / "node.zip"
    with pytest.raises(ValueError, match="redirected"):
        bundle.build(source, target)
    assert not target.exists()


def test_extracted_bundle_has_only_compute_routes_and_no_host_runtime_imports(tmp_path):
    target = bundle.build(PROJECT, tmp_path / "node.zip")
    extracted = tmp_path / "extracted"
    with zipfile.ZipFile(target) as archive:
        archive.extractall(extracted)
    state = tmp_path / "fresh-state"
    state.mkdir()
    environment = {key: value for key, value in os.environ.items()
                   if key.upper() in {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP", "LANG"}}
    environment.update(TLI_ROOT=str(state), PYTHONUTF8="1")
    code = """
import json, sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path('backend').resolve()))
from fastapi import FastAPI
from fastapi.testclient import TestClient
import tli_state as S
import lan_inference as L
from peer_inference_routes import make_peer_router
S.lm_provider = SimpleNamespace(chat_url='http://127.0.0.1:1234/v1/chat/completions', models_url='http://127.0.0.1:1234/v1/models')
L._local_json = lambda *args, **kwargs: {'models': []}
assert L._resources(include_bundled=False) == []
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(make_peer_router(resource_loader=lambda **kwargs: L._resources(include_bundled=False, **kwargs)))
assert set(app.openapi()['paths']) == {'/agent/peer/inference', '/agent/peer/inference/stream'}
with TestClient(app, base_url='https://192.168.2.10:8443') as client:
    assert client.get('/agent/peer/inference').status_code == 401
    assert client.post('/agent/peer/inference/stream', json={}).status_code == 401
    for path in ('/', '/docs', '/redoc', '/openapi.json', '/api/ai/chat', '/vault/status', '/open_reveal', '/mesh/trust/approve'):
        assert client.get(path).status_code == 404
        assert client.post(path, json={}).status_code == 404
assert not {'main', 'ai.ai_manager', 'routers.system_routes', 'vault_security', 'companion_auth'} & set(sys.modules)
assert not Path(S.CONVERSATIONS_FILE).exists()
print(json.dumps({'isolated_compute_only': True}))
"""
    result = subprocess.run([sys.executable, "-c", code], cwd=extracted, env=environment,
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr + result.stdout
    assert json.loads(result.stdout)["isolated_compute_only"] is True
