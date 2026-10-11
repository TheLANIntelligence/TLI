"""Real transport/authentication in two disposable loopback-only processes."""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import time

import psutil
import pytest

from tests.peer_transfer_https_fixture import allowed_route, clean, connection_target


def test_two_owned_https_hosts_consent_integrity_and_interruption(tmp_path):
    script = Path(__file__).with_name("peer_transfer_https_fixture.py")
    report = tmp_path / "report.json"
    result = subprocess.run([sys.executable, "-I", str(script), "--root", str(tmp_path / "hosts"),
                             "--report", str(report)], capture_output=True, text=True, timeout=100, env=clean(),
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    assert result.returncode == 0, result.stdout + result.stderr
    value = json.loads(report.read_text(encoding="utf-8"))
    assert value["status"] == "passed" and value["owned_children_stopped"]
    assert value["owned_processes"] == 2 and all(value["checks"].values())
    assert value["physical_lan"] == "not_run" and not value["production_contacted"]


def test_fixture_env_excludes_credentials_and_python_startup_overrides(monkeypatch):
    for name in ("TLI_ROOT", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "PYTHONPATH", "PYTHONSTARTUP", "HTTP_PROXY"):
        monkeypatch.setenv(name, "synthetic-should-not-be-inherited")
    environment = clean()
    assert all(value != "synthetic-should-not-be-inherited" for value in environment.values())
    assert environment["TLI_OPEN_BROWSER"] == "0"


@pytest.mark.parametrize("address", [("127.0.0.1", 8000), ("::1", 60111), ("192.168.248.10", 60112), ("example.invalid", 60111)])
def test_fixture_refuses_nonowned_sockets_without_connecting(address):
    with pytest.raises(RuntimeError):
        connection_target(address, [60111, 60112])
    assert connection_target(("192.168.248.10", 60111), [60111, 60112]) == ("127.0.0.1", 60111)
    assert connection_target(("127.0.0.1", 60112), [60111, 60112]) == ("127.0.0.1", 60112)


def test_fixture_allows_only_rehearsal_handlers():
    assert allowed_route("POST", "/agent/peer/files/chunk")
    assert allowed_route("POST", "/mesh/files/" + "ab" * 16 + "/accept")
    assert not allowed_route("GET", "/debug/selftest")
    assert not allowed_route("POST", "/system/lm_studio/test")
    assert not allowed_route("POST", "/mesh/kill_all")
    assert not allowed_route("GET", "/api/system/disk")


def test_owned_https_children_exit_after_orchestrator_is_killed(tmp_path):
    script = Path(__file__).with_name("peer_transfer_https_fixture.py")
    hosts = tmp_path / "parent-death-hosts"
    ready = hosts / "parent-death-ready.json"
    children = []
    def alive(row):
        try:
            process = psutil.Process(row["pid"])
            return process.create_time() == row["created_at"] and process.is_running() and process.status() != psutil.STATUS_ZOMBIE
        except psutil.NoSuchProcess:
            return False
    with (tmp_path / "orchestrator.log").open("w", encoding="utf-8") as stream:
        process = subprocess.Popen([sys.executable, "-I", str(script), "--root", str(hosts),
            "--report", str(tmp_path / "interrupted-report.json"), "--wait-for-parent-death"],
            stdout=stream, stderr=subprocess.STDOUT, env=clean(),
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            deadline = time.monotonic() + 45
            while not ready.exists() and time.monotonic() < deadline:
                assert process.poll() is None, "Isolated fixture exited before readiness; see orchestrator.log"
                time.sleep(.1)
            assert ready.exists(), "Two synthetic HTTPS listeners did not become ready"
            ownership = json.loads(ready.read_text(encoding="utf-8"))
            children = ownership["children"]
            assert len(children) >= 2 and all(alive(row) for row in children)
            started = time.monotonic()
            process.kill()
            process.wait(timeout=5)
            while any(alive(row) for row in children) and time.monotonic() - started < 8:
                time.sleep(.1)
            assert not any(alive(row) for row in children), "An owned child survived parent termination"
            proof = {"passed": True, "synthetic_only": True, "parent_was_killed": True,
                     "owned_processes_confirmed_stopped": len(children), "elapsed_seconds": time.monotonic()-started,
                     "source_sha256": hashlib.sha256(script.read_bytes()).hexdigest(), "physical_lan": "not_run"}
            output = Path(os.environ.get("TLI_PEER_TLS_PARENT_PROOF", tmp_path / "parent-death-proof.json"))
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(proof, indent=2)+"\n", encoding="utf-8")
        finally:
            if not children and process.poll() is None:
                children = [{"pid": child.pid, "created_at": child.create_time()} for child in psutil.Process(process.pid).children(recursive=True)]
            if process.poll() is None:
                process.kill(); process.wait(timeout=5)
            for row in reversed(children):
                if alive(row):
                    owned = psutil.Process(row["pid"])
                    owned.kill(); owned.wait(timeout=5)
