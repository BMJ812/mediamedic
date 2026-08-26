$ErrorActionPreference = 'Stop'

Set-Location 'C:\Dev\MediaMedic'

Write-Host "`n=== MEDIAMEDIC V0.4.3 AUTH SESSION FIX ===" -ForegroundColor Cyan

$PatchRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path (Get-Location) "backup-v0.4.3-$Timestamp"

New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $BackupDir 'src') -Force | Out-Null

Copy-Item '.\src\web.js' (Join-Path $BackupDir 'src\web.js') -Force
Copy-Item '.\package.json' (Join-Path $BackupDir 'package.json') -Force

Copy-Item (Join-Path $PatchRoot 'src\web.js') '.\src\web.js' -Force
Copy-Item (Join-Path $PatchRoot 'package.json') '.\package.json' -Force

Write-Host "Backup created: $BackupDir" -ForegroundColor DarkGray

Write-Host "`n=== VALIDATE ===" -ForegroundColor Cyan
npm run check

git diff --check

Write-Host "`n=== GIT DIFF ===" -ForegroundColor Cyan
git diff -- src/web.js package.json

Write-Host "`n=== COMMIT + TAG ===" -ForegroundColor Cyan
git add src/web.js package.json
git commit -m 'fix: persist Web UI auth sessions across restarts'

git tag -a v0.4.3 -m 'MediaMedic v0.4.3 - Web UI auth session fix'

Write-Host "`n=== PUSH ===" -ForegroundColor Cyan
git push origin main
git push origin v0.4.3

Write-Host "`nMediaMedic v0.4.3 pushed. GitHub Actions should build/publish the updated container." -ForegroundColor Green
