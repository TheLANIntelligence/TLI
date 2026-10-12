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


@pytest.mark.parametrize("failure_phase", [None, "pip", "--check-dependencies", "--check-runtime"])
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
    assert len(calls) == {"pip": 1, "--check-dependencies": 2}.get(failure_phase, 3)
    assert calls[0][:4] == ["-I", "-m", "pip", "install"]
    if failure_phase != "pip":
        assert calls[1][-1] == "--check-dependencies"
    if failure_phase not in {"pip", "--check-dependencies"}:
        assert calls[2][-1] == "--check-runtime"
    assert all(not any(arg.endswith("main.py") for arg in call) for call in calls)
    fatal = failure_phase in {"pip", "--check-dependencies"}
    assert ("TLI setup completed." in output) is not fatal
    assert ("setup rejected" in output) is fatal
    assert ("Local AI needs attention" in output) is (failure_phase == "--check-runtime")


@pytest.mark.parametrize("failure_phase", [None, "launch_checks.py", "main.py"])
def test_optional_runtime_warning_continues_to_app_but_required_launch_failures_still_stop(tmp_path, failure_phase):
    source = '''
New-Item -ItemType Directory -Path (Join-Path $env:TLI_FIXTURE_ROOT 'backend/.venv') | Out-Null
$script:Calls = @()
function Get-TliPythonInfo { return @{ executable=$env:TLI_TEST_PYTHON } }
function Find-TliPython { throw 'Must not install or replace Python' }
function Invoke-TliPython([string]$Python,[string[]]$Arguments) {
    $script:Calls += ,$Arguments
    if ($Arguments -contains '--check-runtime') { throw 'Synthetic optional runtime failure' }
    if ([IO.Path]::GetFileName($Arguments[0]) -eq 'FAILURE_PHASE') { throw 'Synthetic required launch failure' }
}
try { Invoke-TliBootstrap $env:TLI_FIXTURE_ROOT; Write-Output 'app launch completed' }
catch { if (!$_.Exception.Message.Contains('Synthetic required launch failure')) { throw }; Write-Output 'required launch rejected' }
ConvertTo-Json -Depth 4 -Compress -InputObject $script:Calls
'''.replace("FAILURE_PHASE", failure_phase or "no-synthetic-failure")
    output = run_setup(tmp_path, source)
    calls = json.loads(output.strip().splitlines()[-1])
    assert len(calls) == (4 if failure_phase == "launch_checks.py" else 5)
    assert calls[1][-1] == "--check-dependencies"
    assert calls[2][-1] == "--check-runtime"
    assert Path(calls[3][0]).name == "launch_checks.py"
    if failure_phase != "launch_checks.py":
        assert Path(calls[4][0]).name == "main.py"
    # PowerShell wraps warning text to the host width even in captured output.
    warning_text = " ".join(output.split())
    assert "Local AI needs attention" in warning_text
    assert "TLI setup will continue" in warning_text
    assert "does not identify the exact cause" in warning_text
    assert "https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist/" in warning_text
    assert "repair the x64 package" in warning_text
    assert ("app launch completed" in output) is (failure_phase is None)
    assert ("required launch rejected" in output) is (failure_phase is not None)


@pytest.mark.parametrize('bundled,present,install_fails', [(False, False, False), (True, True, False), (True, False, False), (True, False, True)])
def test_prerequisite_setup_only_runs_for_bundled_ai_with_missing_dlls(tmp_path, bundled, present, install_fails):
    source = '''
$script:Installs = 0
if (BUNDLED) {
    $runtime = Join-Path $env:TLI_FIXTURE_ROOT 'backend/ai/runtime'
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $runtime 'llama_server.exe') -Value 'synthetic, never executed'
}
function Test-TliVCRuntime { return PRESENT }
function Install-TliVCRuntime {
    $script:Installs++
    if (FAILS) { throw 'Synthetic offline installer failure' }
}
Initialize-TliLocalAIRuntime $env:TLI_FIXTURE_ROOT
Write-Output "workspace continues; installs=$script:Installs"
'''.replace('BUNDLED', '$true' if bundled else '$false').replace('PRESENT', '$true' if present else '$false').replace('FAILS', '$true' if install_fails else '$false')
    output = run_setup(tmp_path, source)
    assert f'workspace continues; installs={int(bundled and not present)}' in output
    assert ('Local AI prerequisites need attention' in output) == install_fails


