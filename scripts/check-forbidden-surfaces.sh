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

term_a="$(printf '\164\165\151')"
term_b="$(printf '\147\141\164\145\163')"
term_c="$(printf '\160\154\141\171\147\162\157\165\156\144')"
term_d="$(printf '\143\154\141\167')"
term_e="$(printf '\162\141\164\141\164\165\151')"
term_f="$(printf '\143\162\157\163\163\164\145\162\155')"
term_g="botified-${term_a}"
third_party_pattern="${term_g}|${term_a}|${term_b}|${term_c}|${term_d}|${term_e}|${term_f}"
if rg -n "$third_party_pattern" third_party/botified; then
  echo "Forbidden optional Botified surface found in vendored runner input." >&2
  exit 1
fi

echo "Forbidden surface check passed."
