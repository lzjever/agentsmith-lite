#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

namespace=agentsmith
dry_run=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env) source "$2"; namespace="${KUBE_NAMESPACE:-agentsmith}"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

kubectl_args=()
if [ -n "${KUBECONFIG_PATH:-}" ]; then
  kubectl_args+=(--kubeconfig "$KUBECONFIG_PATH")
fi
if [ -n "${KUBE_CONTEXT:-}" ]; then
  kubectl_args+=(--context "$KUBE_CONTEXT")
fi

command=(kubectl "${kubectl_args[@]}" -n "$namespace" delete deploy,svc,ingress,job,cm,secret,sa,role,rolebinding,networkpolicy,resourcequota,limitrange -l agentsmith-lite/managed-by=agentsmith-lite)
if [ "$dry_run" = true ]; then
  printf '%q ' "${command[@]}"
  echo
else
  "${command[@]}"
fi
