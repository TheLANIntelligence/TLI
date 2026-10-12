"""Exercise only extracted pure receipt/claim functions against a temp directory.

Never execute the helper entrypoint, elevate, import NetSecurity or touch Windows
firewall policy. This verifies the actual PowerShell finalization code, not a
Python imitation of its cross-process file ownership rules.
"""
import os
from pathlib import Path
import subprocess

import pytest

import host_control as H
import network_setup as N
from process_utils import hidden_process_kwargs


@pytest.mark.skipif(os.name != 'nt', reason='PowerShell receipt semantics are Windows-specific')
def test_competing_requesters_cannot_finalize_apply_and_final_receipt_is_immutable(tmp_path):
    root = tmp_path / 'installation'
    root.mkdir()
    H.installation(root, create=True)
    source = Path(__file__).resolve().parents[2] / 'TLI_Network_Setup.ps1'
    harness = tmp_path / 'receipt-functions-only.ps1'
    harness.write_text(r'''
param([string]$Source,[string]$FixtureRoot)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Helper syntax failed'}
$allowed=@('Assert-TliPath','Read-TliJson','Get-TliSignedEnvelope','Enter-TliDecision','New-TliApplyClaim','Write-TliResult')
foreach($function in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){
  if($function.Name -in $allowed){. ([ScriptBlock]::Create($function.Extent.Text))}
}
$tliRoot=[IO.Path]::GetFullPath($FixtureRoot)
$tliState=Join-Path $tliRoot 'data\host_control'
$RequestId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$tliClaim=Join-Path $tliState "network-firewall-$RequestId-claim"
$tliClaimValue='synthetic-owner-claim'
$tliClaimBytes=[Text.Encoding]::UTF8.GetBytes($tliClaimValue)
$tliOwnsApply=$false;$tliOwnsRequest=$true
$tliLaunchClaim=Join-Path $tliState "network-firewall-$RequestId-launch"
$tliLaunchValue='synthetic-request-owner'
[IO.File]::WriteAllText($tliLaunchClaim,$tliLaunchValue)
if(!(New-TliApplyClaim)){throw 'First apply did not acquire claim'}
$tliResult=Join-Path $tliState "network-firewall-$RequestId-result.json"
# A losing Request returning from UAC sees the winner's apply claim. It must
# not publish a failed result while the winner can still mutate the firewall.
$tliOwnsApply=$false
Write-TliResult 'failed' 'losing Request returned first'
if(Test-Path -LiteralPath $tliResult){throw 'Non-owning requester finalized active apply'}
# A second Apply cannot claim the same operation and its failure cannot settle it.
$conflict=$false
try{New-TliApplyClaim | Out-Null}catch{$conflict=$true}
if(!$conflict){throw 'Duplicate apply acquired claim'}
Write-TliResult 'failed' 'losing Apply failed'
if(Test-Path -LiteralPath $tliResult){throw 'Non-owning apply finalized active apply'}
$tliOwnsApply=$true
Write-TliResult 'completed' 'winner completed'
$original=[IO.File]::ReadAllBytes($tliResult)
Write-TliResult 'failed' 'late failure must not overwrite'
if([Convert]::ToBase64String($original) -cne [Convert]::ToBase64String([IO.File]::ReadAllBytes($tliResult))){throw 'Final result was overwritten'}
if(New-TliApplyClaim){throw 'A finalized request was reclaimed'}
# Request-denied and Apply-start are serialized by the same lock, so a denied
# result cannot appear between Apply ownership acquisition and first mutation.
$RequestId='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
$tliClaim=Join-Path $tliState "network-firewall-$RequestId-claim"
$tliOwnsApply=$false;$tliOwnsRequest=$true
$tliLaunchClaim=Join-Path $tliState "network-firewall-$RequestId-launch"
[IO.File]::WriteAllText($tliLaunchClaim,$tliLaunchValue)
$decision=Enter-TliDecision
$blocked=$false
try{try{Write-TliResult 'failed' 'must wait for ownership decision'}catch{$blocked=$true}}finally{$decision.Dispose()}
if(!$blocked){throw 'Decision lock did not exclude competing finalization'}
Write-TliResult 'failed' 'UAC denied before any Apply acquired ownership'
if(New-TliApplyClaim){throw 'Apply started after a denial finalized'}
if(Test-Path -LiteralPath $tliClaim){throw 'Denied request created an apply claim'}
Write-Output 'pure-receipt-functions-passed'
''', encoding='utf-8')
    result = subprocess.run([str(N._powershell()), '-NoLogo', '-NoProfile', '-NonInteractive', '-File', str(harness),
                             '-Source', str(source), '-FixtureRoot', str(root)], capture_output=True, timeout=20,
                            **hidden_process_kwargs())
    assert result.returncode == 0, result.stdout.decode(errors='replace') + result.stderr.decode(errors='replace')
    assert b'pure-receipt-functions-passed' in result.stdout
    final = N._signed_helper_value(root, H.path_for(root, f'network-firewall-{"a" * 32}-result.json'))
    assert final == {'request_id': 'a' * 32, 'status': 'completed', 'message': 'winner completed'}
