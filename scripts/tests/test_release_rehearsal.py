"""Exercise the real rehearsal stages only against owned synthetic data."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rehearsal_support import clean_environment


REPO = Path(__file__).resolve().parents[2]


def test_current_rehearsal_preserves_data_with_real_browser_session(tmp_path):
    root = tmp_path / "synthetic-installation"
    root.mkdir()
    (root / ".tli-rehearsal").write_text("synthetic test data only", encoding="utf-8")
    backup = tmp_path / "synthetic-backup"
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}

    def run(stage, target=root):
        result = subprocess.run(
            [sys.executable, str(REPO / "scripts/release_rehearsal.py"),
             "--code-dir", str(REPO), "--data-root", str(target), "--stage", stage],
            cwd=tmp_path, env=clean_environment(), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=90, **options)
        assert result.returncode == 0, (result.stdout + result.stderr)[-12000:]
        records = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{"stage":')]
        assert len(records) == 1
        report = records[0]
        assert report["passed"] and report["live_device_calls"] == 0
        assert "Real synthetic PIN/browser session" in report["authentication_scope"]

    run("seed")
    shutil.copytree(root, backup)
    for stage in ("upgrade", "rollback", "return"):
        run(stage)
    run("restore", backup)
