#!/usr/bin/env bash
# One-shot deploy of the Congress Trade Notifier to Google Cloud as a
# Cloud Run Job triggered every 30 minutes by Cloud Scheduler.
#
# Prereqs:
#   - gcloud CLI installed + logged in:  gcloud auth login
#   - A billing-enabled GCP project
#   - deploy/env.yaml filled in (copy from deploy/env.yaml.example)
#
# Usage:
#   PROJECT_ID=my-project ./deploy/deploy.sh
#
# Re-running is safe — it updates the image, job, and schedule in place.
set -euo pipefail

# ── settings (override via env) ───────────────────────────────────────────────
PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID=your-gcp-project}"
REGION="${REGION:-us-central1}"
JOB="${JOB:-congress-notifier}"
SCHEDULE="${SCHEDULE:-*/30 * * * *}"          # every 30 min
IMAGE="gcr.io/${PROJECT_ID}/${JOB}"
BUCKET="${STATE_BUCKET:-${PROJECT_ID}-${JOB}-state}"
SA="${JOB}-sa@${PROJECT_ID}.iam.gserviceaccount.com"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"

echo "▶ Project: $PROJECT_ID   Region: $REGION   Job: $JOB"
echo "▶ State bucket: gs://$BUCKET"

[ -f "$HERE/env.yaml" ] || { echo "✗ Missing deploy/env.yaml (copy from env.yaml.example)"; exit 1; }

gcloud config set project "$PROJECT_ID" >/dev/null

echo "▶ Enabling required APIs…"
gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com \
  storage.googleapis.com \
  artifactregistry.googleapis.com >/dev/null

echo "▶ Ensuring state bucket exists…"
gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 \
  || gcloud storage buckets create "gs://$BUCKET" --location="$REGION"

echo "▶ Ensuring service account exists…"
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "${JOB}-sa" --display-name="$JOB runtime"

# Runtime SA needs read/write on its state bucket.
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$SA" --role="roles/storage.objectAdmin" >/dev/null

echo "▶ Building container image with Cloud Build…"
gcloud builds submit "$ROOT" --tag "$IMAGE"

# Inject the resolved bucket name into the env file passed to the job.
TMP_ENV="$(mktemp)"
sed "s|REPLACED_BY_DEPLOY_SCRIPT|$BUCKET|" "$HERE/env.yaml" > "$TMP_ENV"
trap 'rm -f "$TMP_ENV"' EXIT

echo "▶ Deploying Cloud Run Job…"
if gcloud run jobs describe "$JOB" --region="$REGION" >/dev/null 2>&1; then
  gcloud run jobs update "$JOB" \
    --image="$IMAGE" --region="$REGION" \
    --service-account="$SA" \
    --set-env-vars="STATE_BUCKET=$BUCKET" \
    --env-vars-file="$TMP_ENV" \
    --max-retries=1 --task-timeout=300s
else
  gcloud run jobs create "$JOB" \
    --image="$IMAGE" --region="$REGION" \
    --service-account="$SA" \
    --set-env-vars="STATE_BUCKET=$BUCKET" \
    --env-vars-file="$TMP_ENV" \
    --max-retries=1 --task-timeout=300s
fi

# Scheduler needs permission to execute the job.
gcloud run jobs add-iam-policy-binding "$JOB" --region="$REGION" \
  --member="serviceAccount:$SA" --role="roles/run.invoker" >/dev/null 2>&1 || true

RUN_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB}:run"

echo "▶ Creating / updating Cloud Scheduler trigger ($SCHEDULE)…"
if gcloud scheduler jobs describe "${JOB}-trigger" --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${JOB}-trigger" --location="$REGION" \
    --schedule="$SCHEDULE" --uri="$RUN_URI" --http-method=POST \
    --oauth-service-account-email="$SA"
else
  gcloud scheduler jobs create http "${JOB}-trigger" --location="$REGION" \
    --schedule="$SCHEDULE" --uri="$RUN_URI" --http-method=POST \
    --oauth-service-account-email="$SA"
fi

echo ""
echo "✅ Deployed. The notifier now runs every 30 min on Google Cloud."
echo "   Run once now:  gcloud run jobs execute $JOB --region=$REGION"
echo "   View logs:     gcloud beta run jobs logs read $JOB --region=$REGION"
echo "   Tear down:     ./deploy/teardown.sh"
