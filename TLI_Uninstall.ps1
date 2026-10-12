param([switch]$Plan)

# Standalone: no Python, backend, network, or administrator dependency.
# Dot-sourcing loads functions only. -Plan is read-only and never opens the UI.
$ErrorActionPreference = 'Stop'

function Assert-TliUnlinkedPath([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked folders and files require manual review: $current" }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Get-TliRemovalRoot([string]$Root) {
    if (!$Root -or ![IO.Path]::IsPathRooted($Root)) { throw 'An absolute installation folder is required.' }
    $full = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if (!$full -or $full -match '^[A-Za-z]:$' -or $full.StartsWith('\\')) { throw 'A drive root or network folder cannot be removed by TLI.' }
    if (!(Test-Path -LiteralPath $full -PathType Container)) { throw 'The installation folder no longer exists.' }
    Assert-TliUnlinkedPath $full
    if ($env:SystemRoot -and $full.StartsWith([IO.Path]::GetFullPath($env:SystemRoot).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'A folder inside Windows cannot be removed by TLI.' }
    $protected = @($env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData, $env:USERPROFILE, $env:PUBLIC,
        [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('MyDocuments'),
        [Environment]::GetFolderPath('ApplicationData'), [Environment]::GetFolderPath('LocalApplicationData'),
        [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Startup'), [IO.Path]::GetTempPath())
    if ($env:USERPROFILE) { $protected += Join-Path $env:USERPROFILE 'Downloads' }
    foreach ($value in $protected) {
        if (!$value) { continue }
        $path = [IO.Path]::GetFullPath($value).TrimEnd('\', '/')
        if ($path -ieq $full -or $path.StartsWith($full + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'TLI cannot remove a Windows, profile, shared, or standard user folder.' }
    }
    foreach ($marker in @('backend\main.py', 'frontend\index.html', 'TLI_Uninstall.ps1')) {
        $path = Join-Path $full $marker
        Assert-TliUnlinkedPath $path
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw 'This is not a complete TLI installation folder. No files were removed.' }
    }
    return $full
}

function Assert-TliRemovalChild([string]$Root, [string]$Path) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($full -ine $Root -and !$full.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'A removal path escaped the reviewed installation folder.' }
    Assert-TliUnlinkedPath $full
}

function Get-TliRemovalKey([string]$Root) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $suffix = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant())))).Replace('-', '').Substring(0, 12) }
    finally { $hash.Dispose() }
    return "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\TLI-$suffix"
}

function Test-TliRemovalRegistration([string]$Root) {
    $key = Get-TliRemovalKey $Root
    if (!(Test-Path -LiteralPath $key)) { return $false }
    $entry = Get-ItemProperty -LiteralPath $key
    return ($entry.InstallLocation -and [IO.Path]::GetFullPath($entry.InstallLocation).TrimEnd('\', '/') -ieq $Root)
}

function Get-TliRemovalShortcutDirectories {
    return @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'TLI'), [Environment]::GetFolderPath('Startup'))
}

function Test-TliOwnedShortcut([string]$Root, $Shortcut) {
    if (!$Shortcut.TargetPath) { return $false }
    $target = [IO.Path]::GetFullPath($Shortcut.TargetPath)
    foreach ($relative in @('TLI.exe', 'TLI.bat', 'TLI_Setup.bat', 'Uninstall_TLI.bat')) {
        if ($target -ieq (Join-Path $Root $relative) -and !$Shortcut.Arguments) { return $true }
    }
    foreach ($script in @('backend\host_launcher.py', 'backend\host_control_server.py')) {
        if ($target -ieq (Join-Path $Root 'backend\.venv\Scripts\pythonw.exe') -and $Shortcut.Arguments -ceq ('"' + (Join-Path $Root $script) + '"')) { return $true }
    }
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if ($target -ieq $powershell) {
        foreach ($script in @('TLI_Setup.ps1', 'TLI_Uninstall.ps1')) {
            $pattern = '(?i)(?:^|\s)-File\s+"' + [regex]::Escape((Join-Path $Root $script)) + '"\s*$'
            if ($Shortcut.Arguments -match $pattern) { return $true }
        }
    }
    return $false
}

