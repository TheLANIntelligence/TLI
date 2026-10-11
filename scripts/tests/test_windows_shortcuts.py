"""Exercise the real Windows shortcut functions only in synthetic directories."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


@pytest.mark.skipif(sys.platform != "win32", reason="Windows Shell shortcuts")
def test_app_shortcuts_upgrade_only_this_installation_and_preserve_collisions(tmp_path):
    setup = Path(__file__).resolve().parents[2] / "TLI_Setup.ps1"
    script = tmp_path / "check.ps1"
    script.write_text(r'''
$ErrorActionPreference = 'Stop'
$tliRoot = Join-Path $env:TLI_SHORTCUT_TEST_DIR 'TLI with spaces'
$tliPythonw = Join-Path $tliRoot 'backend\.venv\Scripts\pythonw.exe'
$tliLauncher = Join-Path $tliRoot 'backend\host_launcher.py'
$tliApp = Join-Path $tliRoot 'TLI.exe'
$tliSuffix = 'synthetic123'
New-Item -ItemType Directory -Path $tliRoot -Force | Out-Null
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:TLI_SHORTCUT_TEST_SOURCE, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Setup script did not parse.' }
$functions = $ast.FindAll({ param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -in @('Get-TliShortcutPath','New-TliShortcut') }, $true)
foreach ($function in $functions) { Invoke-Expression $function.Extent.Text }
function Folder([string]$Name) {
    $path = Join-Path $env:TLI_SHORTCUT_TEST_DIR $Name
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    return $path
}
function Read-Link([string]$Path) { return (New-Object -ComObject WScript.Shell).CreateShortcut($Path) }
$fresh = Folder 'fresh'
$first = Get-TliShortcutPath $fresh 'TLI' $tliApp ''
New-TliShortcut $first $tliApp '' 'TLI app' $tliApp 1
$link = Read-Link $first
$repeat = Get-TliShortcutPath $fresh 'TLI' $tliApp ''

$legacy = Folder 'legacy'
$legacyPath = Join-Path $legacy 'TLI.lnk'
New-TliShortcut $legacyPath $tliPythonw ('"' + $tliLauncher + '"') 'previous launcher'
$upgraded = Get-TliShortcutPath $legacy 'TLI' $tliApp ''
New-TliShortcut $upgraded $tliApp '' 'TLI app' $tliApp 1
$upgradedLink = Read-Link $legacyPath

$collisions = Folder 'collisions'
$foreignRoot = Join-Path $env:TLI_SHORTCUT_TEST_DIR 'Other TLI'
$foreignTarget = Join-Path $foreignRoot 'backend\.venv\Scripts\pythonw.exe'
$foreignArguments = '"' + (Join-Path $foreignRoot 'backend\host_launcher.py') + '"'
$foreignPath = Join-Path $collisions 'TLI.lnk'
New-TliShortcut $foreignPath $foreignTarget $foreignArguments 'other installation'
$namedCollision = Join-Path $collisions 'TLI - TLI with spaces synthetic123.lnk'
New-TliShortcut $namedCollision (Join-Path $env:SystemRoot 'notepad.exe') '' 'unrelated shortcut'
$foreignBefore = [Convert]::ToBase64String([IO.File]::ReadAllBytes($foreignPath))
$unrelatedBefore = [Convert]::ToBase64String([IO.File]::ReadAllBytes($namedCollision))
$chosen = Get-TliShortcutPath $collisions 'TLI' $tliApp ''
New-TliShortcut $chosen $tliApp '' 'TLI app' $tliApp 1
@{
    target = $link.TargetPath; arguments = $link.Arguments; icon = $link.IconLocation;
    style = $link.WindowStyle; workingDirectory = $link.WorkingDirectory;
    expectedTarget = $tliApp; expectedRoot = $tliRoot; repeated = ($first -eq $repeat);
    upgradedInPlace = ($upgraded -eq $legacyPath); upgradedTarget = $upgradedLink.TargetPath;
    collisionName = [IO.Path]::GetFileName($chosen);
    preservedForeign = ($foreignBefore -ceq [Convert]::ToBase64String([IO.File]::ReadAllBytes($foreignPath)));
    preservedUnrelated = ($unrelatedBefore -ceq [Convert]::ToBase64String([IO.File]::ReadAllBytes($namedCollision)))
} | ConvertTo-Json -Compress
''', encoding="utf-8")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script)],
        env={**os.environ, "TLI_SHORTCUT_TEST_DIR": str(tmp_path), "TLI_SHORTCUT_TEST_SOURCE": str(setup)},
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    value = json.loads(result.stdout)
    assert value["target"] == value["expectedTarget"] == value["upgradedTarget"]
    assert value["arguments"] == ""
    assert value["icon"].split(",")[0] == value["expectedTarget"]
    assert value["style"] == 1
    assert value["workingDirectory"] == value["expectedRoot"]
    assert value["repeated"] and value["upgradedInPlace"]
    assert value["collisionName"] == "TLI - TLI with spaces synthetic123 (2).lnk"
    assert value["preservedForeign"] and value["preservedUnrelated"]
