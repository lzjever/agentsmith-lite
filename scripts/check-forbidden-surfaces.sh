#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

deny='AFSCP|JVS|WebDAV|LLMUP|MONGO_|REDIS_|KEYCLOAK_|ASBCP_|pods/exec|xterm|agent-task-runner|agent-runner-contract'
paths=(package.json packages src infra e2e scripts)
existing=()
for path in "${paths[@]}"; do
  [ -e "$path" ] && existing+=("$path")
done

is_allowed_active_hit() {
  local hit="$1"
  case "$hit" in
    "scripts/deploy/env-contract.mjs:"*'"KEYCLOAK_DB_USER"'*|\
    "scripts/deploy/env-contract.mjs:"*'"KEYCLOAK_DB_PASSWORD"'*|\
    "scripts/deploy/env-contract.mjs:"*'"KEYCLOAK_DB_DATABASE"'*|\
    "scripts/deploy/env-contract.mjs:"*'"KEYCLOAK_ADMIN_USERNAME"'*|\
    "scripts/deploy/env-contract.mjs:"*'"KEYCLOAK_ADMIN_PASSWORD"'*)
      return 0
      ;;
  esac
  return 1
}

active_hits=()
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  if ! is_allowed_active_hit "$hit"; then
    active_hits+=("$hit")
  fi
done < <(
  rg -n "$deny" "${existing[@]}" \
    --glob '!**/*.md' \
    --glob '!**/.reference/**' \
    --glob '!dist/**' \
    --glob '!out/**' \
    --glob '!third_party/**' \
    --glob '!**/third_party/**' \
    --glob '!scripts/check-forbidden-surfaces.sh' || true
)

if [ "${#active_hits[@]}" -gt 0 ]; then
  printf '%s\n' "${active_hits[@]}"
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
