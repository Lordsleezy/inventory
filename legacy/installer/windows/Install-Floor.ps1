#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Install = Join-Path $Root "Start-Floor.ps1"
if (-not (Test-Path $Install)) { throw "Start-Floor.ps1 is missing next to this script." }

function New-Secret([int]$Bytes = 24) {
  $buf = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
  return ([Convert]::ToBase64String($buf) -replace "[^A-Za-z0-9]", "x")
}

Write-Host "Floor first-time setup (Windows)"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Install Docker Desktop (ARM64 build on ARM machines) and start it, then run this again."
}

$State = Join-Path $Root "state"
New-Item -ItemType Directory -Force -Path (Join-Path $State "config") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $State "data") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $State "inventree") | Out-Null

$ExampleFloor = Join-Path $Root "config\floor.example.json"
$FloorJson = Join-Path $State "config\floor.json"
if ((Test-Path $ExampleFloor) -and -not (Test-Path $FloorJson)) {
  Copy-Item $ExampleFloor $FloorJson
}

$EnvExample = Join-Path $Root "infra\inventree\.env.example"
$EnvFile = Join-Path $Root "infra\inventree\.env"
if (-not (Test-Path $EnvFile)) {
  if (-not (Test-Path $EnvExample)) { throw "Missing infra\inventree\.env.example" }
  Copy-Item $EnvExample $EnvFile
  $pwd = Read-Host "InvenTree admin password (used only for the first Docker bootstrap)"
  if (-not $pwd) { throw "An InvenTree admin password is required" }
  $key = New-Secret 32
  $raw = Get-Content $EnvFile -Raw
  $raw = $raw -replace "YOUR_INVENTREE_ADMIN_PASSWORD", $pwd
  $raw = $raw -replace "YOUR_LONG_RANDOM_SECRET_KEY", $key
  Set-Content -Path $EnvFile -Value $raw -NoNewline
}

$FloorEnv = Join-Path $State "floor.env"
if (-not (Test-Path $FloorEnv)) {
  $pin = Read-Host "Floor unlock PIN (4-8 digits)"
  if ($pin -notmatch "^\d{4,8}$") { throw "PIN must be 4 to 8 digits" }
  $session = New-Secret 32
  @(
    "FLOOR_DEV_PIN=$pin"
    "FLOOR_SESSION_SECRET=$session"
    "INVENTREE_URL=http://127.0.0.1:8000"
    "INVENTREE_ADMIN_USER=admin"
  ) | Set-Content -Path $FloorEnv
}

$env:INVENTREE_DATA = Join-Path $State "inventree"
Push-Location (Join-Path $Root "infra\inventree")
try {
  Write-Host "Pulling InvenTree (linux/arm64 on ARM PCs, linux/amd64 on x64)…"
  docker compose pull
  docker compose run --rm inventree invoke update
  docker compose up -d
} finally {
  Pop-Location
}

Write-Host "Starting Floor at http://127.0.0.1:3000"
& $Install
