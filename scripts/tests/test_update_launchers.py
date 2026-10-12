"""Exercise local update wrappers with disposable folders and a harmless worker."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[2]
BASH = (Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
        if os.name == "nt" else shutil.which("bash"))
WINDOWLESS = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


def ps_quote(value):
    return "'" + str(value).replace("'", "''") + "'"


@pytest.fixture
def folders(tmp_path):
    source = tmp_path / "New TLI package"
    target = tmp_path / "My original TLI"
    (source / "backend").mkdir(parents=True)
    (target / "data").mkdir(parents=True)
    (target / "data/notes.json").write_bytes(b"synthetic saved data")
    (source / "TLI_RELEASE.json").write_text("{}")
    for name in ("TLI_Update.ps1", "TLI_Update.sh", "TLI_Update.command"):
        shutil.copyfile(ROOT / name, source / name)
    return source, target


@pytest.mark.skipif(os.name != "nt", reason="Windows PowerShell wrapper")
def test_windows_staged_hint_is_reviewed_before_explicit_target_invocation(folders, tmp_path):
    source, target = folders
    recorded = tmp_path / "arguments.json"
    (source / "update-target.json").write_text(json.dumps({"target": str(target)}))
    (source / "backend/update_install.py").write_text(
        "import json, os, pathlib, sys\n"
        f"pathlib.Path({str(recorded)!r}).write_text(json.dumps({{'args':sys.argv[1:], 'override':os.environ.get('TLI_ROOT')}}))\n")
    command = (
        f". {ps_quote(source / 'TLI_Update.ps1')}\n"
        f"function Find-TliUpdatePython {{ return {ps_quote(sys.executable)} }}\n"
        "function Read-Host { param([string]$Prompt); Write-Host ('REVIEW PROMPT: ' + $Prompt); return '' }\n"
        f"Invoke-TliUpdate -SourceRoot {ps_quote(source)}\n"
    )
    result = subprocess.run(["powershell.exe", "-NoProfile", "-Command", command],
                            capture_output=True, text=True, timeout=30,
                            env={**os.environ, "TLI_ROOT": "must-not-redirect-update"}, **WINDOWLESS)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Suggested existing folder:" in result.stdout
    assert "REVIEW PROMPT:" in result.stdout
    assert "type UPDATE" in result.stdout
    assert json.loads(recorded.read_text()) == {"args": ["--source", str(source), "--target", str(target)], "override": None}
    assert (target / "data/notes.json").read_bytes() == b"synthetic saved data"


@pytest.mark.skipif(os.name != "nt", reason="Windows PowerShell wrapper")
def test_windows_package_without_inventory_stops_before_python(folders):
    source, target = folders
    (source / "TLI_RELEASE.json").unlink()
    result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                             str(source / "TLI_Update.ps1"), "-Target", str(target)],
                            capture_output=True, text=True, timeout=30, **WINDOWLESS)
    assert result.returncode != 0
    assert "no update inventory" in result.stdout
    assert (target / "data/notes.json").read_bytes() == b"synthetic saved data"


@pytest.mark.skipif(not BASH or not Path(BASH).is_file(), reason="Bash is unavailable")
@pytest.mark.parametrize("worker_code", [0, 7])
def test_mac_wrapper_uses_original_venv_and_propagates_worker_result(folders, tmp_path, worker_code):
    source, target = folders
    (source / "backend/update_install.py").write_text("# harmless fixture")
    python = target / "backend/.venv/bin/python"
    python.parent.mkdir(parents=True)
    python.write_text(
        '#!/usr/bin/env bash\n'
        'if [ "$1" = "-I" ] && [ "$2" = "-c" ]; then exit 0; fi\n'
        'printf "%s\\n" "$@" > "$UPDATE_TEST_ARGUMENTS"\n'
        'exit "$UPDATE_TEST_RESULT"\n', encoding="utf-8", newline="\n")
    python.chmod(0o755)
    recorded = tmp_path / "arguments.txt"
    result = subprocess.run([str(BASH), "TLI_Update.command", target.as_posix()], cwd=source,
                            env={**os.environ, "UPDATE_TEST_ARGUMENTS": recorded.as_posix(),
                                 "UPDATE_TEST_RESULT": str(worker_code)},
                            capture_output=True, text=True, timeout=30, **WINDOWLESS)
    assert result.returncode == worker_code, result.stdout + result.stderr
    args = recorded.read_text().splitlines()
    assert args[0] == "-I" and args[1].endswith("/backend/update_install.py")
    assert args[2] == "--source" and args[4] == "--target"
    assert args[3].endswith("/New TLI package") and args[5].endswith("/My original TLI")
    assert "type UPDATE" in result.stdout
    assert ("Open TLI_Start.command" in result.stdout) is (worker_code == 0)
    assert (target / "data/notes.json").read_bytes() == b"synthetic saved data"


@pytest.mark.skipif(not BASH or not Path(BASH).is_file(), reason="Bash is unavailable")
def test_mac_missing_inventory_preserves_existing_folder(folders):
    source, target = folders
    (source / "TLI_RELEASE.json").unlink()
    result = subprocess.run([str(BASH), "TLI_Update.sh", target.as_posix()], cwd=source,
                            capture_output=True, text=True, timeout=30, **WINDOWLESS)
    assert result.returncode != 0
    assert "no update inventory" in result.stderr
    assert (target / "data/notes.json").read_bytes() == b"synthetic saved data"
