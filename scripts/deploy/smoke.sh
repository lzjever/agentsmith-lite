#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

base_url=
endpoint_base_url=
endpoint_model=
endpoint_secret_ref=
task_smoke=false
task_reclaim_smoke=false
task_reclaim_reap_apply=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-url) base_url="$2"; shift 2 ;;
    --env) source "$2"; [ -n "$base_url" ] || base_url="${APP_PUBLIC_BASE_URL:-}"; shift 2 ;;
    --secrets) source "$2"; shift 2 ;;
    --endpoint-base-url) endpoint_base_url="$2"; shift 2 ;;
    --endpoint-model) endpoint_model="$2"; shift 2 ;;
    --endpoint-secret-ref) endpoint_secret_ref="$2"; shift 2 ;;
    --task-smoke) task_smoke=true; shift ;;
    --task-reclaim-smoke) task_reclaim_smoke=true; shift ;;
    --task-reclaim-reap-apply) task_reclaim_reap_apply=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

base_url="${base_url:-${APP_PUBLIC_BASE_URL:-}}"
[ -n "$base_url" ] || { echo "smoke.sh requires --base-url or APP_PUBLIC_BASE_URL" >&2; exit 2; }
[ -n "${BUILTIN_ADMIN_INITIAL_PASSWORD:-}" ] || { echo "smoke.sh requires BUILTIN_ADMIN_INITIAL_PASSWORD from --secrets or environment" >&2; exit 2; }

args=(scripts/deploy/app-smoke.mjs --base-url "$base_url")
if [ -n "$endpoint_base_url" ]; then
  args+=(--endpoint-base-url "$endpoint_base_url")
fi
if [ -n "$endpoint_model" ]; then
  args+=(--endpoint-model "$endpoint_model")
fi
if [ -n "$endpoint_secret_ref" ]; then
  args+=(--endpoint-secret-ref "$endpoint_secret_ref")
fi
if [ "$task_smoke" = true ]; then
  args+=(--task-smoke)
fi
if [ "$task_reclaim_smoke" = true ]; then
  args+=(--task-reclaim-smoke)
fi
if [ "$task_reclaim_reap_apply" = true ]; then
  args+=(--task-reclaim-reap-apply)
fi

BUILTIN_ADMIN_INITIAL_PASSWORD="$BUILTIN_ADMIN_INITIAL_PASSWORD" \
SMOKE_ENDPOINT_BASE_URL="${SMOKE_ENDPOINT_BASE_URL:-}" \
SMOKE_ENDPOINT_MODEL="${SMOKE_ENDPOINT_MODEL:-}" \
SMOKE_ENDPOINT_SECRET_REF="${SMOKE_ENDPOINT_SECRET_REF:-}" \
SMOKE_TASK="${SMOKE_TASK:-}" \
SMOKE_TASK_RECLAIM="${SMOKE_TASK_RECLAIM:-}" \
SMOKE_TASK_RECLAIM_REAP_APPLY="${SMOKE_TASK_RECLAIM_REAP_APPLY:-}" \
SMOKE_TASK_TIMEOUT_SECS="${SMOKE_TASK_TIMEOUT_SECS:-}" \
node "${args[@]}"
