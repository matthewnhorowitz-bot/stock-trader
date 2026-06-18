# Uploads every KEY=VALUE line in your .env as a GitHub Actions secret (Windows /
# PowerShell version of set-github-secrets.sh). Skips comments, blanks, and
# STATE_BUCKET (the GitHub path stores state in the repo, not GCS).
#
# Prereqs:
#   - gh CLI installed + logged in:  gh auth login
#   - run from the repo root, AFTER the repo exists on GitHub
#
# Usage:
#   .\deploy\set-github-secrets.ps1            # reads .\.env
#   .\deploy\set-github-secrets.ps1 path\.env  # custom file
param([string]$EnvFile = ".env")

if (-not (Test-Path $EnvFile)) {
  Write-Error "$EnvFile not found. Copy .env.example to .env and fill it in."
  exit 1
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Error "gh CLI not found. Install it (https://cli.github.com) and run: gh auth login"
  exit 1
}

$count = 0
foreach ($line in Get-Content $EnvFile) {
  $trimmed = $line.Trim()
  if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
  $idx = $line.IndexOf('=')
  if ($idx -lt 1) { continue }
  $key = $line.Substring(0, $idx).Trim()
  $val = $line.Substring($idx + 1)
  if ($key -eq 'STATE_BUCKET') { Write-Host "- skipping STATE_BUCKET (not used on GitHub)"; continue }
  # Skip empty values: an absent secret behaves the same as an empty one, and
  # `gh secret set` rejects an empty body.
  if ([string]::IsNullOrWhiteSpace($val)) { Write-Host "- skipping $key (empty)"; continue }
  # --body passes the exact value (no trailing newline that stdin piping would add).
  gh secret set $key --body $val
  Write-Host "set $key"
  $count++
}

Write-Host ""
Write-Host "Uploaded $count secrets. Trigger a run: gh workflow run 'Congress Trade Notifier'"
