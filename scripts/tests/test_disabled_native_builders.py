"""Retired native builders must stop before touching an installation or running tools."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[2]


def bash_executable():
    if os.name == "nt":
        # System32/bash.exe is a WSL launcher, not an installed Bash interpreter.
        for variable in ("ProgramFiles", "ProgramFiles(x86)"):
            candidate = Path(os.environ.get(variable, "C:/Program Files")) / "Git/bin/bash.exe"
            if candidate.is_file():
                return str(candidate)
        pytest.skip("Git Bash is required for the native-builder boundary check")
    executable = shutil.which("bash")
    if executable is None:
        pytest.skip("Bash is required for the native-builder boundary check")
    return executable


@pytest.mark.parametrize("builder", ["build_mac.sh", "build_linux.sh"])
@pytest.mark.parametrize("arguments", [[], ["--install-service"]])
def test_legacy_native_builder_stops_without_side_effects(tmp_path, builder, arguments):
    bash = bash_executable()
    installation = tmp_path / "installation with spaces"
    installation.mkdir()
    script = installation / builder
    script.write_bytes((ROOT / builder).read_bytes())
    private = installation / "data" / "conversations.json"
    private.parent.mkdir()
    private.write_text('{"synthetic": "must remain unchanged"}', encoding="utf-8")
    existing_package = installation / "TLI_Installer" / "dist" / "retained.txt"
    existing_package.parent.mkdir(parents=True)
    existing_package.write_text("synthetic retained package", encoding="utf-8")

    tools = tmp_path / "sentinel-tools"
    tools.mkdir()
    calls = tmp_path / "unexpected-tool-call"
    # Any former dependency, copy, cleanup, packaging or service command is a failure.
    for name in ("python", "python3", "pip", "pip3", "pyinstaller", "curl", "wget",
                 "rm", "cp", "mkdir", "chmod", "dirname", "zip", "tar", "sudo",
                 "systemctl", "sed"):
        command = tools / name
        command.write_bytes(b'#!/bin/sh\nprintf "called\\n" >> "$TLI_BUILDER_SENTINEL"\nexit 97\n')
        command.chmod(0o755)

    def snapshot():
        return {path.relative_to(installation).as_posix(): path.read_bytes()
                for path in installation.rglob("*") if path.is_file()}

    before = snapshot()
    environment = os.environ.copy()
    for name in ("BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"):
        environment.pop(name, None)
    environment["PATH"] = str(tools)
    environment["TLI_BUILDER_SENTINEL"] = str(calls)
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    result = subprocess.run(
        [bash, "--noprofile", "--norc", str(script), *arguments],
        cwd=installation, env=environment, capture_output=True, text=True,
        timeout=10, **options,
    )
    assert result.returncode == 2, result.stderr
    assert "not validated" in result.stderr
    assert "python3 build_dist.py" in result.stderr and "README.md" in result.stderr
    assert result.stdout == ""
    assert not calls.exists(), "The disabled builder invoked an external tool"
    assert snapshot() == before, "The disabled builder changed installation files"
