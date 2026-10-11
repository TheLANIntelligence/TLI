param(
    [ValidateSet('Menu','CreateShortcuts','EnableHostStart','DisableHostStart','StartHelper','StopHelper','StopTLI','Status','EnableSignIn','DisableSignIn')]
    [string]$Action = 'Menu',
    [ValidateRange(1024,65535)][int]$HelperPort = 8001
)
$ErrorActionPreference = 'Stop'
$tliRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$tliPython = Join-Path $tliRoot 'backend\.venv\Scripts\python.exe'
$tliPythonw = Join-Path $tliRoot 'backend\.venv\Scripts\pythonw.exe'
$tliControl = Join-Path $tliRoot 'backend\host_control_cli.py'
$tliHelper = Join-Path $tliRoot 'backend\host_control_server.py'
$tliLauncher = Join-Path $tliRoot 'backend\host_launcher.py'
$tliApp = Join-Path $tliRoot 'TLI.exe'
$tliHash = [Security.Cryptography.SHA256]::Create()
$tliSuffix = ([BitConverter]::ToString($tliHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($tliRoot.ToLowerInvariant())))).Replace('-','').Substring(0,12)
$tliHash.Dispose()
$tliStartupLink = Join-Path ([Environment]::GetFolderPath('Startup')) "TLI Host Start $tliSuffix.lnk"
function Invoke-TliControl([string]$Operation) {
    if (!(Test-Path -LiteralPath $tliPython) -or !(Test-Path -LiteralPath $tliPythonw)) {
        throw 'Open TLI.exe to prepare this installation, then reopen setup.'
    }
    & $tliPython $tliControl $Operation --port $HelperPort
    if ($LASTEXITCODE -ne 0) { throw 'The local operation did not complete. Read the message above; no automatic retry.' }
}
function New-TliShortcut([string]$Path,[string]$Target,[string]$Arguments,[string]$Description,[string]$Icon = '',[int]$WindowStyle = 7) {
    $tliShell = New-Object -ComObject WScript.Shell
    $tliLink = $tliShell.CreateShortcut($Path)
    $tliLink.TargetPath = $Target
    $tliLink.Arguments = $Arguments
    $tliLink.WorkingDirectory = $tliRoot
    $tliLink.Description = $Description
    $tliLink.WindowStyle = $WindowStyle
    if ($Icon) { $tliLink.IconLocation = $Icon }
    $tliLink.Save()
}
function Get-TliShortcutPath([string]$Directory,[string]$Name,[string]$Target,[string]$Arguments) {
    $tliFolder = Split-Path -Leaf $tliRoot
    $tliNames = @("$Name.lnk", "$Name - $tliFolder $tliSuffix.lnk")
    for ($tliIndex = 2; $tliIndex -le 20; $tliIndex++) { $tliNames += "$Name - $tliFolder $tliSuffix ($tliIndex).lnk" }
    foreach ($tliName in $tliNames) {
        $tliCandidate = Join-Path $Directory $tliName
        if (!(Test-Path -LiteralPath $tliCandidate)) { return $tliCandidate }
        try {
            $tliExisting = (New-Object -ComObject WScript.Shell).CreateShortcut($tliCandidate)
            if ([IO.Path]::GetFullPath($tliExisting.TargetPath) -ieq [IO.Path]::GetFullPath($Target) -and $tliExisting.Arguments -ceq $Arguments) { return $tliCandidate }
            # Only the previous launcher for this exact installation is upgraded.
            if ($Name -eq 'TLI' -and [IO.Path]::GetFullPath($tliExisting.TargetPath) -ieq [IO.Path]::GetFullPath($tliPythonw) -and $tliExisting.Arguments -ceq ('"' + $tliLauncher + '"')) { return $tliCandidate }
        } catch { } # An unrelated/unreadable shortcut is never overwritten.
    }
    throw 'No unused TLI shortcut name was available. Existing shortcuts were preserved.'
}
function Invoke-TliSetup([string]$Selected) {
    switch ($Selected) {
        'CreateShortcuts' {
            if (!(Test-Path -LiteralPath $tliApp -PathType Leaf)) { throw 'TLI.exe is missing. Extract the complete TLI release, then try again.' }
            $tliDesktop = [Environment]::GetFolderPath('Desktop')
            $tliPrograms = Join-Path ([Environment]::GetFolderPath('Programs')) 'TLI'
            New-Item -ItemType Directory -Path $tliPrograms -Force | Out-Null
            foreach ($tliDirectory in @($tliDesktop, $tliPrograms)) {
                $tliShortcut = Get-TliShortcutPath $tliDirectory 'TLI' $tliApp ''
                New-TliShortcut $tliShortcut $tliApp '' 'Open TLI - your private AI on this computer and network.' $tliApp 1
            }
            Write-Host 'TLI is now on your Desktop and in the Start menu.'
        }
        'EnableHostStart' { Invoke-TliControl 'enable' }
        'DisableHostStart' { Invoke-TliControl 'disable'; if (Test-Path -LiteralPath $tliStartupLink) { Remove-Item -LiteralPath $tliStartupLink }; Write-Host 'Phone host start and its sign-in shortcut are disabled.' }
        'StartHelper' { Invoke-TliControl 'start' }
        'StopHelper' { Invoke-TliControl 'stop' }
        'StopTLI' { Invoke-TliControl 'stop-backend' }
        'Status' { Invoke-TliControl 'status' }
        'EnableSignIn' {
            Invoke-TliControl 'validate'
            if ((Read-Host 'Create the helper shortcut for your Windows sign-in? Type YES') -cne 'YES') { Write-Host 'No sign-in shortcut was created.'; return }
            New-TliShortcut $tliStartupLink $tliPythonw ('"' + $tliHelper + '"') 'Optional TLI HTTPS start helper for this signed-in Windows user.'
            Write-Host 'Helper will start when this Windows user signs in. The computer must be awake. No Windows service or firewall rule was installed.'
        }
        'DisableSignIn' { if (Test-Path -LiteralPath $tliStartupLink) { Remove-Item -LiteralPath $tliStartupLink }; Write-Host 'Helper sign-in shortcut removed; use Stop helper to stop the current helper.' }
    }
}
if ($Action -ne 'Menu') { Invoke-TliSetup $Action; exit }
while ($true) {
    Write-Host "`nTLI local setup - this installation only"
    Write-Host '1 Desktop & Start menu app   2 Enable phone host start   3 Start helper'
    Write-Host '4 Status   5 Stop helper   6 Disable phone host start'
    Write-Host '7 Start helper at sign-in   8 Remove sign-in shortcut   9 Stop TLI   0 Exit'
    $tliChoice = Read-Host 'Choose'
    $tliActions = @{'1'='CreateShortcuts';'2'='EnableHostStart';'3'='StartHelper';'4'='Status';'5'='StopHelper';'6'='DisableHostStart';'7'='EnableSignIn';'8'='DisableSignIn';'9'='StopTLI'}
    if ($tliChoice -eq '0') { break }
    if ($tliActions.ContainsKey($tliChoice)) { try { Invoke-TliSetup $tliActions[$tliChoice] } catch { Write-Host $_.Exception.Message -ForegroundColor Red } }
}
