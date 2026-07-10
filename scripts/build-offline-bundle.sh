#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
repo_root="$(pwd)"
oci_validator="$repo_root/scripts/deploy/validate-oci-archive.sh"

app_image=
runner_image=
images_lock=
output=dist/app-offline-bundle
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
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

read_images_lock() {
  local lock_file="$1"
  local parsed=

  if [ ! -f "$lock_file" ]; then
    echo "--images-lock file does not exist: $lock_file" >&2
    exit 2
  fi
  if [ ! -f "$repo_root/dist/packages/sandbox-controller/src/appImageLock.js" ]; then
    (cd "$repo_root" && npm run build >/dev/null)
  fi

  if ! parsed="$(node "$repo_root/scripts/deploy/app-images-lock.mjs" "$lock_file")"; then
    exit 2
  fi

  app_image="$(printf '%s\n' "$parsed" | sed -n '1p')"
  runner_image="$(printf '%s\n' "$parsed" | sed -n '2p')"
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

if ! skopeo_bin="$(command -v skopeo)"; then
  echo "skopeo is required on the bundle producer host" >&2
  exit 1
fi

output_parent="$(dirname "$output")"
output_name="$(basename "$output")"
mkdir -p "$output_parent"
staging_dir="$(mktemp -d "$output_parent/.${output_name}.staging.XXXXXX")"
trap 'rm -rf "$staging_dir"' EXIT
mkdir -p "$staging_dir/images"

export_image() {
  local ref="$1"
  local archive="$2"
  local image_name="${ref%%@*}"

  "$skopeo_bin" copy --preserve-digests "docker://$ref" "oci-archive:$archive:$image_name"
  bash "$oci_validator" "$archive" "${ref#*@}"
}

export_image "$app_image" "$staging_dir/images/app.tar"
export_image "$runner_image" "$staging_dir/images/botified-runner.tar"

cat > "$staging_dir/images.lock" <<LOCK
${app_image}
${runner_image}
LOCK

cat > "$staging_dir/manifest.yaml" <<MANIFEST
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
  cd "$staging_dir"
  sha256sum manifest.yaml images.lock images/app.tar images/botified-runner.tar > checksums.txt
)

backup_dir="$(mktemp -d "$output_parent/.${output_name}.backup.XXXXXX")"
rmdir "$backup_dir"
if [ -e "$output" ] || [ -L "$output" ]; then
  mv "$output" "$backup_dir"
fi
if ! mv "$staging_dir" "$output"; then
  if [ -e "$backup_dir" ] || [ -L "$backup_dir" ]; then
    mv "$backup_dir" "$output"
  fi
  exit 1
fi
rm -rf "$backup_dir"
trap - EXIT
echo "Wrote app offline bundle to $output"
