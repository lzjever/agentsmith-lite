#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

env_file=""
secrets_file=""
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
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

[ -z "$env_file" ] || [ -f "$env_file" ] || { echo "env file not found: $env_file" >&2; exit 2; }
[ -z "$secrets_file" ] || [ -f "$secrets_file" ] || { echo "secrets file not found: $secrets_file" >&2; exit 2; }

unset_substrate_only_env() {
  local name
  while IFS= read -r name; do
    [ -n "$name" ] && unset "$name"
  done < <(compgen -v S3_ || true)
  while IFS= read -r name; do
    [ -n "$name" ] && [ "$name" != JUICEFS_PVC_NAME ] && unset "$name"
  done < <(compgen -v JUICEFS_ || true)
}

export_if_set() {
  local name="$1"
  if [ "${!name+x}" = x ]; then
    export "$name"
  fi
}

export_allowed_product_env() {
  local name
  for name in \
    POSTGRES_APP_URL \
    APP_SESSION_SECRET \
    BUILTIN_ADMIN_INITIAL_PASSWORD \
    APP_PUBLIC_BASE_URL \
    KUBE_NAMESPACE \
    KUBECONFIG_PATH \
    KUBE_CONTEXT \
    JUICEFS_PVC_NAME \
    BOTIFIED_RUNNER_IMAGE \
    AGENTSMITH_LITE_SANDBOX_MODE \
    AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT \
    AGENTSMITH_LITE_RUNTIME_TICK_MS; do
    export_if_set "$name"
  done
  while IFS= read -r name; do
    [ -n "$name" ] && export "$name"
  done < <(compgen -v AGENTSMITH_LITE_MODEL_BASE_URL_ || true)
  while IFS= read -r name; do
    [ -n "$name" ] && export "$name"
  done < <(compgen -v AGENTSMITH_LITE_MODEL_API_KEY_ || true)
}

if [ -n "$env_file" ]; then
  # shellcheck disable=SC1090
  source "$env_file"
fi
if [ -n "$secrets_file" ]; then
  # shellcheck disable=SC1090
  source "$secrets_file"
fi

unset_substrate_only_env
export_allowed_product_env

export AGENTSMITH_LITE_DATA_DIR="${AGENTSMITH_LITE_DATA_DIR:-.data}"
export BUILTIN_ADMIN_INITIAL_PASSWORD="${BUILTIN_ADMIN_INITIAL_PASSWORD:-admin-password}"
export APP_SESSION_SECRET="${APP_SESSION_SECRET:-dev-session-secret}"
npm run dev
