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

env_file_requested_k8s_fact_checks=false

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
  local assignments assignment
  assignments="$("${AGENTSMITH_LITE_ENV_CONTRACT_NODE:-node}" scripts/deploy/env-contract.mjs export --env "$env_file" --secrets "$secrets_file")"
  while IFS= read -r assignment; do
    [ -n "$assignment" ] || continue
    case "$assignment" in
      KUBECONFIG_PATH=*|KUBE_CONTEXT=*) env_file_requested_k8s_fact_checks=true ;;
    esac
    export "$assignment"
  done <<< "$assignments"
}

load_contract_env
unset_substrate_only_env

requires_app_ingress() {
  local url="${1:-http://localhost:3000}"
  local authority
  local host

  case "$url" in
    http://*|https://*) ;;
    *) return 1 ;;
  esac

  authority="${url#*://}"
  authority="${authority%%/*}"
  if [[ "$authority" == \[*\]* ]]; then
    host="${authority%%]*}"
    host="${host#\[}"
  else
    host="${authority%%:*}"
  fi
  host="${host,,}"

  case "$host" in
    localhost|127.0.0.1|::1) return 1 ;;
    *) return 0 ;;
  esac
}

is_positive_safe_integer() {
  local value="$1"
  case "$value" in
    ''|*[!0-9]*|0*) return 1 ;;
  esac
  if [ "${#value}" -lt 16 ]; then
    return 0
  fi
  if [ "${#value}" -gt 16 ]; then
    return 1
  fi
  [[ "$value" < "9007199254740992" ]]
}

run_kubectl_check() {
  local description="$1"
  shift
  if ! kubectl "${k8s_kubectl_args[@]}" "$@" >/dev/null 2>&1; then
    echo "K8s fact check failed: $description" >&2
    exit 1
  fi
}

run_kubectl_expect_denied() {
  local description="$1"
  shift
  if kubectl "${k8s_kubectl_args[@]}" "$@" >/dev/null 2>&1; then
    echo "K8s fact check failed: $description" >&2
    exit 1
  fi
}

run_k8s_fact_checks() {
  local namespace="${KUBE_NAMESPACE:-agentsmith}"
  local timeout="${APP_DOCTOR_K8S_TIMEOUT:-300s}"
  local service_account="system:serviceaccount:${namespace}:agentsmith-lite-api"
  local resource
  local verb

  command -v kubectl >/dev/null 2>&1 || {
    echo "kubectl is required for K8s fact checks" >&2
    exit 1
  }
  [ -n "${JUICEFS_PVC_NAME:-}" ] || {
    echo "JUICEFS_PVC_NAME is required for K8s fact checks" >&2
    exit 1
  }

  k8s_kubectl_args=()
  if [ -n "${KUBECONFIG_PATH:-}" ]; then
    k8s_kubectl_args+=(--kubeconfig "$KUBECONFIG_PATH")
  fi
  if [ -n "${KUBE_CONTEXT:-}" ]; then
    k8s_kubectl_args+=(--context "$KUBE_CONTEXT")
  fi
  k8s_kubectl_args+=(--namespace "$namespace")

  run_kubectl_check "schema bootstrap Job completed" wait --for=condition=complete job/agentsmith-lite-schema-bootstrap "--timeout=$timeout"
  run_kubectl_check "API Deployment rollout completed" rollout status deploy/agentsmith-lite-api "--timeout=$timeout"
  run_kubectl_check "JuiceFS PVC exists" get pvc "$JUICEFS_PVC_NAME"

  for resource in pods services secrets configmaps serviceaccounts networkpolicies; do
    for verb in create get list delete; do
      run_kubectl_check "API service account can $verb $resource" auth can-i "$verb" "$resource" "--as=$service_account"
    done
  done

  for resource in pods/exec persistentvolumes persistentvolumeclaims clusterroles; do
    run_kubectl_expect_denied "API service account must not be allowed to create $resource" auth can-i create "$resource" "--as=$service_account"
  done
}

