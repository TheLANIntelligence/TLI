"""Developer harness tests. They never belong in the shipped backend suite."""
import json
from pathlib import Path
import sys
import subprocess

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from rehearsal_support import MARKER_TEXT, clean_environment, validate_root
from rehearsal_host import check_host


def test_unmarked_root_is_rejected_without_changes(tmp_path):
    path = tmp_path / "unmarked"
    with pytest.raises(ValueError, match="marker"):
        validate_root(path)
    assert not path.exists()


def test_phone_requires_its_distinct_marker(tmp_path):
    (tmp_path / ".tli-rehearsal").write_text(MARKER_TEXT)
    assert validate_root(tmp_path) == tmp_path
    with pytest.raises(ValueError, match="marker"):
        validate_root(tmp_path, phone=True)


@pytest.mark.parametrize("address,phone", [("0.0.0.0", False), ("192.168.1.2", False), ("127.0.0.1", True), ("8.8.8.8", True), ("0.0.0.0", True)])
def test_bind_requires_explicit_bounded_scope(address, phone):
    with pytest.raises(ValueError):
        check_host(address, phone)


def test_private_phone_bind_requires_explicit_phone_mode():
    assert check_host("192.168.1.2", True) == "192.168.1.2"
    assert check_host("127.0.0.1", False) == "127.0.0.1"


def test_inherited_launch_environment_cannot_contaminate_fixture():
    result = clean_environment({"TLI_ROOT": "private", "TLI_PORT": "8000", "TLI_OPEN_BROWSER": "1",
        "TLI_HOST": "0.0.0.0", "TLI_ENABLE_TLS": "0", "PYTHONPATH": "private", "PATH": "tools"})
    assert not any(key.startswith("TLI_") for key in result)
    assert "PYTHONPATH" not in result and result["PATH"] == "tools"


def test_actual_isolated_https_restart_and_authentication(tmp_path):
    root = tmp_path / "https-fixture"
    root.mkdir()
    (root / ".tli-rehearsal").write_text(MARKER_TEXT)
    # A fresh coordinator also works when backend conftest has disabled this
    # pytest process's HTTP clients. No guard in that process is weakened.
    completed = subprocess.run([sys.executable, str(SCRIPTS / "https_rehearsal.py"), "--code-dir", str(SCRIPTS.parent),
        "--data-root", str(root), "--report-path", str(root / "report.json")], env=clean_environment(),
        capture_output=True, text=True, timeout=100)
    assert (root / "report.json").exists(), completed.stderr
    report = json.loads((root / "report.json").read_text())
    assert report["status"] == "passed", json.dumps(report)
    assert report["owned_processes_stopped"] is True
    assert report["checks"]["saved_bearer_and_identity"]
    assert report["checks"]["bounded_request_drain_and_lifespan_cleanup"]
    assert report["checks"]["activity_review_and_restart_gap_preserved"]
    assert report["checks"]["invalid_tls_stops_without_http_fallback"]
    serialized = (root / "report.json").read_text()
    assert "tlic_" not in serialized and "739182" not in serialized
