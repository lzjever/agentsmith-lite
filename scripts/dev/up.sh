#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

env_file=""
secrets_file=""
app_env_file=""
app_secrets_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env)
      [ "$#" -ge 2 ] || { echo "--env requires a file" >&2; exit 2; }
      env_file="$2"
      shift 2
      ;;
    --secrets)
      [ "$#" -ge 2 ] || { echo "--secrets requires a file" >&2; exit 2; }
      secrets_file="$2"
      shift 2
      ;;
    --app-env)
      [ "$#" -ge 2 ] || { echo "--app-env requires a file" >&2; exit 2; }
      app_env_file="$2"
      shift 2
      ;;
    --app-secrets)
      [ "$#" -ge 2 ] || { echo "--app-secrets requires a file" >&2; exit 2; }
      app_secrets_file="$2"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

[ -z "$env_file" ] || [ -f "$env_file" ] || { echo "env file not found: $env_file" >&2; exit 2; }
[ -z "$secrets_file" ] || [ -f "$secrets_file" ] || { echo "secrets file not found: $secrets_file" >&2; exit 2; }
[ -z "$app_env_file" ] || [ -f "$app_env_file" ] || { echo "app env file not found: $app_env_file" >&2; exit 2; }
[ -z "$app_secrets_file" ] || [ -f "$app_secrets_file" ] || { echo "app secrets file not found: $app_secrets_file" >&2; exit 2; }

unset_substrate_only_env() {
  local keycloak_prefix name
  unset_env_with_prefix S3_
  keycloak_prefix=KEYCLOAK
  unset_env_with_prefix "${keycloak_prefix}_"
  unset_env_with_prefix OIDC_BOOTSTRAP_
  while IFS= read -r name; do
    if [ -n "$name" ] && [ "$name" != JUICEFS_PVC_NAME ]; then
      unset "$name"
    fi
  done < <(compgen -v JUICEFS_ || true)
}

unset_env_with_prefix() {
  local prefix="$1"
  local name
  while IFS= read -r name; do
    if [ -n "$name" ]; then
      unset "$name"
    fi
  done < <(compgen -v "$prefix" || true)
}

load_contract_env() {
  local args=(export)
  local assignments assignment
  if [ -n "$env_file" ]; then
    args+=(--env "$env_file")
  fi
  if [ -n "$secrets_file" ]; then
    args+=(--secrets "$secrets_file")
  fi
  if [ -n "$app_env_file" ]; then
    args+=(--app-env "$app_env_file")
  fi
  if [ -n "$app_secrets_file" ]; then
    args+=(--app-secrets "$app_secrets_file")
  fi
  assignments="$("${AGENTSMITH_LITE_ENV_CONTRACT_NODE:-node}" scripts/deploy/env-contract.mjs "${args[@]}")"
  while IFS= read -r assignment; do
    if [ -n "$assignment" ]; then
      export "$assignment"
    fi
  done <<< "$assignments"
}

load_contract_env

unset_substrate_only_env

export AGENTSMITH_LITE_DATA_DIR="${AGENTSMITH_LITE_DATA_DIR:-.data}"
export BUILTIN_ADMIN_INITIAL_PASSWORD="${BUILTIN_ADMIN_INITIAL_PASSWORD:-admin-password}"
export APP_SESSION_SECRET="${APP_SESSION_SECRET:-dev-session-secret}"
npm run dev