require_secret_min_length() {
  local name="$1"
  local min_length="$2"
  local value="${!name:-}"
  [ -n "$value" ] || { echo "$name is required for app deploy" >&2; exit 1; }
  [ "${#value}" -ge "$min_length" ] || { echo "$name must be at least $min_length characters for app deploy" >&2; exit 1; }
}

sandbox_mode="${AGENTSMITH_LITE_SANDBOX_MODE:-dry-run}"
case "$sandbox_mode" in
  ""|dry-run|live) ;;
  *) echo "AGENTSMITH_LITE_SANDBOX_MODE must be either dry-run or live" >&2; exit 1 ;;
esac
[ -n "$sandbox_mode" ] || sandbox_mode=dry-run
sandbox_namespace_limit="${AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT:-}"
if [ -n "$sandbox_namespace_limit" ]; then
  is_positive_safe_integer "$sandbox_namespace_limit" || {
    echo "AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT must be a positive integer" >&2
    exit 1
  }
fi

for required in POSTGRES_APP_URL BUILTIN_ADMIN_INITIAL_PASSWORD; do
  [ -n "${!required:-}" ] || { echo "$required is required for app deploy" >&2; exit 1; }
done
require_secret_min_length APP_SESSION_SECRET 32
if [ "$sandbox_mode" = "live" ] && [ "${BUILTIN_ADMIN_INITIAL_PASSWORD:-}" = "admin-password" ]; then
  echo "BUILTIN_ADMIN_INITIAL_PASSWORD must be non-default when AGENTSMITH_LITE_SANDBOX_MODE=live" >&2
  exit 1
fi

[ -f third_party/botified/PINNED_SOURCE.json ] || { echo "Botified vendored source pin is missing" >&2; exit 1; }
[ -d infra/db/migrations ] || { echo "schema migration bundle is missing" >&2; exit 1; }

if [ -d "$out" ] && rg -q 'S3_ACCESS_KEY|S3_SECRET_KEY|JUICEFS_META_URL' "$out"; then
  echo "app manifests contain substrate-only secrets" >&2
  exit 1
fi

if [ -d "$out" ]; then
  rg -q 'kind: Deployment' "$out" || { echo "rendered app Deployment missing" >&2; exit 1; }
  rg -q '^[[:space:]]*BUILTIN_ADMIN_INITIAL_PASSWORD:[[:space:]]*[^[:space:]]' "$out" || {
    echo "rendered app Secret missing non-empty BUILTIN_ADMIN_INITIAL_PASSWORD" >&2
    exit 1
  }
  if [ "$sandbox_mode" = "live" ] && rg -q '^[[:space:]]*BUILTIN_ADMIN_INITIAL_PASSWORD:[[:space:]]*"?admin-password"?[[:space:]]*$' "$out"; then
    echo "rendered app Secret uses the default BUILTIN_ADMIN_INITIAL_PASSWORD in live mode" >&2
    exit 1
  fi
  if requires_app_ingress "${APP_PUBLIC_BASE_URL:-}"; then
    rg -q 'kind: Ingress' "$out" || { echo "rendered app Ingress missing" >&2; exit 1; }
  fi
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

if [ "$env_file_requested_k8s_fact_checks" = true ] && { [ -n "${KUBECONFIG_PATH:-}" ] || [ -n "${KUBE_CONTEXT:-}" ]; }; then
  run_k8s_fact_checks
fi

mkdir -p out
cat > out/app-doctor-report.json <<REPORT
{
  "schema": "agentsmith-lite.app-doctor/v1",
  "checks": {
    "app_images": "offline bundle, images.lock, and rendered manifests are checked when provided",
    "schema_job": "expected agentsmith-lite-schema-bootstrap",
    "web_api_readiness": "expected agentsmith-lite-api deployment/service and ingress for non-local public URLs",
    "sandbox_rbac": "expected namespaced Role without exec subresource",
    "k8s_facts": "when kube env is configured, checks schema job completion, API rollout, JuiceFS PVC, and API service account RBAC",
    "botified_smoke": "uses third_party/botified/PINNED_SOURCE.json and botified serve"
  },
  "secret_policy": "only product secrets are rendered to app-owned Kubernetes Secrets"
}
REPORT
echo "App doctor passed. Report: out/app-doctor-report.json"
