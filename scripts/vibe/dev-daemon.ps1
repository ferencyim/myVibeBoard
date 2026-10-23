# Start an isolated Paseo daemon for local vibe plugin development and install plugin directories.
# Never touches ~/.paseo or ~/.vibe: PASEO_HOME and VIBE_HOME live under -HomeDir.
# Requires a built server + CLI (npm run build:server), or pass -Build.
#
#   pwsh scripts/vibe/dev-daemon.ps1 -Plugin plugins/vibe-board          start + install
#   pwsh scripts/vibe/dev-daemon.ps1 -Plugin plugins/vibe-board -Reload  after editing plugin code
#   pwsh scripts/vibe/dev-daemon.ps1 -Stop                               stop the daemon
#
# Afterwards use the CLI against it:  node <Cli> --home <HomeDir>\paseo plugin ls
# For e2e tests export VIBE_HOME (printed below) so they never open the real vibe.db.
param(
  [string[]]$Plugin = @(),
  [string]$HomeDir = (Join-Path ([System.IO.Path]::GetTempPath()) "vibe-dev"),
  [int]$Port = 16767,
  [string]$Cli = "",
  [switch]$Build,
  [switch]$Reload,
  [switch]$Stop
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
if (-not $Cli) { $Cli = Join-Path $repo "packages/cli/dist/index.js" }

$paseoHome = Join-Path $HomeDir "paseo"
$vibeHome = Join-Path $HomeDir "vibe"
New-Item -ItemType Directory -Force -Path $paseoHome, $vibeHome | Out-Null
$env:PASEO_HOME = $paseoHome
$env:VIBE_HOME = $vibeHome

function Invoke-Paseo {
  & node $Cli --home $paseoHome @args
  if ($LASTEXITCODE -ne 0) { throw "paseo $args failed ($LASTEXITCODE)" }
}

if ($Stop) { Invoke-Paseo daemon stop; return }

if ($Build -or -not (Test-Path $Cli)) {
  Push-Location $repo
  try { npm run build:server; if ($LASTEXITCODE -ne 0) { throw "build:server failed" } } finally { Pop-Location }
}
if (-not (Test-Path $Cli)) { throw "CLI not found at $Cli; build first or pass -Cli" }

# `daemon start` ignores PASEO_LISTEN; the listen address comes from config.json.
# Plugins are off by default, so the isolated home enables them.
$configPath = Join-Path $paseoHome "config.json"
# Convert only the objects we edit to hashtables; this also works in Windows PowerShell 5.1.
$config = @{}
if (Test-Path $configPath) {
  $saved = Get-Content $configPath -Raw | ConvertFrom-Json
  foreach ($property in $saved.PSObject.Properties) { $config[$property.Name] = $property.Value }
}
$daemonConfig = @{}
if ($config.ContainsKey("daemon")) {
  foreach ($property in $config["daemon"].PSObject.Properties) { $daemonConfig[$property.Name] = $property.Value }
}
$config["daemon"] = $daemonConfig
if (-not $config.ContainsKey("version")) { $config["version"] = 1 }
if (-not $config.ContainsKey("daemon")) { $config["daemon"] = @{} }
$config["daemon"]["listen"] = "127.0.0.1:$Port"
$config["daemon"]["relay"] = @{ enabled = $false }
$config["pluginsEnabled"] = $true
$config | ConvertTo-Json -Depth 10 | Set-Content -Path $configPath -Encoding utf8

Write-Host "PASEO_HOME = $paseoHome"
Write-Host "VIBE_HOME  = $vibeHome"
Write-Host "Listen     = 127.0.0.1:$Port"
Invoke-Paseo daemon start --timeout 90

foreach ($dir in $Plugin) {
  $full = (Resolve-Path (Join-Path $repo $dir)).Path
  $manifest = Get-Content (Join-Path $full "paseo-plugin.json") -Raw | ConvertFrom-Json
  if ($Reload) { Invoke-Paseo plugin reload $manifest.id } else { Invoke-Paseo plugin install $full }
}
Invoke-Paseo plugin ls
