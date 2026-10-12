# Fixed, one-shot Windows firewall boundary. No application imports or commands
# supplied by HTTP. RequestId selects a signed, expiring local review only.
param(
    [ValidateSet('Inspect','Request','Apply')][string]$Action = 'Inspect',
    [ValidatePattern('^[0-9a-f]{32,64}$')][string]$RequestId
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$tliRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$tliState = Join-Path $tliRoot 'data\host_control'
$tliScript = Join-Path $tliRoot 'TLI_Network_Setup.ps1'
$tliOwnsApply = $false
$tliOwnsRequest = $false

function Assert-TliPath([string]$Path) {
    $tliAbsolute = [IO.Path]::GetFullPath($Path)
    if ($tliAbsolute -ne $tliRoot -and !$tliAbsolute.StartsWith($tliRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Setup path is outside this installation.' }
    $tliCurrent = $tliAbsolute
    while ($tliCurrent) {
        if (Test-Path -LiteralPath $tliCurrent) {
            if (((Get-Item -LiteralPath $tliCurrent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked setup paths are not supported.' }
        }
        $tliCurrent = [IO.Path]::GetDirectoryName($tliCurrent)
    }
    return $tliAbsolute
}

function Read-TliJson([string]$Path, [int]$Limit = 65536) {
    $tliPath = Assert-TliPath $Path
    if ((Get-Item -LiteralPath $tliPath).Length -gt $Limit) { throw 'Oversized setup authority file.' }
    return ([IO.File]::ReadAllText($tliPath) | ConvertFrom-Json)
}

function Get-TliDigest([string]$Path) {
    $tliPath = Assert-TliPath $Path
    if (!(Test-Path -LiteralPath $tliPath)) { return $null }
    return (Get-FileHash -LiteralPath $tliPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TliInspection {
    # Load only the Windows system module, never a user-controlled PSModulePath.
    Import-Module (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\NetSecurity\NetSecurity.psd1') -ErrorAction Stop
    Import-Module (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\NetConnection\NetConnection.psd1') -ErrorAction Stop
    $tliProfiles = @(Get-NetConnectionProfile -ErrorAction Stop | ForEach-Object { [string]$_.NetworkCategory } | Sort-Object -Unique)
    $tliPolicy = Get-NetFirewallProfile -PolicyStore ActiveStore -Name Private -ErrorAction Stop
    $tliStatus = 'ready'
    $tliReason = 'Private network firewall access can be reviewed.'
    if (!$tliPolicy.Enabled -or [string]$tliPolicy.AllowLocalFirewallRules -eq 'False') {
        $tliStatus = 'managed_policy'; $tliReason = 'The Private firewall is disabled or local rules are controlled by policy. Ask the Windows administrator; TLI will not change that policy.'
    } elseif ($tliProfiles -notcontains 'Private') {
        $tliStatus = 'public_network'; $tliReason = 'No Private Windows network is active. Review its network category in Windows Settings; TLI will not change the category or add Public rules.'
    }
    $tliLegacy = @()
    foreach ($tliRule in @(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop | Where-Object { $_.DisplayName -in @('TLI-Web','TLI-Discovery') })) {
        if ($tliLegacy.Count -ge 32) { throw 'Too many earlier TLI firewall rules require manual review.' }
        $tliPort = $tliRule | Get-NetFirewallPortFilter
        $tliApp = $tliRule | Get-NetFirewallApplicationFilter
        $tliAddress = $tliRule | Get-NetFirewallAddressFilter
        $tliLegacy += [pscustomobject][ordered]@{
            name = [string]$tliRule.Name; display_name = [string]$tliRule.DisplayName
            direction = [string]$tliRule.Direction; action = [string]$tliRule.Action; enabled = [string]$tliRule.Enabled
            profile = [string]$tliRule.Profile; protocol = [string]$tliPort.Protocol
            local_port = [string]$tliPort.LocalPort; program = [string]$tliApp.Program; remote_address = [string]$tliAddress.RemoteAddress
        }
    }
    return [pscustomobject]@{ supported = $true; status = $tliStatus; reason = $tliReason; profiles = @($tliProfiles); legacy_rules = @($tliLegacy | Sort-Object name) }
}

function Read-TliRequest {
    if (!$RequestId) { throw 'A reviewed request ID is required.' }
    $tliEnvelope = Read-TliJson (Join-Path $tliState "network-firewall-$RequestId-request.json")
    if (@($tliEnvelope.PSObject.Properties.Name).Count -ne 2 -or !$tliEnvelope.payload -or $tliEnvelope.signature -notmatch '^[0-9a-f]{64}$') { throw 'Invalid request envelope.' }
    $tliIdentity = Read-TliJson (Join-Path $tliState 'installation.json') 16384
    if ($tliIdentity.version -ne 1 -or $tliIdentity.root -cne $tliRoot -or $tliIdentity.installation_id -notmatch '^[0-9a-f]{32}$' -or $tliIdentity.secret -notmatch '^[0-9a-f]{64}$') { throw 'Installation identity changed.' }
    $tliRaw = [Convert]::FromBase64String($tliEnvelope.payload)
    if ($tliRaw.Length -gt 49152) { throw 'Oversized request payload.' }
    $tliKey = [byte[]]::new(32)
    for ($tliI = 0; $tliI -lt 32; $tliI++) { $tliKey[$tliI] = [Convert]::ToByte($tliIdentity.secret.Substring($tliI * 2, 2), 16) }
    $tliMac = [Security.Cryptography.HMACSHA256]::new($tliKey)
    try { $tliSignature = ([BitConverter]::ToString($tliMac.ComputeHash($tliRaw))).Replace('-','').ToLowerInvariant() } finally { $tliMac.Dispose(); [Array]::Clear($tliKey,0,$tliKey.Length) }
    if ($tliSignature -cne $tliEnvelope.signature) { throw 'The reviewed request signature is invalid.' }
    $tliRequest = [Text.Encoding]::UTF8.GetString($tliRaw) | ConvertFrom-Json
    $tliFields = @('version','request_id','installation_id','expires_at','program','port','snapshot','legacy_rules')
    if (@($tliRequest.PSObject.Properties.Name).Count -ne $tliFields.Count -or @($tliRequest.PSObject.Properties.Name | Where-Object { $_ -notin $tliFields }).Count) { throw 'Unsupported request fields.' }
    $tliNow = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    if ($tliRequest.version -ne 1 -or $tliRequest.request_id -cne $RequestId -or $tliRequest.installation_id -cne $tliIdentity.installation_id -or $tliRequest.expires_at -le $tliNow -or $tliRequest.expires_at -gt ($tliNow + 300)) { throw 'The reviewed request expired or belongs to another installation.' }
    if ($tliRequest.port -isnot [int] -and $tliRequest.port -isnot [long]) { throw 'Invalid reviewed port.' }
    if ($tliRequest.port -lt 1 -or $tliRequest.port -gt 65535 -or $tliRequest.program -notmatch '^[A-Za-z]:\\[^\r\n"]+\.exe$' -or !(Test-Path -LiteralPath $tliRequest.program -PathType Leaf)) { throw 'Invalid reviewed executable or port.' }
    $tliSnapshotFiles = @('data/startup.json','data/tls/cert.pem','data/tls/key.pem','data/tli_pin.json','TLI_Network_Setup.ps1')
    if (@($tliRequest.snapshot.PSObject.Properties.Name).Count -ne $tliSnapshotFiles.Count) { throw 'Invalid setup snapshot.' }
    foreach ($tliRelative in $tliSnapshotFiles) {
        if ($tliRequest.snapshot.PSObject.Properties.Name -notcontains $tliRelative -or (Get-TliDigest (Join-Path $tliRoot $tliRelative)) -cne $tliRequest.snapshot.$tliRelative) { throw 'Reviewed settings, certificate, PIN or helper changed. Review setup again.' }
    }
    $tliStartup = Read-TliJson (Join-Path $tliRoot 'data\startup.json') 16384
    if ($tliStartup.https -ne $true -or $tliStartup.host -cne '0.0.0.0' -or $tliStartup.port -ne $tliRequest.port) { throw 'The reviewed secure startup settings changed.' }
    return $tliRequest
}

function Get-TliSignedEnvelope($Value) {
    $tliIdentity = Read-TliJson (Join-Path $tliState 'installation.json') 16384
    if ($tliIdentity.secret -notmatch '^[0-9a-f]{64}$') { throw 'Invalid result signing authority.' }
    $tliKey = [byte[]]::new(32)
    for ($tliI = 0; $tliI -lt 32; $tliI++) { $tliKey[$tliI] = [Convert]::ToByte($tliIdentity.secret.Substring($tliI * 2, 2), 16) }
    $tliRaw = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Compress))
    $tliMac = [Security.Cryptography.HMACSHA256]::new($tliKey)
    try { $tliSignature = ([BitConverter]::ToString($tliMac.ComputeHash($tliRaw))).Replace('-','').ToLowerInvariant() } finally { $tliMac.Dispose(); [Array]::Clear($tliKey,0,$tliKey.Length) }
    return (@{payload=[Convert]::ToBase64String($tliRaw);signature=$tliSignature} | ConvertTo-Json -Compress)
}

function Enter-TliDecision {
    $tliDecision = Assert-TliPath (Join-Path $tliState "network-firewall-$RequestId-decision")
    for ($tliAttempt = 0; $tliAttempt -lt 20; $tliAttempt++) {
        try { return [IO.File]::Open($tliDecision, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { Start-Sleep -Milliseconds 25 }
    }
    throw 'Another process is finalizing this reviewed request.'
}

function New-TliApplyClaim {
    $tliDecisionStream = Enter-TliDecision
    try {
        if (Test-Path -LiteralPath (Assert-TliPath (Join-Path $tliState "network-firewall-$RequestId-result.json"))) { return $false }
        $tliClaimStream = [IO.File]::Open($tliClaim, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $tliClaimStream.Write($tliClaimBytes,0,$tliClaimBytes.Length); $tliClaimStream.Flush($true) } finally { $tliClaimStream.Dispose() }
        $script:tliOwnsApply = $true
        return $true
    } finally { $tliDecisionStream.Dispose() }
}

function Write-TliResult([string]$Status, [string]$Message) {
    $tliDecisionStream = Enter-TliDecision
    try {
    $tliResult = Assert-TliPath (Join-Path $tliState "network-firewall-$RequestId-result.json")
    $tliApplyClaim = Assert-TliPath (Join-Path $tliState "network-firewall-$RequestId-claim")
    if (Test-Path -LiteralPath $tliApplyClaim) {
        if (!$tliOwnsApply -or [IO.File]::ReadAllText($tliApplyClaim) -cne $tliClaimValue) { return }
    } else {
        if (!$tliOwnsRequest -or [IO.File]::ReadAllText((Assert-TliPath $tliLaunchClaim)) -cne $tliLaunchValue) { return }
    }
    if (Test-Path -LiteralPath $tliResult) { return }
    $tliTemporary = Assert-TliPath ($tliResult + '.' + $PID + '.tmp')
    $tliValue = Get-TliSignedEnvelope @{request_id=$RequestId; status=$Status; message=$Message}
    $tliBytes = [Text.Encoding]::UTF8.GetBytes($tliValue)
    $tliStream = [IO.File]::Open($tliTemporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $tliStream.Write($tliBytes,0,$tliBytes.Length); $tliStream.Flush($true) } finally { $tliStream.Dispose() }
    try {
        # File.Move's two-argument overload never replaces an existing result.
        [IO.File]::Move($tliTemporary, $tliResult)
    } finally { if (Test-Path -LiteralPath $tliTemporary) { Remove-Item -LiteralPath $tliTemporary } }
    } finally { $tliDecisionStream.Dispose() }
}

function Assert-TliMutation {
    # Expiry is a fence immediately before EVERY change, including legacy
    # migration. A delayed UAC approval cannot apply an already expired review.
    Read-TliRequest | Out-Null
    if (Test-Path -LiteralPath (Assert-TliPath (Join-Path $tliState "network-firewall-$RequestId-result.json"))) { throw 'This request already has a final result.' }
    if ([IO.File]::ReadAllText((Assert-TliPath $tliClaim)) -cne $tliClaimValue) { throw 'The elevated process claim changed.' }
    $tliCurrentNetwork = Get-TliInspection
    if ($tliCurrentNetwork.status -ne 'ready') { throw $tliCurrentNetwork.reason }
}

try {
    if ($Action -eq 'Inspect') {
        Get-TliInspection | ConvertTo-Json -Depth 8 -Compress
        exit 0
    }
    # Repeated launches cannot overwrite a final receipt or prompt for UAC again.
    if ($RequestId -and ((Test-Path -LiteralPath (Assert-TliPath (Join-Path $tliState "network-firewall-$RequestId-result.json"))) -or
                         (Test-Path -LiteralPath (Assert-TliPath (Join-Path $tliState "network-firewall-$RequestId-claim"))))) { exit 2 }
    $tliRequest = Read-TliRequest
    if ($Action -eq 'Request') {
        $tliLaunchClaim = Assert-TliPath (Join-Path $tliState "network-firewall-$RequestId-launch")
        $tliLaunchValue = Get-TliSignedEnvelope @{request_id=$RequestId;pid=$PID}
        $tliLaunchBytes = [Text.Encoding]::UTF8.GetBytes($tliLaunchValue)
        try { $tliLaunchStream = [IO.File]::Open($tliLaunchClaim, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
        catch { exit 2 } # A competing requester owns this UAC interaction.
        try { $tliLaunchStream.Write($tliLaunchBytes,0,$tliLaunchBytes.Length); $tliLaunchStream.Flush($true) } finally { $tliLaunchStream.Dispose() }
        $tliOwnsRequest = $true
        # This process is not elevated. UAC consent elevates only the fixed helper.
        $tliPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $tliArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $tliScript + '" -Action Apply -RequestId ' + $RequestId
        try {
            $tliProcess = Start-Process -FilePath $tliPowerShell -ArgumentList $tliArguments -Verb RunAs -WindowStyle Hidden -PassThru -Wait
            if ($tliProcess.ExitCode -ne 0 -and !(Test-Path -LiteralPath (Join-Path $tliState "network-firewall-$RequestId-result.json"))) { Write-TliResult 'failed' 'Windows did not apply the reviewed firewall rules. Inspect the local administrator policy before trying a new review.' }
        } catch {
            Write-TliResult 'failed' 'Administrator approval was denied or unavailable. No firewall rule was requested by the unelevated TLI process.'
        }
        exit 0
    }
    $tliPrincipal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (!$tliPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator approval is required for firewall changes.' }
    $tliInspection = Get-TliInspection
    if ($tliInspection.status -ne 'ready') { throw $tliInspection.reason }
    # Confirm every explicitly reviewed legacy row still matches every filter.
    foreach ($tliOld in @($tliRequest.legacy_rules)) {
        $tliObserved = @($tliInspection.legacy_rules | Where-Object { $_.name -ceq $tliOld.name })
        if ($tliObserved.Count -ne 1) { throw 'An earlier firewall rule changed after review.' }
        foreach ($tliField in @('name','display_name','direction','action','enabled','profile','protocol','local_port','program','remote_address')) {
            if ($tliObserved[0].$tliField -cne $tliOld.$tliField) { throw 'An earlier firewall rule changed after review.' }
        }
    }
    # Exclusive claim is the elevated no-replay boundary, before any rule change.
    $tliClaim = Assert-TliPath (Join-Path $tliState "network-firewall-$RequestId-claim")
    $tliCreated = ((Get-Process -Id $PID).StartTime.ToUniversalTime() - [DateTime]::new(1970,1,1,0,0,0,[DateTimeKind]::Utc)).TotalSeconds
    $tliClaimValue = Get-TliSignedEnvelope @{request_id=$RequestId;pid=$PID;created_at=$tliCreated}
    $tliClaimBytes = [Text.Encoding]::UTF8.GetBytes($tliClaimValue)
    if (!(New-TliApplyClaim)) { exit 2 }
    $tliGroup = 'TLI installation ' + $tliRequest.installation_id
    $tliRules = @(
        @{suffix='Web';protocol='TCP';port=[int]$tliRequest.port},
        @{suffix='mDNS';protocol='UDP';port=5353},
        @{suffix='Discovery';protocol='UDP';port=47474}
    )
    foreach ($tliRule in $tliRules) {
        $tliName = 'TLI-' + $tliRequest.installation_id + '-' + $tliRule.suffix
        $tliExisting = @(Get-NetFirewallRule -PolicyStore PersistentStore -Name $tliName -ErrorAction SilentlyContinue)
        if ($tliExisting.Count -gt 1 -or ($tliExisting.Count -eq 1 -and $tliExisting[0].Group -cne $tliGroup)) { throw 'An unrelated firewall rule occupies a TLI rule name.' }
        if ($tliExisting.Count) { Assert-TliMutation; $tliExisting[0] | Remove-NetFirewallRule -ErrorAction Stop }
        Assert-TliMutation
        New-NetFirewallRule -PolicyStore PersistentStore -Name $tliName -DisplayName $tliName -Group $tliGroup -Description ('Reviewed TLI local network access ' + $RequestId) -Direction Inbound -Action Allow -Enabled True -Profile Private -RemoteAddress LocalSubnet -Program $tliRequest.program -Protocol $tliRule.protocol -LocalPort $tliRule.port -EdgeTraversalPolicy Block -ErrorAction Stop | Out-Null
        $tliVerified = Get-NetFirewallRule -PolicyStore ActiveStore -Name $tliName -ErrorAction Stop
        $tliVerifiedPort = $tliVerified | Get-NetFirewallPortFilter
        $tliVerifiedAddress = $tliVerified | Get-NetFirewallAddressFilter
        $tliVerifiedProgram = $tliVerified | Get-NetFirewallApplicationFilter
        if ([string]$tliVerified.Profile -ne 'Private' -or [string]$tliVerified.Action -ne 'Allow' -or [string]$tliVerified.Enabled -ne 'True' -or [string]$tliVerified.Direction -ne 'Inbound' -or [string]$tliVerifiedProgram.Program -ine $tliRequest.program -or [string]$tliVerifiedAddress.RemoteAddress -ne 'LocalSubnet' -or [string]$tliVerifiedPort.LocalPort -ne [string]$tliRule.port -or [string]$tliVerifiedPort.Protocol -ne $tliRule.protocol) { throw 'The effective firewall rule does not match the reviewed restrictions. Local policy may override it.' }
    }
    foreach ($tliOld in @($tliRequest.legacy_rules)) {
        # Name parameters can interpret wildcards: select exact observed objects.
        $tliCurrentInspection = Get-TliInspection
        $tliCurrentRow = @($tliCurrentInspection.legacy_rules | Where-Object { $_.name -ceq $tliOld.name })
        if ($tliCurrentRow.Count -ne 1) { throw 'An earlier firewall rule changed before removal.' }
        foreach ($tliField in @('name','display_name','direction','action','enabled','profile','protocol','local_port','program','remote_address')) {
            if ($tliCurrentRow[0].$tliField -cne $tliOld.$tliField) { throw 'An earlier firewall rule changed before removal.' }
        }
        $tliExactRule = @(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop | Where-Object { $_.Name -ceq $tliOld.name })
        if ($tliExactRule.Count -ne 1) { throw 'An earlier firewall rule became ambiguous.' }
        Assert-TliMutation
        $tliExactRule[0] | Remove-NetFirewallRule -ErrorAction Stop
    }
    Write-TliResult 'completed' 'Windows verified the reviewed TLI rules: Private profile, local subnet, this executable and the selected ports. Connectivity still requires a reachable awake host and client pairing.'
    exit 0
} catch {
    if ($RequestId -and $Action -ne 'Inspect') {
        try { Write-TliResult 'failed' ('Firewall setup did not complete: ' + $_.Exception.Message + ' No automatic retry occurred; inspect TLI rules before a new review.') } catch { }
    }
    if ($Action -eq 'Inspect') { @{supported=$true;status='unavailable';reason='Windows network or firewall policy could not be inspected.';profiles=@();legacy_rules=@()} | ConvertTo-Json -Compress }
    exit 1
}
