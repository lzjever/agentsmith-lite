#!/usr/bin/env bash
set -euo pipefail
config="${BOTIFIED_CONFIG_PATH:-/etc/botified/botified-config.yaml}"
exec /usr/local/bin/botified serve --config "$config"

