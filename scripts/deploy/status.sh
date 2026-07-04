#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

namespace=agentsmith
resources=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env) source "$2"; namespace="${KUBE_NAMESPACE:-agentsmith}"; shift 2 ;;
    --resources) resources=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$resources" = true ]; then
  kubectl -n "$namespace" get pods,svc,job,networkpolicy -l agentsmith-lite/managed-by=agentsmith-lite
else
  kubectl -n "$namespace" get deploy,svc,job -l agentsmith-lite/managed-by=agentsmith-lite
fi

