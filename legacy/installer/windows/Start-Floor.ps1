#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$State = Join-Path $Root "state"
New-Item -ItemType Directory -Force -Path (Join-Path $State "config") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $State "data") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $State "inventree") | Out-Null

$Arch = $env:PROCESSOR_ARCHITECTURE
if ($Arch -eq "ARM64") { $NodeName = "node-win-arm64" } else { $NodeName = "node-win-x64" }
$Node = Join-Path $Root "runtime\$NodeName\node.exe"
if (-not (Test-Path $Node)) { throw "Bundled Node not found: $Node" }

$FloorEnv = Join-Path $State "floor.env"
if (Test-Path $FloorEnv) {
  Get-Content $FloorEnv | ForEach-Object {
    if ($_ -match "^\s*#" -or $_ -notmatch "=") { return }
    $k, $v = $_.Split("=", 2)
    Set-Item -Path "Env:$k" -Value $v
  }
}

$env:FLOOR_ROOT = $State
if (-not $env:INVENTREE_URL) { $env:INVENTREE_URL = "http://127.0.0.1:8000" }
$env:INVENTREE_DATA = Join-Path $State "inventree"
$env:NODE_ENV = "production"
$env:PORT = "3000"
$env:HOSTNAME = "127.0.0.1"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker Desktop is not on PATH. Start Docker Desktop, then run this again."
}

Push-Location (Join-Path $Root "infra\inventree")
try {
  docker compose up -d
} finally {
  Pop-Location
}

$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  try {
    $code = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "$($env:INVENTREE_URL)/api/").StatusCode
    if ($code -ge 200 -and $code -lt 500) { $ok = $true; break }
  } catch { }
  Start-Sleep -Seconds 2
}
if (-not $ok) { Write-Warning "InvenTree did not answer yet. Floor will keep retrying from the UI." }

$Server = Join-Path $Root "app\apps\adapter\server.js"
if (-not (Test-Path $Server)) { throw "Packaged adapter missing: $Server" }

Write-Host "Floor adapter  http://127.0.0.1:3000"
Write-Host "InvenTree      $($env:INVENTREE_URL)"
Start-Process "http://127.0.0.1:3000/login"
Set-Location (Join-Path $Root "app")
& $Node $Server
