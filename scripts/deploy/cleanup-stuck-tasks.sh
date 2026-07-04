#!/usr/bin/env bash
set -euo pipefail
namespace=agentsmith
dry_run=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env) source "$2"; namespace="${KUBE_NAMESPACE:-agentsmith}"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$dry_run" = true ] || { echo "P0 cleanup requires --dry-run until live reconciler wiring lands." >&2; exit 2; }
echo "App-owned sandbox resources in namespace $namespace:"
kubectl -n "$namespace" get pods,svc,configmap,secret,serviceaccount,networkpolicy -l agentsmith-lite/managed-by=agentsmith-lite || true
echo
echo "Product-level cleanup is explicit: call POST /api/operator/sandbox/reap with {\"apply\":true} after logging in as an admin."
