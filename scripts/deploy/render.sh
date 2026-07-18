#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ ! -f dist/packages/sandbox-controller/src/appManifestRenderer.js ] || [ ! -f dist/packages/sandbox-controller/src/appImageLock.js ]; then
  npm run build:api >/dev/null
fi

node scripts/deploy/render-manifests.mjs "$@"
