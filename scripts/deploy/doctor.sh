#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

env_file=
secrets_file=
out=out/manifests
bundle=
images_lock=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env) env_file="$2"; shift 2 ;;
    --secrets) secrets_file="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --bundle) bundle="$2"; shift 2 ;;
    --images-lock) images_lock="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$env_file" ] || { echo "--env is required" >&2; exit 2; }
[ -n "$secrets_file" ] || { echo "--secrets is required" >&2; exit 2; }

source "$env_file"
source "$secrets_file"

for required in POSTGRES_APP_URL APP_SESSION_SECRET; do
  [ -n "${!required:-}" ] || { echo "$required is required for app deploy" >&2; exit 1; }
done

[ -f third_party/botified/PINNED_SOURCE.json ] || { echo "Botified vendored source pin is missing" >&2; exit 1; }
[ -d infra/db/migrations ] || { echo "schema migration bundle is missing" >&2; exit 1; }

if [ -d "$out" ] && rg -q 'S3_ACCESS_KEY|S3_SECRET_KEY|JUICEFS_META_URL' "$out"; then
  echo "app manifests contain substrate-only secrets" >&2
  exit 1
fi

if [ -d "$out" ]; then
  rg -q 'kind: Deployment' "$out" || { echo "rendered app Deployment missing" >&2; exit 1; }
  rg -q 'agentsmith-lite-schema-bootstrap' "$out" || { echo "schema bootstrap Job missing" >&2; exit 1; }
  rg -q 'kind: Role' "$out" || { echo "sandbox RBAC Role missing" >&2; exit 1; }
  if rg -q 'watch|pods/(exec|log|attach|portforward)|persistentvolumes|persistentvolumeclaims' "$out"; then
    echo "app RBAC includes a forbidden resource" >&2
    exit 1
  fi
fi

if [ -n "$bundle" ] || [ -n "$images_lock" ]; then
  if [ ! -f dist/packages/sandbox-controller/src/appImageLock.js ]; then
    npm run build >/dev/null
  fi

  check_args=(--out "$out")
  if [ -n "$bundle" ]; then
    check_args+=(--bundle "$bundle")
  fi
  if [ -n "$images_lock" ]; then
    check_args+=(--images-lock "$images_lock")
  fi

  node scripts/deploy/app-doctor-check.mjs "${check_args[@]}"
fi

mkdir -p out
cat > out/app-doctor-report.json <<REPORT
{
  "schema": "agentsmith-lite.app-doctor/v1",
  "checks": {
    "app_images": "offline bundle, images.lock, and rendered manifests are checked when provided",
    "schema_job": "expected agentsmith-lite-schema-bootstrap",
    "web_api_readiness": "expected agentsmith-lite-api deployment/service",
    "sandbox_rbac": "expected namespaced Role without exec subresource",
    "botified_smoke": "uses third_party/botified/PINNED_SOURCE.json and botified serve"
  },
  "secret_policy": "only product secrets are rendered to app-owned Kubernetes Secrets"
}
REPORT
echo "App doctor passed. Report: out/app-doctor-report.json"
