#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

base_url=
env_file=
secrets_file=
app_env_file=
app_secrets_file=
endpoint_base_url=
endpoint_model=
endpoint_secret_ref=
report_path=out/smoke-report.json
task_smoke=false
task_reclaim_smoke=false
task_reclaim_reap_apply=false
k8s_evidence=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-url) base_url="$2"; shift 2 ;;
    --env) env_file="$2"; shift 2 ;;
    --secrets) secrets_file="$2"; shift 2 ;;
    --app-env) app_env_file="$2"; shift 2 ;;
    --app-secrets) app_secrets_file="$2"; shift 2 ;;
    --endpoint-base-url) endpoint_base_url="$2"; shift 2 ;;
    --endpoint-model) endpoint_model="$2"; shift 2 ;;
    --endpoint-secret-ref) endpoint_secret_ref="$2"; shift 2 ;;
    --report) report_path="$2"; shift 2 ;;
    --task-smoke) task_smoke=true; shift ;;
    --task-reclaim-smoke) task_reclaim_smoke=true; shift ;;
    --task-reclaim-reap-apply) task_reclaim_reap_apply=true; shift ;;
    --k8s-evidence) k8s_evidence=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

unset_substrate_only_env() {
  local name
  while IFS= read -r name; do
    if [ -n "$name" ]; then
      unset "$name"
    fi
  done < <(compgen -v S3_ || true)
  while IFS= read -r name; do
    if [ -n "$name" ] && [ "$name" != JUICEFS_PVC_NAME ]; then
      unset "$name"
    fi
  done < <(compgen -v JUICEFS_ || true)
}

load_contract_env() {
  local args=(export --profile smoke)
  local assignments assignment
  if [ -n "$env_file" ]; then
    args+=(--env "$env_file")
  fi
  if [ -n "$secrets_file" ]; then
    args+=(--secrets "$secrets_file")
  fi
  if [ -n "$app_env_file" ]; then
    args+=(--app-env "$app_env_file")
  fi
  if [ -n "$app_secrets_file" ]; then
    args+=(--app-secrets "$app_secrets_file")
  fi
  assignments="$("${AGENTSMITH_LITE_ENV_CONTRACT_NODE:-node}" scripts/deploy/env-contract.mjs "${args[@]}")"
  while IFS= read -r assignment; do
    if [ -n "$assignment" ]; then
      export "$assignment"
    fi
  done <<< "$assignments"
}

load_contract_env
unset_substrate_only_env

base_url="${base_url:-${APP_PUBLIC_BASE_URL:-}}"
[ -n "$base_url" ] || { echo "smoke.sh requires --base-url or APP_PUBLIC_BASE_URL" >&2; exit 2; }
[ -n "${BUILTIN_ADMIN_INITIAL_PASSWORD:-}" ] || { echo "smoke.sh requires BUILTIN_ADMIN_INITIAL_PASSWORD from --secrets or environment" >&2; exit 2; }

args=(scripts/deploy/app-smoke.mjs --base-url "$base_url" --report "$report_path")
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
if [ "$k8s_evidence" = true ]; then
  args+=(--k8s-evidence)
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
