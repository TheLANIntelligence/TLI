"""Windows setup boundaries in disposable installations; no downloads or live TLI."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows PowerShell bootstrap")


def run_setup(tmp_path, source):
    script = tmp_path / "test.ps1"
    script.write_text("$ErrorActionPreference = 'Stop'\n. $env:TLI_BOOTSTRAP_SOURCE\n" + source, encoding="utf-8")
    env = dict(os.environ, TLI_BOOTSTRAP_SOURCE=str(ROOT / "TLI_Bootstrap.ps1"),
               TLI_FIXTURE_ROOT=str(tmp_path / "Synthetic TLI & app"), TLI_TEST_PYTHON=sys.executable)
    fixture = Path(env["TLI_FIXTURE_ROOT"])
    (fixture / "backend").mkdir(parents=True)
    (fixture / "backend/requirements.txt").write_text("synthetic-package==1\n")
    (fixture / "data").mkdir()
    (fixture / "data/conversations.json").write_text('{"synthetic":"preserve"}')
    shell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    result = subprocess.run([str(shell), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
                            env=env, capture_output=True, text=True, timeout=30,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    assert (fixture / "data/conversations.json").read_text() == '{"synthetic":"preserve"}'
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout


def test_interpreter_probe_accepts_supported_python_and_rejects_old_or_32_bit(tmp_path):
    output = run_setup(tmp_path, '''
if (!(Get-TliPythonInfo $env:TLI_TEST_PYTHON)) { throw 'Current interpreter was rejected' }
function OldPython { $global:LASTEXITCODE=0; @{executable=$env:TLI_TEST_PYTHON;major=3;minor=7;bits=64} | ConvertTo-Json -Compress }
function SmallPython { $global:LASTEXITCODE=0; @{executable=$env:TLI_TEST_PYTHON;major=3;minor=14;bits=32} | ConvertTo-Json -Compress }
if (Get-TliPythonInfo OldPython) { throw 'Python 3.7 was accepted' }
if (Get-TliPythonInfo SmallPython) { throw '32-bit Python was accepted' }
Write-Output 'probe boundaries passed'
''')
    assert "probe boundaries passed" in output


def test_existing_broken_environment_is_preserved_without_install_or_launch(tmp_path):
    output = run_setup(tmp_path, '''
New-Item -ItemType Directory -Path (Join-Path $env:TLI_FIXTURE_ROOT 'backend/.venv') | Out-Null
function Get-TliPythonInfo { return $null }
function Find-TliPython { throw 'Must not replace the existing environment' }
function Invoke-TliPython { throw 'Must not install or launch' }
try { Invoke-TliBootstrap $env:TLI_FIXTURE_ROOT -PrepareOnly; throw 'Unexpected success' }
catch { if (!$_.Exception.Message.Contains('were preserved')) { throw }; Write-Output 'preserved environment' }
''')
    assert "preserved environment" in output


@pytest.mark.parametrize("failure_phase", [None, "pip", "--check-runtime"])
def test_prepare_only_verifies_dependencies_before_any_backend_launch(tmp_path, failure_phase):
    source = '''
New-Item -ItemType Directory -Path (Join-Path $env:TLI_FIXTURE_ROOT 'backend/.venv') | Out-Null
$script:Calls = @()
function Get-TliPythonInfo { return @{ executable=$env:TLI_TEST_PYTHON } }
function Invoke-TliPython([string]$Python,[string[]]$Arguments) {
    $script:Calls += ,$Arguments
    if ($Arguments -contains 'FAILURE_PHASE') { throw 'Synthetic setup failure' }
}
try { Invoke-TliBootstrap $env:TLI_FIXTURE_ROOT -PrepareOnly }
catch { if (!$_.Exception.Message.Contains('Synthetic setup failure')) { throw }; Write-Output 'setup rejected' }
ConvertTo-Json -Depth 4 -Compress -InputObject $script:Calls
'''.replace("FAILURE_PHASE", failure_phase or "no-synthetic-failure")
    output = run_setup(tmp_path, source)
    calls = json.loads(output.strip().splitlines()[-1])
    assert len(calls) == (1 if failure_phase == "pip" else 3)
    assert calls[0][:4] == ["-I", "-m", "pip", "install"]
    if failure_phase != "pip":
        assert calls[1][-1] == "--check-dependencies"
        assert calls[2][-1] == "--check-runtime"
    assert all(not any(arg.endswith("main.py") for arg in call) for call in calls)
    assert ("TLI setup completed." in output) is (failure_phase is None)
    assert ("setup rejected" in output) is (failure_phase is not None)
