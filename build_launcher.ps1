param([string]$OutputPath = (Join-Path $PSScriptRoot 'TLI.exe'))
$ErrorActionPreference = 'Stop'
$tliCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $tliCompiler)) { $tliCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (!(Test-Path -LiteralPath $tliCompiler)) { throw 'The Windows .NET Framework C# compiler is required to build the TLI launcher.' }
$tliSource = Join-Path $PSScriptRoot 'desktop\TliLauncher.cs'
$tliIcon = Join-Path $PSScriptRoot 'desktop\tli.ico'
$tliVersionText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'backend\tli_state.py') -Raw
$tliVersionMatch = [regex]::Match($tliVersionText, '(?m)^TLI_VERSION\s*=\s*["'']([^"'']+)["'']')
if (!$tliVersionMatch.Success -or $tliVersionMatch.Groups[1].Value -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.-]+)?$') { throw 'A valid TLI release version is required to build the launcher.' }
$tliReleaseVersion = $tliVersionMatch.Groups[1].Value
$tliFileVersion = ($tliReleaseVersion -split '-')[0] + '.0'
$tliBuildDirectory = Join-Path $PSScriptRoot 'build_work\launcher'
New-Item -ItemType Directory -Path $tliBuildDirectory -Force | Out-Null
$tliVersionSource = Join-Path $tliBuildDirectory 'ReleaseInfo.cs'
Set-Content -LiteralPath $tliVersionSource -Encoding UTF8 -Value @"
using System.Reflection;
[assembly: AssemblyFileVersion("$tliFileVersion")]
[assembly: AssemblyInformationalVersion("$tliReleaseVersion")]
"@
& $tliCompiler /nologo /target:winexe /optimize+ /platform:anycpu /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/win32icon:$tliIcon" "/out:$OutputPath" $tliSource $tliVersionSource
if ($LASTEXITCODE -ne 0) { throw 'The TLI launcher build failed.' }
Write-Host "Built $OutputPath"
