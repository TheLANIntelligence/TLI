"""Exercise setup registration in PowerShell with every write replaced by a recorder."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

import process_utils


ROOT = Path(__file__).resolve().parents[2]
POWERSHELL = shutil.which("powershell.exe")
pytestmark = pytest.mark.skipif(sys.platform != "win32" or not POWERSHELL, reason="Windows PowerShell required")


def _setup_records(tmp_path, action, *, native=True):
    installation = tmp_path / "TLI O'Brien & [trial]"
    (installation / "backend").mkdir(parents=True)
    (installation / "backend/tli_state.py").write_text('TLI_VERSION = "1.4.0-beta"\n', encoding="utf-8")
    (installation / "TLI.exe").write_text("synthetic launcher", encoding="utf-8")
    if native:
        (installation / "TLI_Uninstall.ps1").write_text("# synthetic native entry", encoding="utf-8")
    harness = tmp_path / "registration-probe.ps1"
    harness.write_text(r'''
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:TLI_SETUP_TEST_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$quotedRoot = "'" + $env:TLI_SETUP_TEST_ROOT.Replace("'", "''") + "'"
# Evaluate only declarations and initialization, never the real action/menu.
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.IfStatementAst]) { break }
    Invoke-Expression ($statement.Extent.Text.Replace('$PSScriptRoot', $quotedRoot))
}
$script:records = @()
function New-Item { param($Path, $ItemType, [switch]$Force)
    $script:records += @{ operation='item'; path=$Path; type=$ItemType }
}
function New-ItemProperty { param($LiteralPath, $Name, $Value, $PropertyType, [switch]$Force)
    $script:records += @{ operation='property'; path=$LiteralPath; name=$Name; value=$Value; type=$PropertyType }
}
function Get-TliShortcutPath { param($Directory, $Name, $Target, $Arguments)
    return Join-Path $Directory ($Name + '.lnk')
}
function New-TliShortcut { param($Path, $Target, $Arguments, $Description, $Icon, $WindowStyle)
    $script:records += @{ operation='shortcut'; path=$Path; target=$Target; arguments=$Arguments; description=$Description }
}
try {
    Invoke-TliSetup $env:TLI_SETUP_TEST_ACTION | Out-Null
    $result = @{ records=$script:records; suffix=$tliSuffix; error=$null }
} catch {
    $result = @{ records=$script:records; suffix=$tliSuffix; error=$_.Exception.Message }
}
$result | ConvertTo-Json -Depth 8 -Compress
''', encoding="utf-8-sig")
    env = {**os.environ, "TLI_SETUP_TEST_SOURCE": str(ROOT / "TLI_Setup.ps1"),
           "TLI_SETUP_TEST_ROOT": str(installation), "TLI_SETUP_TEST_ACTION": action}
    result = subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(harness)],
                            capture_output=True, text=True, timeout=30, env=env,
                            **process_utils.hidden_process_kwargs())
    assert result.returncode == 0, result.stderr
    # Setup's status is written to the host; JSON is the final output line.
    return installation, json.loads(result.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("action,shortcut_count", [("RegisterUninstall", 1), ("CreateShortcuts", 3)])
def test_setup_registers_exact_installation_and_interactive_removal(tmp_path, action, shortcut_count):
    installation, result = _setup_records(tmp_path, action)
    assert result["error"] is None
    expected_suffix = hashlib.sha256(str(installation).lower().encode()).hexdigest()[:12].upper()
    assert result["suffix"] == expected_suffix
    properties = [record for record in result["records"] if record["operation"] == "property"]
    expected_key = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TLI-" + expected_suffix
    assert {record["path"] for record in properties} == {expected_key}
    values = {record["name"]: record["value"] for record in properties}
    assert values["InstallLocation"] == str(installation)
    assert values["DisplayName"] == f"TLI - {installation.name} ({expected_suffix})"
    assert values["DisplayVersion"] == "1.4.0-beta"
    assert values["NoModify"] == values["NoRepair"] == 1
    assert "QuietUninstallString" not in values
    shortcuts = [record for record in result["records"] if record["operation"] == "shortcut"]
    assert len(shortcuts) == shortcut_count
    shortcut = next(record for record in shortcuts if "Uninstall TLI" in record["path"])
    expected_arguments = '-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + str(installation / "TLI_Uninstall.ps1") + '"'
    assert shortcut["arguments"] == expected_arguments
    assert values["UninstallString"] == '"' + shortcut["target"] + '" ' + expected_arguments
    assert str(installation) in shortcut["description"]


def test_missing_native_entry_creates_no_registration_or_shortcut(tmp_path):
    _, result = _setup_records(tmp_path, "RegisterUninstall", native=False)
    assert "TLI_Uninstall.ps1 is missing" in result["error"]
    assert result["records"] == []


def test_separate_installations_get_separate_windows_entries(tmp_path):
    _, first = _setup_records(tmp_path / "first", "RegisterUninstall")
    _, second = _setup_records(tmp_path / "second", "RegisterUninstall")
    assert first["error"] is None and second["error"] is None
    assert first["suffix"] != second["suffix"]
