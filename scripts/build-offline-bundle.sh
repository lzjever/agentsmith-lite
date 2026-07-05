#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

app_image=
runner_image=
images_lock=
output=dist/app-offline-bundle
runtime="${CONTAINER_RUNTIME:-docker}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app-image) app_image="$2"; shift 2 ;;
    --runner-image) runner_image="$2"; shift 2 ;;
    --images-lock)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "--images-lock requires a path" >&2
        exit 2
      fi
      images_lock="$2"
      shift 2
      ;;
    --output) output="$2"; shift 2 ;;
    --runtime) runtime="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

read_images_lock() {
  local lock_file="$1"
  local app_seen=0
  local runner_seen=0
  local line=
  local line_number=0

  if [ ! -f "$lock_file" ]; then
    echo "--images-lock file does not exist: $lock_file" >&2
    exit 2
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    line_number=$((line_number + 1))
    if [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]]; then
      continue
    fi
    if [[ "$line" =~ [[:space:]] ]]; then
      echo "images.lock line $line_number must contain a single image ref" >&2
      exit 2
    fi

    if [[ "$line" =~ ^agentsmith-lite/app@sha256:[0-9a-fA-F]{64}$ ]]; then
      if [ "$app_seen" -ne 0 ]; then
        echo "images.lock contains duplicate agentsmith-lite/app ref" >&2
        exit 2
      fi
      app_seen=1
      app_image="$line"
    elif [[ "$line" =~ ^agentsmith-lite/botified-runner@sha256:[0-9a-fA-F]{64}$ ]]; then
      if [ "$runner_seen" -ne 0 ]; then
        echo "images.lock contains duplicate agentsmith-lite/botified-runner ref" >&2
        exit 2
      fi
      runner_seen=1
      runner_image="$line"
    elif [[ "$line" =~ ^agentsmith-lite/(app|botified-runner): ]]; then
      echo "images.lock ref must be digest-pinned, not a mutable tag: $line" >&2
      exit 2
    elif [[ "$line" =~ ^agentsmith-lite/(app|botified-runner)@ ]]; then
      echo "images.lock ref has an invalid sha256 digest: $line" >&2
      exit 2
    else
      echo "images.lock contains unsupported image ref: $line" >&2
      exit 2
    fi
  done < "$lock_file"

  if [ "$app_seen" -eq 0 ]; then
    echo "images.lock missing agentsmith-lite/app digest ref" >&2
    exit 2
  fi
  if [ "$runner_seen" -eq 0 ]; then
    echo "images.lock missing agentsmith-lite/botified-runner digest ref" >&2
    exit 2
  fi
}

if [ -n "$images_lock" ]; then
  if [ -n "$app_image" ] || [ -n "$runner_image" ]; then
    echo "--images-lock cannot be used with --app-image or --runner-image" >&2
    exit 2
  fi
  read_images_lock "$images_lock"
fi

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
