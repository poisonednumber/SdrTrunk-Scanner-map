# Scanner Map self-update (Windows): pull latest code, install deps, migrate DB.
# Invoked by Settings -> Updates, or run manually:  powershell -File scripts\update.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

Write-Host "==> Scanner Map update starting"
try { $v = (node -e "console.log(require('./package.json').version)") } catch { $v = 'unknown' }
Write-Host "==> Current version: $v"

if (-not (Test-Path .git)) {
  Write-Host "!! Not a git checkout. Re-download the latest release to update."
  exit 1
}

Write-Host "==> Stashing any local changes (kept in git stash)"
try { git stash push -u -m "scanner-map-autoupdate-$(Get-Date -UFormat %s)" } catch { }

Write-Host "==> Pulling latest from git"
git pull --ff-only

Write-Host "==> Installing Node dependencies"
try { npm install --omit=dev } catch { npm install }

Write-Host "==> Running database migrations"
try { node scripts/migrate.js } catch { Write-Host "!! migrate step reported an issue (continuing)" }

try { $v2 = (node -e "console.log(require('./package.json').version)") } catch { $v2 = 'unknown' }
Write-Host "==> New version: $v2"
Write-Host "==> Update complete. Restart Scanner Map to apply."
