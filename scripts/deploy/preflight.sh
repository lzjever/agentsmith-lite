#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

doctor_args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env|--secrets|--app-env|--app-secrets|--out|--bundle|--images-lock)
      [ "$#" -ge 2 ] || { echo "$1 requires a value" >&2; exit 2; }
      doctor_args+=("$1" "$2")
      shift 2
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

exec scripts/deploy/doctor.sh --static-only "${doctor_args[@]}"
