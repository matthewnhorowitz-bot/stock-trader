#!/usr/bin/env bash
# Removes everything deploy.sh created (except the container image and the state
# bucket's data, unless you pass DELETE_BUCKET=1).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID=your-gcp-project}"
REGION="${REGION:-us-central1}"
JOB="${JOB:-congress-notifier}"
BUCKET="${STATE_BUCKET:-${PROJECT_ID}-${JOB}-state}"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "▶ Deleting Cloud Scheduler trigger…"
gcloud scheduler jobs delete "${JOB}-trigger" --location="$REGION" --quiet 2>/dev/null || true

echo "▶ Deleting Cloud Run Job…"
gcloud run jobs delete "$JOB" --region="$REGION" --quiet 2>/dev/null || true

if [ "${DELETE_BUCKET:-0}" = "1" ]; then
  echo "▶ Deleting state bucket gs://$BUCKET…"
  gcloud storage rm --recursive "gs://$BUCKET" --quiet 2>/dev/null || true
fi

echo "✅ Torn down."
