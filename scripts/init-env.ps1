# MeetFlow v0.2 — .env 최초 생성 (Windows PowerShell 5.1 호환)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
if (Test-Path $envPath) { Write-Host '[MeetFlow] .env 가 이미 있습니다. 그대로 사용합니다.'; exit 0 }

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
# BOM 없는 UTF-8 (docker compose 가 BOM 을 변수명으로 읽지 않도록)
[System.IO.File]::WriteAllLines($envPath, $out, (New-Object System.Text.UTF8Encoding $false))
Write-Host "[MeetFlow] .env 생성 완료. 호스트 코드: $hostCode  (회의 만들기 화면에서 사용)"
