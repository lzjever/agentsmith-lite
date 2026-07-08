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
task_artifact_check=false
task_reclaim_check=false
task_reclaim_reap_apply=false
check_k8s_run_resources=false
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
    --check-task-artifact) task_artifact_check=true; shift ;;
    --check-task-reclaim) task_reclaim_check=true; shift ;;
    --check-task-reclaim-reap-apply) task_reclaim_reap_apply=true; shift ;;
    --check-k8s-run-resources) check_k8s_run_resources=true; shift ;;
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
  local args=(export --allow-product-workflow)
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
[ -n "$base_url" ] || { echo "check-product-workflow.sh requires --base-url or APP_PUBLIC_BASE_URL" >&2; exit 2; }
[ -n "${BUILTIN_ADMIN_INITIAL_PASSWORD:-}" ] || { echo "check-product-workflow.sh requires BUILTIN_ADMIN_INITIAL_PASSWORD from --secrets or environment" >&2; exit 2; }

args=(scripts/deploy/check-product-workflow.mjs --base-url "$base_url")
if [ -n "$endpoint_base_url" ]; then
  args+=(--endpoint-base-url "$endpoint_base_url")
fi
if [ -n "$endpoint_model" ]; then
  args+=(--endpoint-model "$endpoint_model")
fi
if [ -n "$endpoint_secret_ref" ]; then
  args+=(--endpoint-secret-ref "$endpoint_secret_ref")
fi
if [ "$task_artifact_check" = true ]; then
  args+=(--check-task-artifact)
fi
if [ "$task_reclaim_check" = true ]; then
  args+=(--check-task-reclaim)
fi
if [ "$task_reclaim_reap_apply" = true ]; then
  args+=(--check-task-reclaim-reap-apply)
fi
if [ "$check_k8s_run_resources" = true ]; then
  args+=(--check-k8s-run-resources)
fi

BUILTIN_ADMIN_INITIAL_PASSWORD="$BUILTIN_ADMIN_INITIAL_PASSWORD" \
PRODUCT_WORKFLOW_ENDPOINT_BASE_URL="${PRODUCT_WORKFLOW_ENDPOINT_BASE_URL:-}" \
PRODUCT_WORKFLOW_ENDPOINT_MODEL="${PRODUCT_WORKFLOW_ENDPOINT_MODEL:-}" \
PRODUCT_WORKFLOW_ENDPOINT_SECRET_REF="${PRODUCT_WORKFLOW_ENDPOINT_SECRET_REF:-}" \
PRODUCT_WORKFLOW_CHECK_TASK_ARTIFACT="${PRODUCT_WORKFLOW_CHECK_TASK_ARTIFACT:-}" \
PRODUCT_WORKFLOW_CHECK_TASK_RECLAIM="${PRODUCT_WORKFLOW_CHECK_TASK_RECLAIM:-}" \
PRODUCT_WORKFLOW_CHECK_TASK_RECLAIM_REAP_APPLY="${PRODUCT_WORKFLOW_CHECK_TASK_RECLAIM_REAP_APPLY:-}" \
PRODUCT_WORKFLOW_TASK_TIMEOUT_SECS="${PRODUCT_WORKFLOW_TASK_TIMEOUT_SECS:-}" \
node "${args[@]}"
