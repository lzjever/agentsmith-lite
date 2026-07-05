#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

namespace=agentsmith
resources=false
base_url="${APP_PUBLIC_BASE_URL:-}"
env_file=
cookie_file=""
csrf_token=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env) env_file="$2"; shift 2 ;;
    --resources) resources=true; shift ;;
    --base-url) base_url="$2"; shift 2 ;;
    --cookie-file) cookie_file="$2"; shift 2 ;;
    --csrf-token) csrf_token="$2"; shift 2 ;;
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

if [ -n "$env_file" ]; then
  assignments="$("${AGENTSMITH_LITE_ENV_CONTRACT_NODE:-node}" scripts/deploy/env-contract.mjs export --env "$env_file")"
  while IFS= read -r assignment; do
    if [ -n "$assignment" ]; then
      export "$assignment"
    fi
  done <<< "$assignments"
fi
unset_substrate_only_env

namespace="${KUBE_NAMESPACE:-agentsmith}"
if [ -z "$base_url" ]; then
  base_url="${APP_PUBLIC_BASE_URL:-}"
fi

if [ "$resources" = true ]; then
  [ -n "$base_url" ] || { echo "status.sh --resources requires --base-url or APP_PUBLIC_BASE_URL plus operator sandbox API auth." >&2; exit 2; }
  [ -n "$cookie_file" ] || { echo "status.sh --resources requires --cookie-file for operator sandbox API auth." >&2; exit 2; }
  [ -f "$cookie_file" ] || { echo "cookie file not found: $cookie_file" >&2; exit 2; }
  helper_args=(scripts/deploy/operator-sandbox.mjs status --base-url "$base_url" --cookie-file "$cookie_file")
  if [ -n "$csrf_token" ]; then
    helper_args+=(--csrf-token "$csrf_token")
  fi
  node "${helper_args[@]}"
else
  kubectl_args=()
  if [ -n "${KUBECONFIG_PATH:-}" ]; then
    kubectl_args+=(--kubeconfig "$KUBECONFIG_PATH")
  fi
  if [ -n "${KUBE_CONTEXT:-}" ]; then
    kubectl_args+=(--context "$KUBE_CONTEXT")
  fi
  kubectl "${kubectl_args[@]}" -n "$namespace" get deploy,svc,ingress,job -l agentsmith-lite/managed-by=agentsmith-lite
fi
