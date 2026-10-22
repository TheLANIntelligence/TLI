"""The standalone shell entry points must agree on supported Python builds.

Probe tests execute the real embedded predicate against interpreter metadata;
selection tests execute the real Bash functions with isolated candidate paths.
No host Python installation, package download or environment is modified.
"""
from collections import namedtuple
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import sysconfig

import pytest


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ("TLI_Start.sh", "TLI_Update.sh", "landing/install_mac.sh")
BASH = (Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
        if os.name == "nt" else shutil.which("bash"))
WINDOWLESS = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
VERSION = namedtuple("Version", "major minor micro releaselevel serial")


@pytest.fixture(params=SCRIPTS)
def shell_policy(request):
    source = (ROOT / request.param).read_text(encoding="utf-8")
    functions = re.search(r"(?ms)^supported_python\(\) \{.*?^\}\n\nfind_python\(\) \{.*?^\}\n", source)
    assert functions, request.param
    probe = re.search(r"-I -c '([^']+)'", functions.group())
    assert probe, request.param
    return functions.group(), probe.group(1)


@pytest.mark.parametrize("minor,level,implementation,gil_disabled,abi,accepted", [
    (10, "final", "cpython", None, "", True),
    (11, "final", "cpython", 0, "", True),
    (12, "final", "cpython", 0, "", True),
    (13, "final", "cpython", 0, "", True),
    (14, "final", "cpython", 0, "", True),
    (9, "final", "cpython", 0, "", False),
    (15, "final", "cpython", 0, "", False),
    (13, "alpha", "cpython", 0, "", False),
    (14, "beta", "cpython", 0, "", False),
    (14, "candidate", "cpython", 0, "", False),
    (13, "final", "pypy", 0, "", False),
    (13, "final", "cpython", 1, "", False),
    (14, "final", "cpython", "1", "", False),
    (13, "final", "cpython", 0, "t", False),
    (15, "alpha", "cpython", 1, "t", False),
])
def test_actual_probe_rejects_unsupported_builds(shell_policy, monkeypatch,
                                               minor, level, implementation, gil_disabled, abi, accepted):
    _, probe = shell_policy
    with monkeypatch.context() as metadata:
        metadata.setattr(sys, "version_info", VERSION(3, minor, 0, level, 0))
        metadata.setattr(sys.implementation, "name", implementation)
        metadata.setattr(sys, "abiflags", abi, raising=False)
        metadata.setattr(sysconfig, "get_config_var", lambda name: gil_disabled if name == "Py_GIL_DISABLED" else None)
        with pytest.raises(SystemExit) as exited:
            exec(compile(probe, "shell Python support probe", "exec"), {})
        assert exited.value.code == (0 if accepted else 1)


@pytest.mark.skipif(not BASH or not Path(BASH).is_file(), reason="Bash is unavailable")
@pytest.mark.parametrize("available,expected", [
    ({"python3": 1, "python3.13": 0}, "python3.13"),
    ({"python3": 1, "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13": 0},
     "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13"),
    ({"python3": 1, "/usr/local/opt/python@3.13/bin/python3.13": 0},
     "/usr/local/opt/python@3.13/bin/python3.13"),
    ({"python3": 1, "/opt/homebrew/opt/python@3.13/bin/python3.13": 0},
     "/opt/homebrew/opt/python@3.13/bin/python3.13"),
    ({"python3.13": 1, "python3.14": 0, "python3": 1}, "python3.14"),
    ({"python3.12": 0, "python3": 1}, "python3.12"),
    ({"python3": 0}, "python3"),
    ({"python3": 1}, None),
    ({}, None),
])
def test_actual_discovery_cannot_be_masked_by_generic_preview(shell_policy, tmp_path, available, expected):
    functions, _ = shell_policy
    mappings = []
    executables = {}
    for index, (candidate, status) in enumerate(available.items()):
        executable = tmp_path / f"candidate-{index}"
        executable.write_text('#!/usr/bin/env bash\n'
                              '[ "$1" = -I ] && [ "$2" = -c ] || exit 91\n'
                              f'exit {status}\n', encoding="utf-8", newline="\n")
        executable.chmod(0o755)
        executables[candidate] = executable.as_posix()
        mappings.append(f"{shlex.quote(candidate)}) printf '%s\\n' {shlex.quote(executable.as_posix())}; return 0 ;;")
    # The lookup cannot reach a real interpreter even on Homebrew/python.org CI.
    prelude = 'command() {\nif [ "$#" = 2 ] && [ "$1" = -v ]; then\ncase "$2" in\n'
    prelude += "\n".join(mappings) + '\n*) return 1 ;;\nesac\nfi\nbuiltin command "$@"\n}\n'
    result = subprocess.run([str(BASH), "--noprofile", "--norc"],
                            input=prelude + functions + "\nfind_python\n",
                            capture_output=True, text=True, encoding="utf-8", timeout=30, **WINDOWLESS)
    assert result.returncode == (0 if expected else 1), result.stdout + result.stderr
    assert result.stdout.strip() == (executables[expected] if expected else "")
