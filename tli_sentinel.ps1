# Legacy port-killing watchdog retired. This compatibility entry point never kills ports.
param([ValidateSet('Status','StartHelper','StopHelper')][string]$Action = 'Status')
Write-Host 'The old sentinel is retired. TLI now uses its optional same-user HTTPS helper.'
Write-Host 'Use TLI_Setup.bat to enable the helper locally and create desktop/sign-in shortcuts.'
& (Join-Path $PSScriptRoot 'TLI_Setup.ps1') -Action $Action
