#!/usr/bin/env bash
set -euo pipefail
config="${BOTIFIED_CONFIG_PATH:-/etc/botified/botified-config.yaml}"
binary="${BOTIFIED_BINARY_PATH:-/usr/local/bin/botified}"
args=(serve --config "$config")

case "${BOTIFIED_MOCK_PROVIDER:-}" in
  ""|0|false|FALSE|False|no|NO|No|off|OFF|Off)
    ;;
  1|true|TRUE|True|yes|YES|Yes|on|ON|On)
    args+=(--mock-provider)
    ;;
  *)
    echo "BOTIFIED_MOCK_PROVIDER must be true or false" >&2
    exit 2
    ;;
esac

exec "$binary" "${args[@]}"
