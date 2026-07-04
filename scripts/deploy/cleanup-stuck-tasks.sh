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
echo "Would inspect and clean app-owned sandbox pods/services/configmaps/secrets in namespace $namespace."

