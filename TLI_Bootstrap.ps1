param([switch]$SetupOnly)
$ErrorActionPreference = 'Stop'

function Get-TliPythonInfo([string]$Executable, [string[]]$Arguments = @()) {
    try {
        $tliProbe = "import json,struct,sys; print(json.dumps({'executable':sys.executable,'major':sys.version_info[0],'minor':sys.version_info[1],'bits':struct.calcsize('P')*8}))"
        $tliOutput = & $Executable @Arguments -I -c $tliProbe 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        $tliInfo = ($tliOutput -join "`n") | ConvertFrom-Json
        if ($tliInfo.major -ne 3 -or $tliInfo.minor -lt 10 -or $tliInfo.minor -gt 14 -or $tliInfo.bits -ne 64) { return $null }
        if (!(Test-Path -LiteralPath $tliInfo.executable -PathType Leaf)) { return $null }
        return $tliInfo
    } catch { return $null }
}

function Find-TliPython {
    $tliPy = Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($tliPy) {
        foreach ($tliVersion in @('3.14','3.13','3.12','3.11','3.10')) {
            $tliInfo = Get-TliPythonInfo $tliPy.Source @("-$tliVersion")
            if ($tliInfo) { return $tliInfo.executable }
        }
    }
    foreach ($tliVersion in @('314','313','312','311','310')) {
        foreach ($tliCandidate in @(
            (Join-Path $env:LOCALAPPDATA "Programs\Python\Python$tliVersion\python.exe"),
            (Join-Path $env:ProgramFiles "Python$tliVersion\python.exe")
        )) {
            if (Test-Path -LiteralPath $tliCandidate -PathType Leaf) {
                $tliInfo = Get-TliPythonInfo $tliCandidate
                if ($tliInfo) { return $tliInfo.executable }
            }
        }
    }
    $tliCommand = Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($tliCommand) {
        $tliInfo = Get-TliPythonInfo $tliCommand.Source
        if ($tliInfo) { return $tliInfo.executable }
    }
    return $null
}

function Invoke-TliPython([string]$Python, [string[]]$Arguments) {
    & $Python @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Python setup step failed (exit $LASTEXITCODE). TLI has not been started." }
}

function Invoke-TliBootstrap([string]$Root, [switch]$PrepareOnly) {
    $tliRoot = [IO.Path]::GetFullPath($Root)
    $tliBackend = Join-Path $tliRoot 'backend'
    $tliVenv = Join-Path $tliBackend '.venv'
    $tliPython = Join-Path $tliVenv 'Scripts\python.exe'
    $tliRequirements = Join-Path $tliBackend 'requirements.txt'
    if (!(Test-Path -LiteralPath $tliRequirements -PathType Leaf)) { throw 'Backend requirements are missing. Extract the complete TLI ZIP before setup.' }
    # Environment overrides must not redirect installation or Python imports.
    foreach ($tliName in @('PYTHONHOME','PYTHONPATH','TLI_ROOT')) { [Environment]::SetEnvironmentVariable($tliName, $null, 'Process') }
    $env:PYTHONUTF8 = '1'
    if (Test-Path -LiteralPath $tliVenv) {
        if (!(Get-TliPythonInfo $tliPython)) {
            throw 'This installation has an unsupported or unavailable Python environment. Its files and saved data were preserved. Extract the new release into a separate folder and run setup there.'
        }
    } else {
        $tliBasePython = Find-TliPython
        if (!$tliBasePython) {
            $tliWinget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if (!$tliWinget) { throw 'Install 64-bit Python 3.14 from https://www.python.org/downloads/windows/, then reopen TLI. Windows Package Manager is unavailable; no installer was downloaded.' }
            Write-Host 'Installing Python 3.14 for this Windows user through Windows Package Manager...'
            & $tliWinget.Source install --id Python.Python.3.14 --exact --source winget --scope user --architecture x64 --silent --accept-source-agreements --accept-package-agreements --disable-interactivity
            if ($LASTEXITCODE -ne 0) { throw 'Python installation did not complete. Install 64-bit Python 3.14 from https://www.python.org/downloads/windows/, then reopen TLI.' }
            $tliBasePython = Find-TliPython
            if (!$tliBasePython) { throw 'Python installation could not be verified. Close setup and reopen TLI after installing 64-bit Python 3.14.' }
        }
        Write-Host 'Preparing a Python environment for this TLI folder...'
        Invoke-TliPython $tliBasePython @('-I','-m','venv',$tliVenv)
        if (!(Get-TliPythonInfo $tliPython)) { throw 'The new Python environment could not be verified. TLI has not been started.' }
    }
    Write-Host 'Preparing the dependencies declared by this TLI release...'
    Invoke-TliPython $tliPython @('-I','-m','pip','install','-r',$tliRequirements)
    Invoke-TliPython $tliPython @((Join-Path $tliBackend 'host_launcher.py'),'--check-dependencies')
    Invoke-TliPython $tliPython @((Join-Path $tliBackend 'host_launcher.py'),'--check-runtime')
    if ($PrepareOnly) { Write-Host 'TLI setup completed.'; return }
    Invoke-TliPython $tliPython @((Join-Path $tliBackend 'launch_checks.py'))
    $env:TLI_ROOT = $tliRoot
    $env:TLI_OPEN_BROWSER = '1'
    Write-Host 'Starting TLI in this diagnostic window. Close this window to stop this diagnostic host.'
    Invoke-TliPython $tliPython @((Join-Path $tliBackend 'main.py'))
}

# Dot-sourcing defines the bounded functions for isolated tests without setup effects.
if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-TliBootstrap -Root $PSScriptRoot -PrepareOnly:$SetupOnly; exit 0 }
    catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
}
