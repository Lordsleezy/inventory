#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$State = Join-Path $Root "state"
$env:INVENTREE_DATA = Join-Path $State "inventree"
Push-Location (Join-Path $Root "infra\inventree")
try {
  docker compose down
} finally {
  Pop-Location
}
Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Write-Host "Floor adapter and InvenTree containers stopped."
