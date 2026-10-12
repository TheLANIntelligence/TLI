"""Real Windows redirectors, disposable venvs, and stdlib-only owned workers."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import psutil
import pytest

import host_control as H
import host_launcher as L
from process_utils import hidden_process_kwargs


pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows venv redirector compatibility")


def installed_python(version):
    """Inspect existing executables only; never ask a launcher to install Python."""
    compact = version.replace(".", "")
    candidates = []
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidates.extend([
            Path(local) / f"Programs/Python/Python{compact}/python.exe",
            Path(local) / f"Python/pythoncore-{version}-64/python.exe",
        ])
    programs = os.environ.get("ProgramFiles")
    if programs:
        candidates.append(Path(programs) / f"Python{compact}/python.exe")
    if f"{sys.version_info.major}.{sys.version_info.minor}" == version:
        candidates.append(Path(sys._base_executable))
    for candidate in dict.fromkeys(candidates):
        if not candidate.is_file():
            continue
        result = subprocess.run(
            [str(candidate), "-I", "-c", "import sys; print('.'.join(map(str, sys.version_info[:2])))"],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10,
            **hidden_process_kwargs(),
        )
        if result.returncode == 0 and result.stdout.strip() == version:
            return candidate
    pytest.skip(f"Python {version} is not installed at a supported local location")


WORKER = '''import json, os, sys, time
from pathlib import Path
root = Path(__file__).parent
(root / 'worker-identity.json').write_text(json.dumps({
    'pid': os.getpid(), 'executable': sys.executable,
    'base_executable': sys._base_executable, 'version': list(sys.version_info[:2]),
}))
deadline = time.monotonic() + 20
while time.monotonic() < deadline and not (root / 'stop-worker').exists():
    time.sleep(0.05)
(root / 'worker-finished').write_text('stopped by marker' if (root / 'stop-worker').exists() else 'hard deadline')
'''


@pytest.mark.parametrize("version", ["3.12", "3.13", "3.14"])
@pytest.mark.parametrize("console_fallback", [False, True], ids=["windowless", "console-fallback"])
def test_actual_venv_worker_identity_across_python_versions(tmp_path, version, console_fallback):
    executable = installed_python(version)
    root = tmp_path / "Disposable TLI installation"
    backend = root / "backend"
    backend.mkdir(parents=True)
    venv = backend / ".venv"
    subprocess.run(
        [str(executable), "-I", "-m", "venv", "--without-pip", str(venv)],
        check=True, timeout=30, stdin=subprocess.DEVNULL, capture_output=True,
        **hidden_process_kwargs(),
    )
    if console_fallback:
        # Exercise the real missing-pythonw fallback, removing only this test's
        # newly created redirector. The installed Python is never modified.
        windowless = venv / "Scripts/pythonw.exe"
        assert not windowless.is_symlink() and windowless.resolve().is_relative_to(venv.resolve())
        windowless.unlink()
    (backend / "main.py").write_text(WORKER, encoding="utf-8")
    H.installation(root, create=True)
    record = None
    worker = None
    identity = None
    try:
        record = L.spawn_fixed(root, "main.py", settings={"host": "127.0.0.1", "port": 8123, "https": False})
        deadline = time.monotonic() + 5
        identity_path = backend / "worker-identity.json"
        while time.monotonic() < deadline:
            try:
                identity = json.loads(identity_path.read_text())
                break
            except (FileNotFoundError, json.JSONDecodeError):
                time.sleep(0.02)
        assert identity is not None, "The synthetic interpreter did not report its own PID"
        worker = psutil.Process(identity["pid"])
        assert identity["version"] == [int(piece) for piece in version.split(".")]
        assert record["pid"] == identity["pid"], "Record the script's interpreter, never its venv redirector"
        assert abs(record["created_at"] - worker.create_time()) < 0.01
        assert L.matches_process(root, worker, "main.py")
        assert L.child_alive(root, record)
        assert L.pending_backend(root)
        assert L.process_generation_state(root, record) == "running"
        print(json.dumps({"python": version, "mode": "console-fallback" if console_fallback else "windowless",
                          "pid": record["pid"], "exe": worker.exe(), "argv0": worker.cmdline()[0],
                          "interpreter_recorded": True}))
    finally:
        # This marker is read only by the synthetic file above. Its independent
        # hard deadline also bounds cleanup if launch failed before returning.
        (backend / "stop-worker").write_text("End this test worker only.")
        if worker is None:
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                try:
                    identity = json.loads((backend / "worker-identity.json").read_text())
                    worker = psutil.Process(identity["pid"])
                    break
                except (FileNotFoundError, json.JSONDecodeError):
                    time.sleep(0.02)
                except psutil.NoSuchProcess:
                    break
        if worker is not None:
            worker.wait(timeout=22)
    if record is not None:
        assert (backend / "worker-finished").read_text() == "stopped by marker"
        assert not L.child_alive(root, record)
        assert L.process_generation_state(root, record) == "exited"
        deadline = time.monotonic() + 3
        while L.pending_backend(root) and time.monotonic() < deadline:
            time.sleep(0.02)
        assert not L.pending_backend(root)