function Get-TliRemovalShortcuts([string]$Root) {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($directory in (Get-TliRemovalShortcutDirectories)) {
        if (!$directory -or !(Test-Path -LiteralPath $directory -PathType Container)) { continue }
        Assert-TliUnlinkedPath $directory
        foreach ($file in (Get-ChildItem -LiteralPath $directory -Filter '*.lnk' -File -Force)) {
            Assert-TliUnlinkedPath $file.FullName
            if (Test-TliOwnedShortcut $Root ($shell.CreateShortcut($file.FullName))) { $file.FullName }
        }
    }
}

function Get-TliRemovalFiles([string]$Root) {
    # Check each directory before descent; never use recursive removal on links.
    $pending = New-Object 'Collections.Generic.Stack[string]'
    $pending.Push($Root)
    while ($pending.Count) {
        $directory = $pending.Pop()
        Assert-TliRemovalChild $Root $directory
        foreach ($item in (Get-ChildItem -LiteralPath $directory -Force)) {
            Assert-TliRemovalChild $Root $item.FullName
            $item.FullName
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
        }
    }
}

function Assert-TliNotSourceCheckout([string]$Root) {
    $current = $Root
    while ($current) {
        if (Test-Path -LiteralPath (Join-Path $current '.git')) { throw 'This is a source checkout. Remove Windows entries and keep all files, or review and delete the checkout manually.' }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Get-TliRemovalProcesses([string]$Root) {
    $pattern = '(?i)(?:^|[\s"''])' + [regex]::Escape($Root) + '[\\/]'
    foreach ($process in (Get-CimInstance Win32_Process -ErrorAction Stop)) {
        if ([int]$process.ProcessId -eq $PID) { continue }
        $owned = $process.ExecutablePath -and $process.ExecutablePath.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)
        if ($owned -or ($process.CommandLine -and $process.CommandLine -match $pattern)) {
            [pscustomobject]@{ pid = [int]$process.ProcessId; name = $process.Name; reason = 'Uses this installation' }
        } elseif ($process.Name -match '^(?:pythonw?|pypyw?|uvicorn)\.exe$' -and ($process.CommandLine -match '(?i)\s["'']?(?:\.[\\/])?(?:backend[\\/])?(?:main|host_control_server|host_launcher|host_lifecycle)\.py(?:["'']?\s|["'']?$)' -or $process.CommandLine -match '(?i)\s(?:backend\.)?main:app(?:\s|$)')) {
            # CIM cannot resolve a relative diagnostic launch to its working directory.
            [pscustomobject]@{ pid = [int]$process.ProcessId; name = $process.Name; reason = 'Relative Python launch: stop it in its original terminal before removal' }
        } elseif ($process.Name -match '^(?:pythonw?|pypyw?|TLI|tli_backend|llama[-_]server)\.exe$' -and (!$process.CommandLine -or !$process.ExecutablePath)) {
            [pscustomobject]@{ pid = [int]$process.ProcessId; name = $process.Name; reason = 'Process ownership cannot be checked; close this process locally before removal' }
        }
    }
}

function Assert-TliRemovalIdle([string]$Root) {
    $processes = @(Get-TliRemovalProcesses $Root)
    if ($processes.Count) {
        $names = ($processes | ForEach-Object { "$($_.name) (PID $($_.pid)): $($_.reason)" }) -join "`r`n"
        throw "Close TLI and stop its optional host-start helper before removal. Use local Setup to stop the helper and TLI, close Setup, then retry.`r`n`r`n$names"
    }
    foreach ($name in @('launch.lock', 'helper.lock', 'lifecycle-worker.lock', 'lifecycle-state.lock')) {
        $path = Join-Path $Root ('data\host_control\' + $name)
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        Assert-TliRemovalChild $Root $path
        try {
            $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $stream.Dispose()
        } catch { throw 'TLI or its helper still holds an installation lock. Stop both in local Setup, then retry.' }
    }
}

function Get-TliRemovalPlan([string]$Root) {
    $rootPath = Get-TliRemovalRoot $Root
    $blockers = @()
    # Large model/runtime trees are checked after the user confirms, before any
    # removal. Opening the review must not wait for a full virtualenv traversal.
    try { Assert-TliNotSourceCheckout $rootPath } catch { $blockers += $_.Exception.Message }
    try { Assert-TliRemovalIdle $rootPath } catch { $blockers += $_.Exception.Message }
    return [pscustomobject]@{
        root = $rootPath
        shortcuts = @(Get-TliRemovalShortcuts $rootPath)
        registration = $(if (Test-TliRemovalRegistration $rootPath) { Get-TliRemovalKey $rootPath } else { $null })
        completeRemovalBlockers = $blockers
        keepFiles = 'Remove Windows entries and keep all files in the installation folder.'
        removeEverything = 'Permanently delete the entire installation folder, including saved chats, credentials, Vault, backups and models inside it.'
        externalFiles = 'Files outside this folder, shared Python/LM Studio installations, browser storage and other Windows users are not changed.'
    }
}

function Remove-TliWindowsEntries([string]$Root, [string[]]$Shortcuts) {
    $allowedDirectories = @(Get-TliRemovalShortcutDirectories)
    $shell = New-Object -ComObject WScript.Shell
    foreach ($path in $Shortcuts) {
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        if ([IO.Path]::GetDirectoryName($path) -notin $allowedDirectories -or [IO.Path]::GetExtension($path) -ine '.lnk') { throw 'An unreviewed shortcut path was refused.' }
        Assert-TliUnlinkedPath $path
        if (!(Test-TliOwnedShortcut $Root ($shell.CreateShortcut($path)))) { throw 'A shortcut changed after review. It was preserved; review removal again.' }
        Remove-Item -LiteralPath $path -Force
    }
    if (Test-TliRemovalRegistration $Root) {
        $key = Get-TliRemovalKey $Root
        if (@(Get-ChildItem -LiteralPath $key).Count) { throw 'The Windows app entry contains unexpected subkeys and was preserved.' }
        Remove-Item -LiteralPath $key -Force
    }
}

function Invoke-TliRemoval([string]$Root, [ValidateSet('KeepFiles', 'Everything')][string]$Mode, [string]$Confirmation, [string[]]$ReviewedShortcuts) {
    $rootPath = Get-TliRemovalRoot $Root
    if ($Mode -eq 'Everything' -and $Confirmation -cne 'DELETE') { throw 'Complete removal requires typing DELETE in the confirmation box.' }
    Assert-TliRemovalIdle $rootPath
    if ($Mode -eq 'Everything') {
        Assert-TliNotSourceCheckout $rootPath
        $files = @(Get-TliRemovalFiles $rootPath)
        foreach ($path in $files) { Assert-TliRemovalChild $rootPath $path }
        Assert-TliRemovalIdle $rootPath
        Set-Location -LiteralPath ([IO.Path]::GetTempPath())
        [Environment]::CurrentDirectory = [IO.Path]::GetTempPath()
        # Keep the entry points until last so a locked data file can be retried.
        $late = @('TLI_Uninstall.ps1', 'Uninstall_TLI.bat', 'backend\main.py', 'frontend\index.html') | ForEach-Object { Join-Path $rootPath $_ }
        $regularFiles = @($files | Where-Object { (Test-Path -LiteralPath $_ -PathType Leaf) -and $_ -notin $late })
        foreach ($path in $regularFiles) { Assert-TliRemovalChild $rootPath $path; Remove-Item -LiteralPath $path -Force }
        foreach ($path in $late) { Assert-TliRemovalChild $rootPath $path; if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force } }
        foreach ($path in ($files | Sort-Object Length -Descending)) {
            if (Test-Path -LiteralPath $path -PathType Container) {
                Assert-TliRemovalChild $rootPath $path
                [IO.Directory]::Delete($path, $false)
            }
        }
        Assert-TliRemovalChild $rootPath $rootPath
        [IO.Directory]::Delete($rootPath, $false)
    }
    Remove-TliWindowsEntries $rootPath $ReviewedShortcuts
}

function Show-TliRemovalDialog([string]$Root, [switch]$Preview) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [Windows.Forms.Application]::EnableVisualStyles()
    $review = Get-TliRemovalPlan $Root
    $form = New-Object Windows.Forms.Form
    $form.Text = 'Remove TLI from this computer'
    $form.Size = New-Object Drawing.Size(760, 710)
    $form.MinimumSize = New-Object Drawing.Size(560, 460)
    $form.AutoScroll = $true
    $form.AutoScrollMinSize = New-Object Drawing.Size(730, 665)
    $workArea = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $form.Size = New-Object Drawing.Size(([Math]::Min(760, $workArea.Width - 30)), ([Math]::Min(710, $workArea.Height - 30)))
    $form.StartPosition = 'CenterScreen'
    $form.Font = New-Object Drawing.Font('Segoe UI', 10)
    $form.AutoScaleMode = 'Dpi'
    $heading = New-Object Windows.Forms.Label
    $heading.Text = "This installation only:`r`n$($review.root)"
    $heading.Location = New-Object Drawing.Point(22, 20)
    $heading.Size = New-Object Drawing.Size(690, 65)
    $form.Controls.Add($heading)
    $keep = New-Object Windows.Forms.RadioButton
    $keep.Text = 'Remove Windows entries and keep all files'
    $keep.Checked = $true
    $keep.Location = New-Object Drawing.Point(22, 92)
    $keep.Size = New-Object Drawing.Size(680, 30)
    $form.Controls.Add($keep)
    $keepHelp = New-Object Windows.Forms.Label
    $keepHelp.Text = 'Removes this installation''s shortcuts and Installed Apps entry. Its app, saved work, credentials, Vault and models stay in the folder above.'
    $keepHelp.Location = New-Object Drawing.Point(44, 126)
    $keepHelp.Size = New-Object Drawing.Size(650, 52)
    $form.Controls.Add($keepHelp)
    $everything = New-Object Windows.Forms.RadioButton
    $everything.Text = 'Completely remove TLI and everything in this folder'
    $everything.Location = New-Object Drawing.Point(22, 188)
    $everything.Size = New-Object Drawing.Size(680, 30)
    $form.Controls.Add($everything)
    $deleteHelp = New-Object Windows.Forms.Label
    $deleteHelp.Text = 'Permanently deletes the entire folder, including chats, credentials, Vault, local backups, downloaded models and any other files you saved there. Verify any backups outside this folder first. This does not use the Recycle Bin.'
    $deleteHelp.Location = New-Object Drawing.Point(44, 223)
    $deleteHelp.Size = New-Object Drawing.Size(650, 78)
    $form.Controls.Add($deleteHelp)
    $prompt = New-Object Windows.Forms.Label
    $prompt.Text = 'For complete removal, type DELETE:'
    $prompt.Location = New-Object Drawing.Point(44, 305)
    $prompt.Size = New-Object Drawing.Size(285, 28)
    $form.Controls.Add($prompt)
    $confirmation = New-Object Windows.Forms.TextBox
    $confirmation.Location = New-Object Drawing.Point(337, 302)
    $confirmation.Size = New-Object Drawing.Size(160, 28)
    $confirmation.Enabled = $false
    $form.Controls.Add($confirmation)
    $everything.Add_CheckedChanged({ $confirmation.Enabled = $everything.Checked })
    $details = New-Object Windows.Forms.TextBox
    $details.Multiline = $true
    $details.ReadOnly = $true
    $details.ScrollBars = 'Vertical'
    $details.Location = New-Object Drawing.Point(22, 350)
    $details.Size = New-Object Drawing.Size(690, 170)
    $details.Text = "Windows entries for this installation:`r`n" + (($review.shortcuts + @($review.registration) | Where-Object { $_ }) -join "`r`n") + "`r`n`r`n" + $review.externalFiles
    if ($review.completeRemovalBlockers.Count) { $details.Text += "`r`n`r`nComplete removal requires attention:`r`n" + ($review.completeRemovalBlockers -join "`r`n") }
    $form.Controls.Add($details)
    $advice = New-Object Windows.Forms.Label
    $advice.Text = 'Close TLI first. In local Setup, choose Stop helper and Stop TLI, then close Setup. Older diagnostic sessions must be stopped in their original terminal. Linked files or folders require manual review.'
    $advice.Location = New-Object Drawing.Point(22, 533)
    $advice.Size = New-Object Drawing.Size(690, 64)
    $form.Controls.Add($advice)
    $setup = New-Object Windows.Forms.Button
    $setup.Text = 'Open local Setup'
    $setup.Location = New-Object Drawing.Point(22, 614)
    $setup.Size = New-Object Drawing.Size(165, 34)
    $setup.Add_Click({
        try {
            $setupPath = Join-Path $review.root 'TLI_Setup.ps1'
            Assert-TliUnlinkedPath $setupPath
            if (!(Test-Path -LiteralPath $setupPath -PathType Leaf)) { throw 'Local Setup is missing. Close TLI and its helper manually.' }
            # Setup is explicitly requested and interactive; it needs its console.
            Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $setupPath + '"'))
        } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'TLI local Setup') | Out-Null }
    })
    $form.Controls.Add($setup)
    $cancel = New-Object Windows.Forms.Button
    $cancel.Text = 'Cancel'
    $cancel.Location = New-Object Drawing.Point(444, 614)
    $cancel.Size = New-Object Drawing.Size(100, 34)
    $cancel.Add_Click({ $form.Close() })
    $form.CancelButton = $cancel
    $form.Controls.Add($cancel)
    $remove = New-Object Windows.Forms.Button
    $remove.Text = 'Remove'
    $remove.Location = New-Object Drawing.Point(560, 614)
    $remove.Size = New-Object Drawing.Size(152, 34)
    $remove.Add_Click({
        $remove.Enabled = $false
        $cancel.Enabled = $false
        $setup.Enabled = $false
        $form.UseWaitCursor = $true
        $advice.Text = 'Checking this installation and completing removal. Large installations can take a few minutes. Please keep this window open.'
        $form.Refresh()
        try {
            $mode = if ($everything.Checked) { 'Everything' } else { 'KeepFiles' }
            Invoke-TliRemoval $review.root $mode $confirmation.Text $review.shortcuts
            $result = if ($mode -eq 'Everything') { 'TLI and this installation folder were removed.' } else { "This installation's Windows entries were removed. All files remain at:`r`n" + $review.root }
            [Windows.Forms.MessageBox]::Show($result, 'TLI removal completed', 'OK', 'Information') | Out-Null
            $form.Close()
        } catch {
            [Windows.Forms.MessageBox]::Show(($_.Exception.Message + "`r`n`r`nRemoval did not complete. Any remaining files and Windows entries can be reviewed locally."), 'TLI removal needs attention', 'OK', 'Warning') | Out-Null
        } finally { $remove.Enabled = $true; $cancel.Enabled = $true; $setup.Enabled = $true; $form.UseWaitCursor = $false }
    })
    $form.Controls.Add($remove)
    # Internal visual-QA path: construct a form without showing it or acting.
    if ($Preview) { return $form }
    $null = $form.ShowDialog()
    $form.Dispose()
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($Plan) { Get-TliRemovalPlan $PSScriptRoot | ConvertTo-Json -Depth 5 }
        else { Show-TliRemovalDialog $PSScriptRoot }
    } catch {
        if ($Plan) { Write-Error $_; exit 1 }
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'TLI removal needs attention', 'OK', 'Warning') | Out-Null
        exit 1
    }
}
