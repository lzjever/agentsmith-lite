#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export AGENTSMITH_LITE_DATA_DIR="${AGENTSMITH_LITE_DATA_DIR:-.data}"
export BUILTIN_ADMIN_INITIAL_PASSWORD="${BUILTIN_ADMIN_INITIAL_PASSWORD:-admin-password}"
export APP_SESSION_SECRET="${APP_SESSION_SECRET:-dev-session-secret}"
npm run dev

