param([string]$Target = '')
$ErrorActionPreference = 'Stop'

function Find-TliUpdatePython([string]$ExistingRoot, [string]$SourceRoot) {
    $tliCandidates = @(
        (Join-Path $ExistingRoot 'backend\.venv\Scripts\python.exe'),
        (Join-Path $SourceRoot 'backend\.venv\Scripts\python.exe')
    )
    foreach ($tliName in @('python.exe', 'python3.exe')) {
        $tliCommand = Get-Command $tliName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($tliCommand) { $tliCandidates += $tliCommand.Source }
    }
    $tliPy = Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($tliPy) {
        foreach ($tliVersion in @('3.14','3.13','3.12','3.11','3.10')) {
            try {
                $tliResolved = & $tliPy.Source "-$tliVersion" -I -c 'import sys; print(sys.executable)' 2>$null
                if ($LASTEXITCODE -eq 0) { $tliCandidates += ($tliResolved -join '').Trim() }
            } catch { }
        }
    }
    foreach ($tliCandidate in $tliCandidates) {
        if (!(Test-Path -LiteralPath $tliCandidate -PathType Leaf)) { continue }
        try {
            & $tliCandidate -I -c 'import sys; raise SystemExit(sys.version_info < (3, 10))' 2>$null
            if ($LASTEXITCODE -eq 0) { return $tliCandidate }
        } catch { }
    }
    throw 'Python 3.10 or newer is required. Open this package with normal TLI setup to prepare Python, then close TLI and run this updater again. Existing files have not been changed.'
}

function Invoke-TliUpdate([string]$SourceRoot, [string]$ExistingRoot = '') {
    $tliSource = [IO.Path]::GetFullPath($SourceRoot)
    if (!(Test-Path -LiteralPath (Join-Path $tliSource 'TLI_RELEASE.json') -PathType Leaf)) {
        throw 'This package has no update inventory. Download an updater-equipped release, extract the entire ZIP into a separate folder, then run its TLI_Update.bat.'
    }
    Write-Host "`nUpdate an existing TLI installation"
    Write-Host 'Finish active work and stop TLI and its optional host-start helper first.'
    Write-Host 'Select your ORIGINAL TLI folder. Keep this extracted update in a separate folder.'
    if (!$ExistingRoot) {
        $tliDefault = ''
        $tliHint = Join-Path $tliSource 'update-target.json'
        if (Test-Path -LiteralPath $tliHint -PathType Leaf) {
            try {
                if ((Get-Item -LiteralPath $tliHint).Length -le 4096) {
                    $tliSaved = Get-Content -LiteralPath $tliHint -Raw | ConvertFrom-Json
                    if ($tliSaved.target -is [string]) { $tliDefault = $tliSaved.target }
                }
            } catch { } # A staged hint is optional and never authorizes an update.
        }
        if ($tliDefault) { Write-Host ('Suggested existing folder: ' + $tliDefault) }
        $ExistingRoot = Read-Host 'Existing TLI folder (Enter accepts the suggested folder)'
        if (!$ExistingRoot) { $ExistingRoot = $tliDefault }
    }
    $ExistingRoot = $ExistingRoot.Trim().Trim('"')
    if (!$ExistingRoot) { throw 'No existing installation was selected. Nothing was updated.' }
    $tliTarget = [IO.Path]::GetFullPath($ExistingRoot)
    if (!(Test-Path -LiteralPath $tliTarget -PathType Container)) { throw 'The selected existing TLI folder does not exist. Nothing was updated.' }
    Write-Host ('Selected existing folder: ' + $tliTarget)
    Write-Host 'The updater will verify this package and ask you to type UPDATE before applying it.'
    foreach ($tliName in @('PYTHONHOME','PYTHONPATH','TLI_ROOT')) { [Environment]::SetEnvironmentVariable($tliName, $null, 'Process') }
    $env:PYTHONUTF8 = '1'
    $env:PYTHONIOENCODING = 'utf-8'
    $tliPython = Find-TliUpdatePython $tliTarget $tliSource
    & $tliPython -I (Join-Path $tliSource 'backend\update_install.py') --source $tliSource --target $tliTarget
    if ($LASTEXITCODE -ne 0) { throw 'The update did not complete. Review the message above before retrying; do not copy files manually.' }
    Write-Host "`nOpen TLI from your ORIGINAL folder or existing shortcut to finish. First start may prepare updated components and need internet access."
}

# Dot-sourcing exposes the bounded functions for isolated launcher checks.
if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-TliUpdate -SourceRoot $PSScriptRoot -ExistingRoot $Target; exit 0 }
    catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
}
