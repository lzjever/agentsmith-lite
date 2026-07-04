#!/usr/bin/env bash
set -euo pipefail
bundle=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle) bundle="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$bundle" ] || { echo "--bundle is required" >&2; exit 2; }
echo "Import image archives from $bundle/images using your cluster runtime or registry."