@pytest.mark.parametrize('outcome', ['ok', 'reboot', 'newer', 'cancelled', 'untrusted', 'wrong-publisher', 'offline', 'timeout'])
def test_microsoft_prerequisite_download_signature_and_install_boundaries(tmp_path, outcome):
    source = '''
$script:Outcome = 'OUTCOME'
$script:Downloads = 0; $script:Starts = 0; $script:Downloaded = $null
function Invoke-WebRequest($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec) {
    if ($Uri -ne 'https://aka.ms/vc14/vc_redist.x64.exe' -or !$UseBasicParsing -or $TimeoutSec -ne 120) { throw 'Unexpected download boundary' }
    $script:Downloads++; $script:Downloaded = $OutFile
    if ($script:Outcome -eq 'offline') { throw 'Synthetic offline download' }
    Set-Content -LiteralPath $OutFile -Value 'Synthetic installer; never execute'
}
function Get-AuthenticodeSignature($LiteralPath) {
    if ($LiteralPath -ne $script:Downloaded) { throw 'Signature checked a different file' }
    return @{ Status = $(if ($script:Outcome -eq 'untrusted') { 'HashMismatch' } else { 'Valid' });
              SignerCertificate = @{ Subject = $(if ($script:Outcome -eq 'wrong-publisher') { 'CN=Other Corporation, O=Other' } else { 'CN=Microsoft Corporation, O=Microsoft Corporation, C=US' }) } }
}
function Start-Process($FilePath, $ArgumentList, $WindowStyle, [switch]$PassThru) {
    if ($FilePath -ne $script:Downloaded -or ($ArgumentList -join ' ') -ne '/install /quiet /norestart' -or $WindowStyle -ne 'Hidden' -or !$PassThru) { throw 'Unexpected installer boundary' }
    $script:Starts++
    $code = switch ($script:Outcome) { 'reboot' { 3010 }; 'newer' { 1638 }; 'cancelled' { 1602 }; default { 0 } }
    $process = [pscustomobject]@{ ExitCode = $code }
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
        param($milliseconds)
        if ($milliseconds -ne 300000) { throw 'Installer wait was not bounded' }
        return $script:Outcome -ne 'timeout'
    }
    $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
    return $process
}
try { Install-TliVCRuntime; Write-Output 'prerequisite completed' }
catch { Write-Output ('prerequisite failed: ' + $_.Exception.Message) }
$retained = Test-Path -LiteralPath $script:Downloaded
# Test-created files only. Production intentionally retains a running installer's source.
if ($retained) { Remove-Item -LiteralPath $script:Downloaded; Remove-Item -LiteralPath (Split-Path -Parent $script:Downloaded) }
@{ downloads=$script:Downloads; starts=$script:Starts; retained=$retained } | ConvertTo-Json -Compress
'''.replace('OUTCOME', outcome)
    output = run_setup(tmp_path, source)
    report = json.loads(output.strip().splitlines()[-1])
    assert report['downloads'] == 1
    assert report['starts'] == int(outcome not in {'untrusted', 'wrong-publisher', 'offline'})
    assert report['retained'] == (outcome == 'timeout')
    assert ('prerequisite completed' in output) == (outcome in {'ok', 'reboot', 'newer'})
    if outcome == 'reboot':
        assert 'will not restart your computer' in ' '.join(output.split())
    if outcome == 'cancelled':
        assert 'exit 1602' in output
    if outcome in {'untrusted', 'wrong-publisher'}:
        assert 'could not be verified. It was not run.' in output


def test_native_dll_detection_checks_all_required_runtime_files(tmp_path):
    output = run_setup(tmp_path, '''
$script:Probes = @(); $script:Missing = $null
function Test-Path($LiteralPath, $PathType) {
    $script:Probes += [IO.Path]::GetFileName($LiteralPath)
    if ($PathType -ne 'Leaf') { throw 'Only files may satisfy runtime detection' }
    return [IO.Path]::GetFileName($LiteralPath) -ne $script:Missing
}
if (!(Test-TliVCRuntime)) { throw 'Complete runtime was rejected' }
foreach ($file in @('vcruntime140.dll','vcruntime140_1.dll','msvcp140.dll')) {
    $script:Missing = $file
    if (Test-TliVCRuntime) { throw 'Incomplete runtime was accepted' }
}
Write-Output 'native DLL boundaries passed'
''')
    assert 'native DLL boundaries passed' in output
