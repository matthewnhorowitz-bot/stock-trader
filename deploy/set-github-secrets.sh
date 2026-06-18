#!/usr/bin/env bash
# Uploads every KEY=VALUE line in your .env as a GitHub Actions secret, so the
# scheduled workflow can use them. Skips comments, blanks, and STATE_BUCKET
# (the GitHub path stores state in the repo, not GCS).
#
# Prereqs:
#   - gh CLI installed + logged in:   gh auth login
#   - run from the repo root, AFTER the repo exists on GitHub
#
# Usage:
#   ./deploy/set-github-secrets.sh            # reads ./.env
#   ./deploy/set-github-secrets.sh path/.env  # custom file
set -euo pipefail

ENV_FILE="${1:-.env}"
[ -f "$ENV_FILE" ] || { echo "✗ $ENV_FILE not found. Copy .env.example to .env and fill it in."; exit 1; }

command -v gh >/dev/null 2>&1 || { echo "✗ gh CLI not found. Install it: https://cli.github.com"; exit 1; }

count=0
while IFS= read -r line || [ -n "$line" ]; do
  # skip blanks and comments
  case "$line" in ''|\#*) continue;; esac
  # must look like KEY=VALUE
  case "$line" in *=*) ;; *) continue;; esac
  key="${line%%=*}"
  val="${line#*=}"
  key="$(echo "$key" | tr -d '[:space:]')"
  [ -z "$key" ] && continue
  [ "$key" = "STATE_BUCKET" ] && { echo "· skipping STATE_BUCKET (not used on GitHub)"; continue; }
  # Skip empty values: an absent secret behaves the same, and gh rejects empties.
  [ -z "$val" ] && { echo "· skipping $key (empty)"; continue; }
  printf '%s' "$val" | gh secret set "$key"
  echo "✓ set $key"
  count=$((count + 1))
done < "$ENV_FILE"

echo ""
echo "✅ Uploaded $count secrets. Trigger a run: gh workflow run \"Congress Trade Notifier\""
