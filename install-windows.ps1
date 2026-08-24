$ErrorActionPreference = 'Stop'

$ProjectRoot = 'C:\Dev\MediaMedic'
New-Item -ItemType Directory -Path $ProjectRoot -Force | Out-Null
Set-Location $ProjectRoot

Write-Host 'MediaMedic source should be extracted into:' -ForegroundColor Cyan
Write-Host $ProjectRoot -ForegroundColor Yellow
Write-Host ''
Write-Host 'After extraction:' -ForegroundColor Cyan
Write-Host '  1. Copy .env.example to .env'
Write-Host '  2. Fill in Discord/Radarr/Sonarr values'
Write-Host '  3. Run: docker compose up -d --build'
Write-Host '  4. Run /mediamedic health in Discord'
