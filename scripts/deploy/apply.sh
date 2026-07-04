#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

out=out/manifests
dry_run=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    --env|--tag) shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$dry_run" = true ]; then
  echo "kubectl apply -f $out"
else
  kubectl apply -f "$out"
fi

