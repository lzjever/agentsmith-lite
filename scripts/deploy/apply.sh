#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

out=out/manifests
env_file=
timeout=300s
dry_run=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env) env_file="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --timeout) timeout="$2"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    --tag) shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f dist/packages/sandbox-controller/src/appDeployPlan.js ]; then
  npm run build >/dev/null
fi

args=(--out "$out" --timeout "$timeout")
if [ -n "$env_file" ]; then
  args+=(--env "$env_file")
fi
if [ "$dry_run" = true ]; then
  args+=(--dry-run)
fi

node scripts/deploy/apply-plan.mjs "${args[@]}"
