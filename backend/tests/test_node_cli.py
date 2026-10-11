"""Real isolated CLI persistence; no host state, LAN listeners or model runtime."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace

import pytest

BACKEND = Path(__file__).resolve().parents[1]
ADDRESS = "192.168.50.9"


def invoke(*arguments, patch="", timeout=30):
    program = "\n".join([
        "import sys", "sys.path.insert(0, " + repr(str(BACKEND)) + ")",
        "import tli_node as N", "N._local_addresses = lambda: {'192.168.50.9'}",
        "import tls_cert", "tls_cert._local_ipv4_addresses = lambda: ['192.168.50.9']",
        patch, "raise SystemExit(N.main(sys.argv[1:]))",
    ])
    return subprocess.run([sys.executable, "-c", program, *map(str, arguments)], capture_output=True, text=True, encoding="utf-8", timeout=timeout)


@pytest.fixture(scope="module")
def saved_nodes(tmp_path_factory):
    parent = tmp_path_factory.mktemp("node-cli")
    nodes = []
    for name in ("Compute", "Primary"):
        root = parent / name
        result = invoke("init", "--state-dir", root, "--name", name, "--origin", f"https://{ADDRESS}:8444")
        assert result.returncode == 0, result.stderr
        nodes.append(root)
    return nodes


@pytest.fixture
def state(tmp_path, saved_nodes):
    root = tmp_path / "node"
    shutil.copytree(saved_nodes[0], root)
    return root


def fingerprints(root):
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob("*") if path.is_file() and not path.name.endswith(".lock")}


def test_import_and_help_do_not_import_host_or_create_state(tmp_path):
    code = "\n".join([
        "import sys, os", "sys.path.insert(0, " + repr(str(BACKEND)) + ")",
        "os.environ['TLI_ROOT'] = " + repr(str(tmp_path)),
        "import tli_node", "assert 'tli_state' not in sys.modules", "assert 'fastapi' not in sys.modules",
        "assert 'main' not in sys.modules", "assert 'ai.ai_manager' not in sys.modules",
        "try: tli_node.main(['--help'])", "except SystemExit as e: assert e.code == 0",
    ])
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert not list(tmp_path.iterdir())


def test_init_preserves_nonempty_full_host_directory(tmp_path):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "conversations.json").write_text('{"private": "unchanged"}')
    before = fingerprints(tmp_path)
    result = invoke("init", "--state-dir", tmp_path, "--name", "No", "--origin", f"https://{ADDRESS}:8444")
    assert result.returncode == 1
    assert "new or empty" in result.stderr
    assert fingerprints(tmp_path) == before


def test_missing_state_run_never_initializes_or_uses_inherited_host_root(tmp_path):
    root = tmp_path / "missing"
    result = invoke("run", "--state-dir", root)
    assert result.returncode == 1
    assert not root.exists()


@pytest.mark.parametrize("origin", ["http://192.168.50.9:8444", "https://127.0.0.1:8444", "https://0.0.0.0:8444", "https://8.8.8.8", "https://user:pass@192.168.50.9:8444", "https://192.168.50.9:8444/path", "https://192.168.50.9:0"])
def test_init_rejects_unusable_origin_before_state_creation(tmp_path, origin):
    root = tmp_path / "fresh"
    result = invoke("init", "--state-dir", root, "--name", "No", "--origin", origin)
    assert result.returncode == 1
    assert not root.exists()


@pytest.mark.parametrize("origin", ["http://192.168.1.1:1234", "http://example.com:1234", "http://127.0.0.1:1234/v1", "http://u:p@127.0.0.1:1234", "http://127.0.0.1:0"])
def test_init_rejects_external_or_non_origin_model_url(tmp_path, origin):
    root = tmp_path / "fresh"
    result = invoke("init", "--state-dir", root, "--name", "No", "--origin", f"https://{ADDRESS}:8444", "--lm-studio-url", origin)
    assert result.returncode == 1
    assert not root.exists()


def test_init_requires_address_on_local_nic(tmp_path):
    root = tmp_path / "fresh"
    result = invoke("init", "--state-dir", root, "--name", "No", "--origin", "https://192.168.50.10:8444")
    assert result.returncode == 1
    assert "not assigned" in result.stderr
    assert not root.exists()


def test_public_card_is_stable_and_contains_no_private_identity(state):
    before = fingerprints(state)
    first = invoke("card", "--state-dir", state)
    second = invoke("card", "--state-dir", state)
    assert first.returncode == second.returncode == 0
    a, b = json.loads(first.stdout), json.loads(second.stdout)
    assert a["node_id"] == b["node_id"]
    assert a["identity_fingerprint"] == b["identity_fingerprint"]
    assert a["certificate_sha256"] == b["certificate_sha256"]
    assert a["capabilities"] == ["inference_v1"]
    assert set(a) == {"protocol", "node_id", "name", "origin", "public_key", "identity_fingerprint", "certificate_der", "certificate_sha256", "capabilities", "issued_at", "signature"}
    assert fingerprints(state) == before


def test_export_never_overwrites_existing_file(state, tmp_path):
    target = tmp_path / "public.json"
    target.write_text("keep me")
    result = invoke("card", "--state-dir", state, "--out", target)
    assert result.returncode == 1
    assert target.read_text() == "keep me"


@pytest.mark.parametrize("relative", ["data/node_identity.json", "data/tls/key.pem", "data/mesh/mesh_directory.json", "data/mesh/node_config.json"])
def test_incomplete_state_is_not_repaired(state, relative):
    (state / relative).unlink()
    before = fingerprints(state)
    result = invoke("card", "--state-dir", state)
    assert result.returncode == 1
    assert fingerprints(state) == before


def test_corrupt_identity_is_not_replaced(state):
    (state / "data/node_identity.json").write_text("broken")
    before = fingerprints(state)
    result = invoke("peers", "--state-dir", state)
    assert result.returncode == 1
    assert fingerprints(state) == before


def test_changed_nic_address_prevents_card_and_run_without_writes(state):
    before = fingerprints(state)
    for command in ("card", "run"):
        result = invoke(command, "--state-dir", state, patch="N._local_addresses = lambda: {'192.168.50.10'}")
        assert result.returncode == 1
        assert "not assigned" in result.stderr
    assert fingerprints(state) == before


def test_changed_node_identity_marker_is_rejected(state):
    marker = state / "node.json"
    value = json.loads(marker.read_text())
    value["identity_fingerprint"] = "changed"
    marker.write_text(json.dumps(value))
    before = fingerprints(state)
    result = invoke("card", "--state-dir", state)
    assert result.returncode == 1
    assert "identity or HTTPS certificate changed" in result.stderr
    assert fingerprints(state) == before


def test_trust_requires_separate_fingerprints_and_revokes_persistently(state, saved_nodes, tmp_path):
    card_result = invoke("card", "--state-dir", saved_nodes[1])
    assert card_result.returncode == 0
    card = json.loads(card_result.stdout)
    public = tmp_path / "primary.json"
    public.write_text(card_result.stdout)
    before = fingerprints(state)
    wrong = invoke("trust", "--state-dir", state, "--card", public, "--identity-fingerprint", "wrong", "--certificate-sha256", card["certificate_sha256"])
    assert wrong.returncode == 1
    assert fingerprints(state) == before
    correct = invoke("trust", "--state-dir", state, "--card", public, "--identity-fingerprint", card["identity_fingerprint"], "--certificate-sha256", card["certificate_sha256"])
    assert correct.returncode == 0, correct.stderr
    saved = json.loads(invoke("peers", "--state-dir", state).stdout)["peers"]
    assert saved == [{"id": card["node_id"], "name": "Primary", "status": "allowed", "grants": ["inference"]}]
    assert invoke("revoke", "--state-dir", state, "--peer-id", card["node_id"]).returncode == 0
    saved = json.loads(invoke("peers", "--state-dir", state).stdout)["peers"]
    assert saved[0]["status"] == "blocked"


def test_runtime_has_only_signed_inference_routes_and_does_not_load_host(state):
    patch = "\n".join([
        "import uvicorn, json", "def inspect(app, **kw):",
        "    assert {r.path for r in app.routes} == {'/agent/peer/inference', '/agent/peer/inference/stream'}",
        "    assert kw['host'] == '192.168.50.9' and kw['port'] == 8444",
        "    assert kw['proxy_headers'] is False and kw['access_log'] is False",
        "    assert kw['ssl_certfile'] and kw['ssl_keyfile']",
        "    assert not {'main', 'ai.ai_manager', 'routers.system_routes', 'vault_security', 'providers.lmstudio'} & set(sys.modules)",
        "uvicorn.run = inspect",
    ])
    result = invoke("run", "--state-dir", state, patch=patch)
    assert result.returncode == 0, result.stderr


def test_runtime_single_instance_guard(state):
    patch = "\n".join([
        "import uvicorn", "def inspect(app, **kw):",
        "    try:", "        with N._lock(N._root(sys.argv[sys.argv.index('--state-dir') + 1]), '.node-runtime.lock'): pass",
        "    except N.NodeError: return", "    raise AssertionError('second runtime lock accepted')",
        "uvicorn.run = inspect",
    ])
    result = invoke("run", "--state-dir", state, patch=patch)
    assert result.returncode == 0, result.stderr


def test_admin_writer_lock_prevents_a_second_mutation(state):
    before = fingerprints(state)
    patch = "\n".join([
        "guard = N._lock(N._root(sys.argv[sys.argv.index('--state-dir') + 1]), '.node-admin.lock')",
        "guard.__enter__()",
    ])
    result = invoke("revoke", "--state-dir", state, "--peer-id", "missing", patch=patch)
    assert result.returncode == 1
    assert "Another Node process owns" in result.stderr
    assert fingerprints(state) == before


@pytest.mark.parametrize("relative", ["node.json", "data", "data/tls", "data/mesh"])
def test_marker_and_required_paths_reject_windows_reparse_points_before_bootstrap(state, monkeypatch, relative):
    import tli_node as N
    original = Path.lstat
    blocked = state / relative
    def metadata(path, *args, **kwargs):
        value = original(path, *args, **kwargs)
        if path == blocked:
            return SimpleNamespace(st_mode=value.st_mode, st_file_attributes=getattr(value, "st_file_attributes", 0) | 0x400)
        return value
    monkeypatch.setattr(Path, "lstat", metadata)
    with pytest.raises(N.NodeError):
        N._read_marker(state)
