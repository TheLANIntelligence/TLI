param([string]$OutputPath = (Join-Path $PSScriptRoot 'TLI.exe'))
$ErrorActionPreference = 'Stop'
$tliCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $tliCompiler)) { $tliCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (!(Test-Path -LiteralPath $tliCompiler)) { throw 'The Windows .NET Framework C# compiler is required to build the TLI launcher.' }
$tliSource = Join-Path $PSScriptRoot 'desktop\TliLauncher.cs'
$tliIcon = Join-Path $PSScriptRoot 'desktop\tli.ico'
& $tliCompiler /nologo /target:winexe /optimize+ /platform:anycpu /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/win32icon:$tliIcon" "/out:$OutputPath" $tliSource
if ($LASTEXITCODE -ne 0) { throw 'The TLI launcher build failed.' }
Write-Host "Built $OutputPath"
