#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

base_url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-url) base_url="$2"; shift 2 ;;
    --env) source "$2"; base_url="${APP_PUBLIC_BASE_URL:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$base_url" ]; then
  node e2e/smoke/lite-smoke.mjs --base-url "$base_url"
else
  npm run e2e:smoke
fi

