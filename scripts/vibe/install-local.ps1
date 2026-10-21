# Install myVibeBoard for daily use on this Windows machine, side by side with an official Paseo install.
#
# - Copies the built desktop app (packages/desktop/release/win-unpacked) and the vibe plugins into $InstallDir.
# - Uses its own data dirs ($InstallDir\data\paseo = PASEO_HOME, \vibe = VIBE_HOME, \electron = Electron userData)
#   and its own port, so it never touches ~/.paseo or the official app.
# - Registers a per-user logon task that starts the daemon hidden, and a Start-menu shortcut for the desktop app.
#
# Build first (docs/vibe/BUILD.md): npm run build:server, the desktop win-unpacked package, plugin npm ci.
# Re-running is safe: files are copied over, config keys are merged, the task is replaced.
#
#   pwsh scripts/vibe/install-local.ps1 -RelayEndpoint <RELAY_DOMAIN>:443 -PushGateway https://<RELAY_DOMAIN>/push `
#        -PushTokenFile <file containing the gateway token>
param(
  [string]$InstallDir = "D:\Programs\myVibeBoard",
  [int]$Port = 6868,
  [string]$WorktreesRoot = "D:\devRepoCaches\worktrees\myvibeboard-agents",
  [string]$RelayEndpoint = "",
  [string]$PushGateway = "",
  [string]$PushTokenFile = "",
  [string[]]$Plugins = @(
    "vibe-board", "vibe-context", "vibe-master", "vibe-scheduler",
    "vibe-maintain", "vibe-stats", "vibe-verify", "switch-provider"
  ),
  [switch]$SkipCopy
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$appSrc = Join-Path $repo "packages\desktop\release\win-unpacked"
$appDir = Join-Path $InstallDir "app"
$exe = Join-Path $appDir "Paseo.exe"
$cli = Join-Path $appDir "resources\bin\paseo.cmd"
$pluginsDir = Join-Path $InstallDir "plugins"
$dataDir = Join-Path $InstallDir "data"
$paseoHome = Join-Path $dataDir "paseo"
$vibeHome = Join-Path $dataDir "vibe"
$electronData = Join-Path $dataDir "electron"
$tokenTarget = Join-Path $dataDir "push-gateway.token"

function Copy-Tree($from, $to) {
  # robocopy /E copies and overwrites; it never deletes anything in the target.
  robocopy $from $to /E /NFL /NDL /NJH /NJS /NP /R:2 /W:2 /XD .git test __tests__ | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $from -> $to failed ($LASTEXITCODE)" }
  $global:LASTEXITCODE = 0
}

New-Item -ItemType Directory -Force -Path $InstallDir, $pluginsDir, $paseoHome, $vibeHome, $electronData, $WorktreesRoot | Out-Null

if (-not $SkipCopy) {
  if (-not (Test-Path (Join-Path $appSrc "Paseo.exe"))) { throw "Desktop build not found at $appSrc" }
  # Catches plugin problems the daemon would only report at load time (e.g. a client bundle importing server/).
  node (Join-Path $repo "scripts/vibe/check-plugins.mjs")
  if ($LASTEXITCODE -ne 0) { throw "check-plugins failed; fix the plugins before installing" }
  if (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($appDir, "OrdinalIgnoreCase") }) {
    throw "myVibeBoard is running from $appDir; stop it first (stop-daemon.ps1 and close the window)."
  }
  Copy-Tree $appSrc $appDir
  foreach ($p in $Plugins) {
    $src = Join-Path $repo "plugins\$p"
    if (-not (Test-Path (Join-Path $src "node_modules"))) { throw "Run npm ci in plugins\$p first" }
    Copy-Tree $src (Join-Path $pluginsDir $p)
  }
}

if ($PushTokenFile) {
  Copy-Item -Force $PushTokenFile $tokenTarget
  icacls $tokenTarget /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
}

# Merge config.json (keeps anything the user changed).
$configPath = Join-Path $paseoHome "config.json"
$config = if (Test-Path $configPath) { Get-Content $configPath -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
if (-not $config.ContainsKey("version")) { $config["version"] = 1 }
if (-not $config.ContainsKey("daemon")) { $config["daemon"] = @{} }
$config["daemon"]["listen"] = "127.0.0.1:$Port"
$config["pluginsEnabled"] = $true
if (-not $config.ContainsKey("worktrees")) { $config["worktrees"] = @{} }
$config["worktrees"]["root"] = $WorktreesRoot
if ($RelayEndpoint) { $config["daemon"]["relay"] = @{ enabled = $true; endpoint = $RelayEndpoint; useTls = $true } }
if ($PushGateway) { $config["daemon"]["push"] = @{ gateway = $PushGateway } }
$config | ConvertTo-Json -Depth 20 | Set-Content -Path $configPath -Encoding utf8

# Launchers. The desktop package ships its own CLI (resources\bin\paseo.cmd runs it on the bundled runtime).
$envBlock = @"
`$env:PASEO_HOME = '$paseoHome'
`$env:VIBE_HOME = '$vibeHome'
`$tokenFile = '$tokenTarget'
if (Test-Path `$tokenFile) { `$env:PASEO_PUSH_GATEWAY_TOKEN = (Get-Content `$tokenFile -Raw).Trim() }
"@
Set-Content -Encoding utf8 (Join-Path $InstallDir "start-daemon.ps1") @"
# Starts the myVibeBoard daemon (used by the logon task).
$envBlock
& '$cli' daemon start --home '$paseoHome' --timeout 120 *>> '$dataDir\start-daemon.log'
"@
Set-Content -Encoding utf8 (Join-Path $InstallDir "stop-daemon.ps1") @"
& '$cli' daemon stop --home '$paseoHome'
"@
Set-Content -Encoding utf8 (Join-Path $InstallDir "paseo.ps1") @"
# CLI against the myVibeBoard daemon, e.g.  .\paseo.ps1 plugin ls
$envBlock
& '$cli' --home '$paseoHome' @args
"@
Set-Content -Encoding utf8 (Join-Path $InstallDir "launch-desktop.ps1") @"
$envBlock
`$env:PASEO_ELECTRON_USER_DATA_DIR = '$electronData'
Start-Process -FilePath '$exe'
"@

$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = (Get-Command powershell).Source }

# Per-user logon task (no admin rights needed): start the daemon hidden.
$action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$InstallDir\start-daemon.ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName "myVibeBoard Daemon" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

# Start-menu shortcut for the desktop app.
$lnk = Join-Path ([Environment]::GetFolderPath("Programs")) "myVibeBoard.lnk"
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = $pwsh
$s.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$InstallDir\launch-desktop.ps1`""
$s.IconLocation = "$exe,0"
$s.WorkingDirectory = $InstallDir
$s.Save()

Write-Host "Installed to $InstallDir (PASEO_HOME=$paseoHome, port $Port)."
Write-Host "Next: start the daemon (Start-ScheduledTask 'myVibeBoard Daemon'), then install plugins:"
foreach ($p in $Plugins) { Write-Host "  & '$InstallDir\paseo.ps1' plugin install '$(Join-Path $pluginsDir $p)'" }
