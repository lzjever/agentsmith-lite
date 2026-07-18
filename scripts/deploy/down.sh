#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

namespace=agentsmith
dry_run=false
env_file=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env) env_file="$2"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
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
  assignments="$("${AGENTSMITH_LITE_ENV_CONTRACT_NODE:-node}" scripts/deploy/env-contract.mjs export --env-only --env "$env_file")"
  while IFS= read -r assignment; do
    if [ -n "$assignment" ]; then
      export "$assignment"
    fi
  done <<< "$assignments"
fi
unset_substrate_only_env

namespace="${KUBE_NAMESPACE:-agentsmith}"

kubectl_args=()
if [ -n "${KUBECONFIG_PATH:-}" ]; then
  kubectl_args+=(--kubeconfig "$KUBECONFIG_PATH")
fi
if [ -n "${KUBE_CONTEXT:-}" ]; then
  kubectl_args+=(--context "$KUBE_CONTEXT")
fi

command=(kubectl "${kubectl_args[@]}" -n "$namespace" delete deploy,pod,svc,ingress,job,cm,secret,sa,role,rolebinding,networkpolicy,resourcequota,limitrange -l agentsmith-lite/managed-by=agentsmith-lite)
if [ "$dry_run" = true ]; then
  printf '%q ' "${command[@]}"
  echo
else
  "${command[@]}"
fi
