#!/usr/bin/env bash
set -euo pipefail

api_port="${API_PORT:-3001}"
web_port="${WEB_PORT:-3000}"
api_url="${LOCAL_API_BASE_URL:-http://127.0.0.1:${api_port}/api/v1}"

cleanup() {
  trap - EXIT INT TERM
  kill "${api_pid:-}" "${web_pid:-}" 2>/dev/null || true
  wait "${api_pid:-}" "${web_pid:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

PORT="$api_port" npm run dev:api &
api_pid=$!
APP_PUBLIC_BASE_URL="http://127.0.0.1:${web_port}" LOCAL_API_BASE_URL="$api_url" npm run dev:web -- --port "$web_port" &
web_pid=$!

echo "Web: http://127.0.0.1:${web_port}  API: ${api_url}" >&2
wait -n "$api_pid" "$web_pid"
