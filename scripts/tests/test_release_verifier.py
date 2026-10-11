"""Verifier boundaries use synthetic bytes and do not import the application."""
import importlib.util
import io
import os
import subprocess
import sys
from pathlib import Path
import zipfile
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location("beta_verifier", Path(__file__).resolve().parents[1] / "verify_release.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


def test_invoking_startup_and_persistence_environment_cannot_choose_fixture_destination():
    env = verifier.clean_environment({"PATH": "tools", "SYSTEMROOT": "system", "TLI_ROOT": "live",
        "TLI_HOST": "0.0.0.0", "TLI_PORT": "8000", "TLI_ENABLE_TLS": "0", "tli_open_browser": "1",
        "TLI_MODEL_PATH": "live/model", "PYTHONPATH": "live/python", "PYTHONHOME": "live/python",
        "PYTEST_ADDOPTS": "--ignore=all", "UVICORN_HOST": "0.0.0.0", "UVICORN_PORT": "8000"})
    assert env["PATH"] == "tools" and env["SYSTEMROOT"] == "system"
    assert {key: value for key, value in env.items() if key.upper().startswith("TLI_")} == {"TLI_OPEN_BROWSER": "0"}
    assert not set(env) & {"PYTHONPATH", "PYTHONHOME", "PYTEST_ADDOPTS", "UVICORN_HOST", "UVICORN_PORT"}


@pytest.mark.parametrize("name", ["../escape.txt", "/absolute.txt", "C:/escape.txt", "..\\escape.txt", "backend/private.key"])
def test_archive_rejection_happens_before_any_extraction(tmp_path, name):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        archive.writestr("backend/main.py", "safe")
        archive.writestr(name, "never extract")
    with zipfile.ZipFile(data) as archive, pytest.raises(RuntimeError):
        verifier.safe_extract(archive, tmp_path, lambda path: path.suffix != ".key")
    assert list(tmp_path.iterdir()) == []


def test_archive_links_are_rejected_without_reading_targets(tmp_path):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        item = zipfile.ZipInfo("backend/link")
        item.create_system = 3
        item.external_attr = 0o120777 << 16
        archive.writestr(item, "../../private")
    with zipfile.ZipFile(data) as archive, pytest.raises(RuntimeError, match="Linked"):
        verifier.safe_extract(archive, tmp_path, lambda path: True)
    assert list(tmp_path.iterdir()) == []


def test_historical_private_blobs_are_filtered_before_git_reads_their_contents(tmp_path, monkeypatch):
    public, private = b"a" * 40, b"b" * 40
    tree = b"100644 blob " + public + b"\tbackend/main.py\0" + b"100644 blob " + private + b"\tbackend/ai/memory/arbitrary.json\0"
    monkeypatch.setattr(verifier.subprocess, "check_output", lambda *a, **kw: tree)
    def batch(command, **kwargs):
        assert command == ["git", "cat-file", "--batch"]
        assert kwargs["input"] == public + b"\n"
        return SimpleNamespace(stdout=public + b" blob 4\ncode\n")
    monkeypatch.setattr(verifier.subprocess, "run", batch)
    assert verifier.extract_git_baseline(tmp_path, "revision", tmp_path, lambda path: "memory" not in path.parts) == 1
    assert (tmp_path / "backend/main.py").read_bytes() == b"code"
    assert not (tmp_path / "backend/ai/memory").exists()


def test_dependency_installation_cannot_inherit_external_install_destinations():
    env = verifier.clean_environment({"PIP_TARGET": "live", "pip_prefix": "live", "PIP_USER": "1",
        "PIP_ROOT": "live", "PYTHONUSERBASE": "live", "PIP_CONFIG_FILE": "live.ini",
        "NPM_CONFIG_PREFIX": "live", "NPM_CONFIG_GLOBAL": "true", "NPM_CONFIG_USERCONFIG": "live.npmrc",
        "NODE_OPTIONS": "--require live.js"})
    assert not {name.upper() for name in env} & {"PIP_TARGET", "PIP_PREFIX", "PIP_USER", "PIP_ROOT", "PYTHONUSERBASE", "NPM_CONFIG_PREFIX", "NODE_OPTIONS"}
    assert env["PIP_CONFIG_FILE"] == env["NPM_CONFIG_USERCONFIG"] == os.devnull
    assert env["NPM_CONFIG_GLOBAL"] == "false" and env["PYTHONNOUSERSITE"] == "1"


def test_exact_packaging_exclusion_survives_collection_changing_working_directory(tmp_path):
    extracted = tmp_path / "installation"
    tests = extracted / "backend/tests"
    tests.mkdir(parents=True)
    isolated = tmp_path / "isolated-data"
    isolated.mkdir()
    (tests / "conftest.py").write_text("import os\nos.chdir(" + repr(str(isolated)) + ")\n")
    (tests / "test_release_packaging.py").write_text("raise RuntimeError('developer-only test must not collect')\n")
    (tests / "test_runtime.py").write_text("def test_runtime():\n    assert True\n")
    result = subprocess.run(verifier.extracted_test_command(sys.executable, extracted), cwd=extracted,
                            env=verifier.clean_environment(), capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "1 passed" in result.stdout
