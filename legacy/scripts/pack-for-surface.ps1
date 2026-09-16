# Copy this repo onto a USB stick (or any folder) without node_modules.
# Usage:
#   powershell -File scripts\pack-for-surface.ps1 E:\
# Result: E:\liquidation-os\  ready to copy onto the Surface.

param(
  [Parameter(Mandatory = $true)]
  [string]$Destination
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$target = Join-Path $Destination "liquidation-os"

New-Item -ItemType Directory -Force -Path $target | Out-Null
robocopy $root $target /E /XD node_modules .git data /XF *.log /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) {
  throw "robocopy failed with exit $LASTEXITCODE"
}

Write-Host "PASS  copied to $target"
Write-Host "      plug the drive into the Surface and copy that folder to ~/liquidation-os"
