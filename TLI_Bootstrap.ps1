param([switch]$SetupOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-TliSetupProgress([string]$Message) {
    Write-Host ('TLI_SETUP_PROGRESS:' + $Message)
}

function Test-TliVCRuntime {
    # Use the native system directory even when setup is invoked by 32-bit PowerShell.
    $tliSystem = Join-Path $env:WINDIR 'System32'
    if ([Environment]::Is64BitOperatingSystem -and ![Environment]::Is64BitProcess) {
        $tliSystem = Join-Path $env:WINDIR 'Sysnative'
    }
    foreach ($tliDll in @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll')) {
        if (!(Test-Path -LiteralPath (Join-Path $tliSystem $tliDll) -PathType Leaf)) { return $false }
    }
    return $true
}

function Install-TliVCRuntime {
    # Only first-time/explicit setup can install prerequisites. Everyday launch
    # remains read-only and never asks for elevation. Download from Microsoft,
    # verify the signed publisher, and let Windows own any administrator prompt.
    $tliDownloadDirectory = Join-Path ([IO.Path]::GetTempPath()) ('TLI-prerequisite-' + [Guid]::NewGuid().ToString('N'))
    $tliInstaller = Join-Path $tliDownloadDirectory 'vc_redist.x64.exe'
    $tliInstallerFinished = $true
    try {
        New-Item -ItemType Directory -Path $tliDownloadDirectory | Out-Null
        Write-TliSetupProgress 'Downloading the Microsoft runtime needed by local AI...'
        $tliPreviousProtocol = [Net.ServicePointManager]::SecurityProtocol
        try {
            [Net.ServicePointManager]::SecurityProtocol = $tliPreviousProtocol -bor [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri 'https://aka.ms/vc14/vc_redist.x64.exe' -OutFile $tliInstaller -UseBasicParsing -TimeoutSec 120
        } finally { [Net.ServicePointManager]::SecurityProtocol = $tliPreviousProtocol }
        $tliSignature = Get-AuthenticodeSignature -LiteralPath $tliInstaller
        if ($tliSignature.Status -ne 'Valid' -or !$tliSignature.SignerCertificate -or
            $tliSignature.SignerCertificate.Subject -notmatch '(^|,\s*)CN=Microsoft Corporation(,|$)') {
            throw 'The Microsoft runtime download could not be verified. It was not run.'
        }
        Write-TliSetupProgress 'Preparing local AI. Approve the Microsoft Windows prompt if one appears...'
        $tliInstallProcess = Start-Process -FilePath $tliInstaller -ArgumentList @('/install','/quiet','/norestart') -WindowStyle Hidden -PassThru
        $tliInstallerFinished = $false
        try {
            if (!$tliInstallProcess.WaitForExit(300000)) {
                throw 'Microsoft runtime setup is still running. TLI can open; finish the Windows prompt before retrying local AI.'
            }
            $tliInstallerFinished = $true
            # 1638 means a newer version is already installed. The independent
            # runtime probe below still decides whether local AI is usable.
            if ($tliInstallProcess.ExitCode -eq 3010) {
                Write-Warning 'The Microsoft runtime was installed. Windows requested a restart; TLI will not restart your computer. You can finish welcome setup now.'
            } elseif ($tliInstallProcess.ExitCode -notin @(0, 1638)) {
                throw "Microsoft runtime setup did not complete (exit $($tliInstallProcess.ExitCode)). You can still finish TLI welcome setup."
            }
        } finally { $tliInstallProcess.Dispose() }
    } finally {
        # Only remove this invocation's exact file/directory, never recurse or
        # remove a running installer's source. No existing installation is touched.
        if ($tliInstallerFinished) {
            if (Test-Path -LiteralPath $tliInstaller) { Remove-Item -LiteralPath $tliInstaller -Force -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $tliDownloadDirectory) { Remove-Item -LiteralPath $tliDownloadDirectory -ErrorAction SilentlyContinue }
        }
    }
}

function Initialize-TliLocalAIRuntime([string]$Root) {
    if (!(Test-Path -LiteralPath (Join-Path $Root 'backend/ai/runtime/llama_server.exe') -PathType Leaf)) { return }
    if (Test-TliVCRuntime) { return }
    try { Install-TliVCRuntime }
    catch {
        Write-Warning $_.Exception.Message
        Write-Warning 'Local AI prerequisites need attention. TLI will continue preparing your workspace.'
    }
}

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
    $env:PYTHONIOENCODING = 'utf-8'
    if (Test-Path -LiteralPath $tliVenv) {
        if (!(Get-TliPythonInfo $tliPython)) {
            throw 'This installation has an unsupported or unavailable Python environment. Its files and saved data were preserved. Extract the new release into a separate folder and run setup there.'
        }
    } else {
        $tliBasePython = Find-TliPython
        if (!$tliBasePython) {
            $tliWinget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if (!$tliWinget) { throw 'Install 64-bit Python 3.14 from https://www.python.org/downloads/windows/, then reopen TLI. Windows Package Manager is unavailable; no installer was downloaded.' }
            Write-TliSetupProgress 'Installing Python for this Windows user...'
            & $tliWinget.Source install --id Python.Python.3.14 --exact --source winget --scope user --architecture x64 --silent --accept-source-agreements --accept-package-agreements --disable-interactivity
            if ($LASTEXITCODE -ne 0) { throw 'Python installation did not complete. Install 64-bit Python 3.14 from https://www.python.org/downloads/windows/, then reopen TLI.' }
            $tliBasePython = Find-TliPython
            if (!$tliBasePython) { throw 'Python installation could not be verified. Close setup and reopen TLI after installing 64-bit Python 3.14.' }
        }
        Write-TliSetupProgress 'Preparing this TLI installation...'
        Invoke-TliPython $tliBasePython @('-I','-m','venv',$tliVenv)
        if (!(Get-TliPythonInfo $tliPython)) { throw 'The new Python environment could not be verified. TLI has not been started.' }
    }
    Initialize-TliLocalAIRuntime $tliRoot
    Write-TliSetupProgress 'Checking TLI components...'
    $tliDependenciesReady = $false
    try {
        Invoke-TliPython $tliPython @((Join-Path $tliBackend 'host_launcher.py'),'--check-dependencies')
        $tliDependenciesReady = $true
    } catch {
        # An already prepared environment needs no package index or pip request.
        # Missing components are installed below, then independently rechecked.
    }
    if (!$tliDependenciesReady) {
        Write-TliSetupProgress 'Downloading missing TLI components...'
        Invoke-TliPython $tliPython @('-I','-m','pip','install','--disable-pip-version-check','-r',$tliRequirements)
        Invoke-TliPython $tliPython @((Join-Path $tliBackend 'host_launcher.py'),'--check-dependencies')
    }
    # The bundled inference engine is optional. Its native prerequisites must
    # not prevent the web app, welcome setup, or another AI provider from opening.
    # Keep the required Python/dependency and backend checks outside this catch.
    try {
        Invoke-TliPython $tliPython @((Join-Path $tliBackend 'host_launcher.py'),'--check-runtime')
    } catch {
        Write-Warning 'Local AI needs attention. TLI setup will continue so you can open the app and finish welcome setup.'
        Write-Warning 'The bundled local AI runtime could not be confirmed. This does not identify the exact cause; use TLI_Diagnostics.bat for details.'
        Write-Warning 'If Windows still needs the Microsoft Visual C++ v14 Redistributable, repair the x64 package using https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist/ and then reopen TLI.'
    }
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
