#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

app_image=
runner_image=
output=dist/app-offline-bundle
runtime="${CONTAINER_RUNTIME:-docker}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app-image) app_image="$2"; shift 2 ;;
    --runner-image) runner_image="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    --runtime) runtime="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$app_image" ]; then
  echo "missing required --app-image agentsmith-lite/app@sha256:<64hex>" >&2
  exit 2
fi
if [ -z "$runner_image" ]; then
  echo "missing required --runner-image agentsmith-lite/botified-runner@sha256:<64hex>" >&2
  exit 2
fi
if [[ ! "$app_image" =~ ^agentsmith-lite/app@sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "--app-image must be digest-pinned as agentsmith-lite/app@sha256:<64hex>" >&2
  exit 2
fi
if [[ ! "$runner_image" =~ ^agentsmith-lite/botified-runner@sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "--runner-image must be digest-pinned as agentsmith-lite/botified-runner@sha256:<64hex>" >&2
  exit 2
fi

mkdir -p "$output/images"

save_image() {
  local ref="$1"
  local archive="$2"
  rm -f "$archive"
  "$runtime" image save -o "$archive" "$ref"
  if [ ! -s "$archive" ]; then
    echo "image archive was not created or is empty: $archive" >&2
    exit 1
  fi
}

save_image "$app_image" "$output/images/app.tar"
save_image "$runner_image" "$output/images/botified-runner.tar"

cat > "$output/images.lock" <<LOCK
${app_image}
${runner_image}
LOCK

cat > "$output/manifest.yaml" <<MANIFEST
schema: agentsmith-lite.app-offline-bundle/v1
created_at: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
botified:
  mode: vendored_source
  pin_file: third_party/botified/PINNED_SOURCE.json
images:
  - name: agentsmith-lite/app
    ref: ${app_image}
    archive: images/app.tar
  - name: agentsmith-lite/botified-runner
    ref: ${runner_image}
    archive: images/botified-runner.tar
schema_bundle: infra/db/migrations
deploy_scripts: scripts/deploy
MANIFEST

(
  cd "$output"
  sha256sum manifest.yaml images.lock images/app.tar images/botified-runner.tar > checksums.txt
)
echo "Wrote app offline bundle to $output"
