"""Execute native removal only inside disposable fixtures; never alter live entries."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows native uninstaller")


def run_fixture(tmp_path, body, *, fixture_name="TLI fixture & [files]"):
    fixture = tmp_path / fixture_name
    for directory in ("backend", "frontend", "data/vault", "models"):
        (fixture / directory).mkdir(parents=True, exist_ok=True)
    (fixture / "backend/main.py").write_text("# synthetic, never executed\n")
    (fixture / "frontend/index.html").write_text("<p>fixture</p>")
    (fixture / "data/vault/precious.txt").write_text("preserve synthetic user data")
    (fixture / "models/synthetic.gguf").write_bytes(b"model fixture")
    shutil.copyfile(ROOT / "TLI_Uninstall.ps1", fixture / "TLI_Uninstall.ps1")
    harness = tmp_path / "harness.ps1"
    harness.write_text(r'''
$ErrorActionPreference = 'Stop'
. $env:TLI_UNINSTALL_SOURCE
$root = $env:TLI_UNINSTALL_FIXTURE
$links = Join-Path $env:TLI_UNINSTALL_TEST_DIR 'links'
New-Item -ItemType Directory -Path $links | Out-Null
function Get-TliRemovalShortcutDirectories { return @($links) }
function Test-TliRemovalRegistration { return $false }
function Get-TliRemovalProcesses { return @() }
''' + body, encoding="utf-8")
    env = dict(os.environ, TLI_UNINSTALL_SOURCE=str(ROOT / "TLI_Uninstall.ps1"),
               TLI_UNINSTALL_FIXTURE=str(fixture), TLI_UNINSTALL_TEST_DIR=str(tmp_path))
    powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    result = subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(harness)],
                            env=env, capture_output=True, text=True, timeout=45,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    assert result.returncode == 0, result.stdout + result.stderr
    return fixture, json.loads(result.stdout)


def test_plan_is_read_only_and_key_is_installation_scoped(tmp_path):
    fixture, value = run_fixture(tmp_path, r'''
$before = (Get-ChildItem -LiteralPath $root -File -Recurse | ForEach-Object { $_.FullName + ':' + [Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName)) }) -join '|'
$review = Get-TliRemovalPlan $root
$after = (Get-ChildItem -LiteralPath $root -File -Recurse | ForEach-Object { $_.FullName + ':' + [Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName)) }) -join '|'
@{ plan = $review; unchanged = ($before -ceq $after); key = (Get-TliRemovalKey $root) } | ConvertTo-Json -Depth 6 -Compress
''')
    assert value["unchanged"]
    assert value["plan"]["root"] == str(fixture)
    assert value["plan"]["completeRemovalBlockers"] == []
    suffix = hashlib.sha256(str(fixture).lower().encode()).hexdigest()[:12].upper()
    assert value["key"].endswith("TLI-" + suffix)
    assert (fixture / "data/vault/precious.txt").exists()


def test_keep_files_removes_only_matching_shortcuts(tmp_path):
    fixture, value = run_fixture(tmp_path, r'''
$shell = New-Object -ComObject WScript.Shell
function Link([string]$Name, [string]$Target, [string]$Arguments = '') {
    $path = Join-Path $links $Name
    $link = $shell.CreateShortcut($path); $link.TargetPath = $Target; $link.Arguments = $Arguments; $link.Save(); return $path
}
$app = Link 'TLI.lnk' (Join-Path $root 'TLI.exe')
$helper = Link 'TLI Host Start.lnk' (Join-Path $root 'backend\.venv\Scripts\pythonw.exe') ('"' + (Join-Path $root 'backend\host_control_server.py') + '"')
$foreign = Link 'TLI foreign.lnk' (Join-Path ($root + ' sibling') 'TLI.exe')
$unrelated = Link 'TLI Setup.lnk' (Join-Path $env:SystemRoot 'notepad.exe')
$uninstaller = Link 'Uninstall TLI.lnk' (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') ('-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $root 'TLI_Uninstall.ps1') + '"')
$shortcuts = @(Get-TliRemovalShortcuts $root)
Invoke-TliRemoval $root KeepFiles '' $shortcuts
@{ matched = $shortcuts.Count; keptForeign = (Test-Path -LiteralPath $foreign); keptUnrelated = (Test-Path -LiteralPath $unrelated); removedApp = !(Test-Path -LiteralPath $app); removedHelper = !(Test-Path -LiteralPath $helper); removedUninstaller = !(Test-Path -LiteralPath $uninstaller) } | ConvertTo-Json -Compress
''')
    assert value == {"matched": 3, "keptForeign": True, "keptUnrelated": True, "removedApp": True, "removedHelper": True, "removedUninstaller": True}
    assert (fixture / "data/vault/precious.txt").read_text() == "preserve synthetic user data"
    assert (fixture / "models/synthetic.gguf").read_bytes() == b"model fixture"
    assert (fixture / "TLI_Uninstall.ps1").exists()


def test_complete_removal_deletes_only_reviewed_fixture(tmp_path):
    fixture, value = run_fixture(tmp_path, r'''
$sibling = $root + ' sibling'
New-Item -ItemType Directory -Path $sibling | Out-Null
Set-Content -LiteralPath (Join-Path $sibling 'precious.txt') -Value 'outside preserved'
Set-Location -LiteralPath $root
[Environment]::CurrentDirectory = $root
Invoke-TliRemoval $root Everything 'DELETE' @()
@{ removed = !(Test-Path -LiteralPath $root); outside = [string](Get-Content -LiteralPath (Join-Path $sibling 'precious.txt')); directory = [Environment]::CurrentDirectory } | ConvertTo-Json -Compress
''')
    assert value["removed"] and not fixture.exists()
    assert value["outside"] == "outside preserved"
    assert Path(value["directory"]) != fixture


@pytest.mark.parametrize("refusal", ["confirmation", "source", "process", "lock", "unsafe", "escape"])
def test_refusal_happens_before_any_fixture_file_is_removed(tmp_path, refusal):
    setups = {
        "confirmation": "$operation = { Invoke-TliRemoval $root Everything 'delete' @() }; $expected = 'typing DELETE'",
        "source": "New-Item -ItemType Directory -Path (Join-Path $root '.git') | Out-Null; $operation = { Invoke-TliRemoval $root Everything 'DELETE' @() }; $expected = 'source checkout'",
        "process": "function Get-TliRemovalProcesses { return @([pscustomobject]@{pid=1234;name='synthetic';reason='test'}) }; $operation = { Invoke-TliRemoval $root Everything 'DELETE' @() }; $expected = 'Close TLI'",
        "lock": "New-Item -ItemType Directory -Path (Join-Path $root 'data/host_control') | Out-Null; $held = [IO.File]::Open((Join-Path $root 'data/host_control/helper.lock'), 'Create', 'ReadWrite', 'None'); $operation = { Invoke-TliRemoval $root Everything 'DELETE' @() }; $expected = 'installation lock'",
        "unsafe": "$operation = { Get-TliRemovalRoot $env:USERPROFILE }; $expected = 'standard user folder'",
        "escape": "$operation = { Assert-TliRemovalChild $root ($root + ' sibling\\precious.txt') }; $expected = 'escaped'",
    }
    fixture, value = run_fixture(tmp_path, setups[refusal] + r'''
$blocked = $false
try { & $operation } catch { if (!$_.Exception.Message.Contains($expected)) { throw }; $blocked = $true }
if ($held) { $held.Dispose() }
@{ blocked = $blocked; kept = (Test-Path -LiteralPath (Join-Path $root 'data/vault/precious.txt')) } | ConvertTo-Json -Compress
''')
    assert value == {"blocked": True, "kept": True}
    assert (fixture / "TLI_Uninstall.ps1").exists()


def test_junction_is_refused_without_following_it(tmp_path):
    fixture, value = run_fixture(tmp_path, r'''
$outside = Join-Path $env:TLI_UNINSTALL_TEST_DIR 'outside'
New-Item -ItemType Directory -Path $outside | Out-Null
Set-Content -LiteralPath (Join-Path $outside 'precious.txt') -Value 'outside preserved'
$junction = Join-Path $root 'external-models'
New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
$blocked = $false
try { Invoke-TliRemoval $root Everything 'DELETE' @() } catch { if (!$_.Exception.Message.Contains('Linked folders')) { throw }; $blocked = $true }
@{ blocked = $blocked; outside = [string](Get-Content -LiteralPath (Join-Path $outside 'precious.txt')); kept = (Test-Path -LiteralPath (Join-Path $root 'models/synthetic.gguf')) } | ConvertTo-Json -Compress
''')
    assert value == {"blocked": True, "outside": "outside preserved", "kept": True}
    assert fixture.exists()


def test_process_matching_does_not_confuse_other_instances_or_itself(tmp_path):
    _, value = run_fixture(tmp_path, r'''
# Reload original function, then substitute only the read-only process provider.
. $env:TLI_UNINSTALL_SOURCE
function Get-CimInstance {
    return @(
        [pscustomobject]@{ProcessId=$PID; Name='powershell.exe'; ExecutablePath='C:\Windows\powershell.exe'; CommandLine=('powershell -File "' + $root + '\TLI_Uninstall.ps1"')},
        [pscustomobject]@{ProcessId=101; Name='TLI.exe'; ExecutablePath=($root + '\TLI.exe'); CommandLine=''},
        [pscustomobject]@{ProcessId=102; Name='pythonw.exe'; ExecutablePath='C:\Python\pythonw.exe'; CommandLine=('python "' + $root + '\backend\main.py"')},
        [pscustomobject]@{ProcessId=103; Name='TLI.exe'; ExecutablePath=($root + ' sibling\TLI.exe'); CommandLine=('"' + $root + ' sibling\TLI.exe"')},
        [pscustomobject]@{ProcessId=104; Name='python.exe'; ExecutablePath='C:\Python\python.exe'; CommandLine='python main.py'},
        [pscustomobject]@{ProcessId=105; Name='pythonw.exe'; ExecutablePath=$null; CommandLine=$null},
        [pscustomobject]@{ProcessId=106; Name='python.exe'; ExecutablePath='C:\Python\python.exe'; CommandLine='python backend\main.py'},
        [pscustomobject]@{ProcessId=107; Name='python.exe'; ExecutablePath='C:\Python\python.exe'; CommandLine='python -m uvicorn main:app'},
        [pscustomobject]@{ProcessId=108; Name='llama_server.exe'; ExecutablePath=$null; CommandLine=$null}
    )
}
@(Get-TliRemovalProcesses $root | ForEach-Object { $_.pid }) | ConvertTo-Json -Compress
''')
    assert value == [101, 102, 104, 105, 106, 107, 108]


@pytest.mark.parametrize("registration", ["matching", "different_installation", "unexpected_subkey"])
def test_full_removal_cleans_owned_shortcut_and_scoped_mock_registration(tmp_path, registration):
    fixture, value = run_fixture(tmp_path, r'''
# Restore the production registration reader and mock registry access at the
# provider boundary. No command in this harness can write to live HKCU.
. $env:TLI_UNINSTALL_SOURCE
function Get-TliRemovalShortcutDirectories { return @($links) }
function Get-TliRemovalProcesses { return @() }
$registry = Get-TliRemovalKey $root
$script:registryExists = $true
$script:registryRemoved = $false
$script:registryLocation = $root
$script:registryChildren = @()
function Test-Path([string]$LiteralPath, [string]$PathType) {
    if ($LiteralPath -eq $registry) { return $script:registryExists }
    return Microsoft.PowerShell.Management\Test-Path @PSBoundParameters
}
function Get-ItemProperty([string]$LiteralPath) {
    if ($LiteralPath -ne $registry) { throw 'Unexpected registry read' }
    return [pscustomobject]@{InstallLocation=$script:registryLocation}
}
function Get-ChildItem([string]$LiteralPath, [switch]$Force, [switch]$File, [string]$Filter) {
    if ($LiteralPath -eq $registry) { return $script:registryChildren }
    return Microsoft.PowerShell.Management\Get-ChildItem @PSBoundParameters
}
function Remove-Item([string]$LiteralPath, [switch]$Force) {
    if ($LiteralPath -eq $registry) { $script:registryExists=$false; $script:registryRemoved=$true; return }
    if (!$LiteralPath.StartsWith($root + '\') -and !$LiteralPath.StartsWith($links + '\')) { throw 'Test refused removal outside its fixture' }
    Microsoft.PowerShell.Management\Remove-Item @PSBoundParameters
}
if ('REGISTRATION_CASE' -eq 'different_installation') { $script:registryLocation = $root + ' sibling' }
if ('REGISTRATION_CASE' -eq 'unexpected_subkey') { $script:registryChildren = @('preserve') }
$shortcutPath = Join-Path $links 'TLI.lnk'
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $root 'TLI.exe'
$shortcut.Save()
$reviewed = @(Get-TliRemovalShortcuts $root)
$blocked = $false
try { Invoke-TliRemoval $root Everything 'DELETE' $reviewed }
catch { if ('REGISTRATION_CASE' -ne 'unexpected_subkey' -or !$_.Exception.Message.Contains('unexpected subkeys')) { throw }; $blocked = $true }
@{ rootRemoved = !(Test-Path -LiteralPath $root); shortcutRemoved = !(Test-Path -LiteralPath $shortcutPath); registrationRemoved = $script:registryRemoved; registryRetained = $script:registryExists; blocked = $blocked } | ConvertTo-Json -Compress
'''.replace("REGISTRATION_CASE", registration))
    assert value["rootRemoved"] and not fixture.exists()
    assert value["shortcutRemoved"]
    assert value["registrationRemoved"] is (registration == "matching")
    assert value["registryRetained"] is (registration != "matching")
    assert value["blocked"] is (registration == "unexpected_subkey")
