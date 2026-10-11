$ErrorActionPreference = 'Stop'
$tliRepo = Split-Path -Parent $PSScriptRoot
$tliQa = Join-Path $tliRepo 'build_work\launcher-qa'
$tliFixture = Join-Path $tliQa 'Synthetic TLI & app'
New-Item -ItemType Directory -Force (Join-Path $tliFixture 'backend\.venv\Scripts'), (Join-Path $tliFixture 'frontend') | Out-Null
Copy-Item -LiteralPath (Join-Path $tliRepo 'backend\.venv\Scripts\python.exe') -Destination (Join-Path $tliFixture 'backend\.venv\Scripts\python.exe')
Copy-Item -LiteralPath (Join-Path $tliRepo 'backend\.venv\pyvenv.cfg') -Destination (Join-Path $tliFixture 'backend\.venv\pyvenv.cfg')
Copy-Item -LiteralPath (Join-Path $tliRepo 'frontend\tli-icon-192.png') -Destination (Join-Path $tliFixture 'frontend\tli-icon-192.png')
$tliCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $tliCompiler)) { $tliCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
$tliTestExe = Join-Path $tliQa 'LauncherTests.exe'
& $tliCompiler /nologo /target:exe /main:LauncherTests /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/win32icon:$(Join-Path $tliRepo 'desktop\tli.ico')" "/out:$tliTestExe" (Join-Path $tliRepo 'desktop\TliLauncher.cs') (Join-Path $PSScriptRoot 'tests\TliLauncherTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native test harness did not compile.' }
& $tliTestExe $tliFixture $tliQa
if ($LASTEXITCODE -ne 0) { throw 'Native launcher checks failed.' }
