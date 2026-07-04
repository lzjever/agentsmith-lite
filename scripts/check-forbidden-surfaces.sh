#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

deny='AFSCP|JVS|WebDAV|LLMUP|MONGO_|REDIS_|KEYCLOAK_|ASBCP_|pods/exec|xterm|product:ready|gate:|release:campaign|agent-task-runner|agent-runner-contract'
paths=(package.json packages src infra e2e)
existing=()
for path in "${paths[@]}"; do
  [ -e "$path" ] && existing+=("$path")
done

if rg -n "$deny" "${existing[@]}" --glob '!**/*.md' --glob '!third_party/**'; then
  echo "Forbidden removed surface found in active app source." >&2
  exit 1
fi

echo "Forbidden surface check passed."

