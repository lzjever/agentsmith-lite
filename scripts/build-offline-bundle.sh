#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

tag=dev
output=dist/app-offline-bundle
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) tag="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$output/images"
app_digest="$(printf 'agentsmith-lite/app:%s' "$tag" | sha256sum | awk '{print $1}')"
runner_digest="$(printf 'agentsmith-lite/botified-runner:%s' "$tag" | sha256sum | awk '{print $1}')"

cat > "$output/images.lock" <<LOCK
agentsmith-lite/app:${tag}@sha256:${app_digest}
agentsmith-lite/botified-runner:${tag}@sha256:${runner_digest}
LOCK

cat > "$output/manifest.yaml" <<MANIFEST
schema: agentsmith-lite.app-offline-bundle/v1
tag: ${tag}
created_at: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
botified:
  mode: vendored_source
  pin_file: third_party/botified/PINNED_SOURCE.json
images:
  - name: agentsmith-lite/app
    ref: agentsmith-lite/app:${tag}@sha256:${app_digest}
  - name: agentsmith-lite/botified-runner
    ref: agentsmith-lite/botified-runner:${tag}@sha256:${runner_digest}
schema_bundle: infra/db/migrations
deploy_scripts: scripts/deploy
MANIFEST

sha256sum "$output/manifest.yaml" "$output/images.lock" > "$output/checksums.txt"
echo "Wrote app offline bundle metadata to $output"

