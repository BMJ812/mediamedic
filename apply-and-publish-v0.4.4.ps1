$ErrorActionPreference = 'Stop'

$RepoRoot = 'C:\Dev\MediaMedic'
$PatchRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

Set-Location $RepoRoot

Write-Host "`n=== MEDIAMEDIC V0.4.4 — DISCORD SCOPE VALIDATION ===" -ForegroundColor Cyan

if (-not (Test-Path '.git')) {
    throw "Git repository not found at $RepoRoot"
}

$Required = @(
    (Join-Path $PatchRoot 'src\web.js'),
    (Join-Path $PatchRoot 'src\settings.js'),
    (Join-Path $PatchRoot 'package.json'),
    (Join-Path $PatchRoot 'validate-v0.4.4.mjs'),
    '.\src\web.js',
    '.\src\settings.js',
    '.\public\index.html',
    '.\package.json'
)

foreach ($Path in $Required) {
    if (-not (Test-Path $Path)) {
        throw "Missing required file: $Path"
    }
}

$CurrentVersion = (Get-Content '.\package.json' -Raw | ConvertFrom-Json).version
Write-Host "Current repo version: $CurrentVersion" -ForegroundColor DarkGray

if ([version]$CurrentVersion -gt [version]'0.4.4') {
    throw "Repository is already newer than v0.4.4. Refusing to apply an older patch."
}

$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path $RepoRoot "backup-v0.4.4-$Timestamp"
New-Item -ItemType Directory -Path (Join-Path $BackupDir 'src') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $BackupDir 'public') -Force | Out-Null

Copy-Item '.\src\web.js' (Join-Path $BackupDir 'src\web.js') -Force
Copy-Item '.\src\settings.js' (Join-Path $BackupDir 'src\settings.js') -Force
Copy-Item '.\public\index.html' (Join-Path $BackupDir 'public\index.html') -Force
Copy-Item '.\package.json' (Join-Path $BackupDir 'package.json') -Force

Write-Host "Backup created: $BackupDir" -ForegroundColor DarkGray

Copy-Item (Join-Path $PatchRoot 'src\web.js') '.\src\web.js' -Force
Copy-Item (Join-Path $PatchRoot 'src\settings.js') '.\src\settings.js' -Force
Copy-Item (Join-Path $PatchRoot 'package.json') '.\package.json' -Force

# Improve the two Discord scope fields without replacing the entire HTML file.
$IndexPath = Join-Path $RepoRoot 'public\index.html'
$Index = [System.IO.File]::ReadAllText($IndexPath)

$Index = $Index.Replace('v0.4.2', 'v0.4.4')
$Index = $Index.Replace('v0.4.3', 'v0.4.4')
$Index = $Index.Replace(
    'Repair Role ID <span class="muted">(optional)</span>',
    'Repair Role ID <span class="muted">(optional — role only)</span>'
)
$Index = $Index.Replace(
    '<label>Allowed Channel ID</label>',
    '<label>Allowed Channel ID <span class="muted">(channel only)</span></label>'
)
$Index = $Index.Replace(
    'Allowed Channel ID <span class="muted">(recommended)</span>',
    'Allowed Channel ID <span class="muted">(recommended — channel only)</span>'
)
$Index = $Index.Replace(
    'Leave blank if you want to rely on Discord admins during initial testing.',
    'Leave blank if you want to rely on Discord admins during initial testing. Paste a Discord role ID only — never a channel ID.'
)
$Index = $Index.Replace(
    'Leave blank during initial testing.',
    'Leave blank during initial testing. If used, this must be a Discord role ID — never a channel ID.'
)
$Index = $Index.Replace(
    'Right-click the issue channel and choose <b>Copy Channel ID</b>.',
    'Right-click the issue channel and choose <b>Copy Channel ID</b>. This must be a channel ID — never a role ID.'
)
$Index = $Index.Replace(
    'Commands, autocomplete, and confirmation buttons will only work in this channel. Leave blank to allow all channels in the configured server.',
    'Commands, autocomplete, and confirmation buttons will only work in this channel. This must be a Discord channel ID — never a role ID. Leave blank to allow all channels in the configured server.'
)

[System.IO.File]::WriteAllText($IndexPath, $Index, $Utf8NoBom)

Write-Host "`n=== VALIDATE SOURCE ===" -ForegroundColor Cyan
npm run check
node (Join-Path $PatchRoot 'validate-v0.4.4.mjs') $RepoRoot

git diff --check

Write-Host "`n=== PATCH DIFF ===" -ForegroundColor Cyan
git diff -- src/web.js src/settings.js public/index.html package.json

$ExistingTag = git tag --list 'v0.4.4'
if ($ExistingTag) {
    throw "Local tag v0.4.4 already exists. Review the repository before re-running this publisher."
}

$RemoteTag = git ls-remote --tags origin 'refs/tags/v0.4.4'
if ($RemoteTag) {
    throw "Remote tag v0.4.4 already exists. Review GitHub before re-running this publisher."
}

Write-Host "`n=== COMMIT + TAG ===" -ForegroundColor Cyan
git add src/web.js src/settings.js public/index.html package.json
git commit -m 'fix: validate Discord channel and role scope'
git tag -a v0.4.4 -m 'MediaMedic v0.4.4 - Discord scope validation'

Write-Host "`n=== PUSH ===" -ForegroundColor Cyan
git push origin main
git push origin v0.4.4

Write-Host "`nMediaMedic v0.4.4 pushed successfully." -ForegroundColor Green
Write-Host "GitHub Actions should now validate and publish ghcr.io/bmj812/mediamedic:latest and :v0.4.4." -ForegroundColor Green
