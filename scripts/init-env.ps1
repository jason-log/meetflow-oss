# MeetFlow v0.2 — create .env on first run (Windows PowerShell 5.1 compatible)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
if (Test-Path $envPath) { Write-Host '[MeetFlow] .env already exists. Using it as is.'; exit 0 }

function New-Hex([int]$bytes) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  -join ($b | ForEach-Object { $_.ToString('x2') })
}
$key = 'API' + (New-Hex 6)
$secret = New-Hex 24
$hostCode = New-Hex 5

$lines = Get-Content (Join-Path $root '.env.example') -Encoding UTF8
$out = foreach ($l in $lines) {
  if ($l -like 'LIVEKIT_API_KEY=__GENERATE__*') { "LIVEKIT_API_KEY=$key" }
  elseif ($l -like 'LIVEKIT_API_SECRET=__GENERATE__*') { "LIVEKIT_API_SECRET=$secret" }
  elseif ($l -like 'HOST_ACCESS_CODE=__GENERATE__*') { "HOST_ACCESS_CODE=$hostCode" }
  else { $l }
}
# UTF-8 without BOM (so docker compose does not read the BOM as part of a variable name)
[System.IO.File]::WriteAllLines($envPath, $out, (New-Object System.Text.UTF8Encoding $false))
Write-Host "[MeetFlow] .env created. Host code: $hostCode  (enter it on the create-meeting screen)"
