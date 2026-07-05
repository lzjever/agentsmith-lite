#!/usr/bin/env bash
set -euo pipefail

bundle=
runtime="${CONTAINER_RUNTIME:-docker}"
dry_run=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "--bundle requires a path" >&2
        exit 2
      fi
      bundle="$2"
      shift 2
      ;;
    --runtime)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "--runtime requires docker or podman" >&2
        exit 2
      fi
      runtime="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$bundle" ]; then
  echo "--bundle is required" >&2
  exit 2
fi
if [ ! -d "$bundle" ]; then
  echo "bundle directory does not exist: $bundle" >&2
  exit 1
fi

checksums_file="$bundle/checksums.txt"
lock_file="$bundle/images.lock"
app_archive="$bundle/images/app.tar"
runner_archive="$bundle/images/botified-runner.tar"

require_file() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "missing required bundle file: $file" >&2
    exit 1
  fi
}

require_nonempty_archive() {
  local file="$1"
  if [ ! -s "$file" ]; then
    echo "image archive is missing or empty: $file" >&2
    exit 1
  fi
}

require_checksum_entry() {
  local relative_path="$1"
  if ! awk -v file="$relative_path" '$2 == file { found = 1 } END { exit found ? 0 : 1 }' "$checksums_file"; then
    echo "checksums.txt missing required entry: $relative_path" >&2
    exit 1
  fi
}

validate_images_lock() {
  local app_seen=0
  local runner_seen=0
  local line=
  local line_number=0

  while IFS= read -r line || [ -n "$line" ]; do
    line_number=$((line_number + 1))
    if [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]]; then
      continue
    fi
    if [[ "$line" =~ [[:space:]] ]]; then
      echo "images.lock line $line_number must contain a single image ref" >&2
      exit 1
    fi

    if [[ "$line" =~ ^agentsmith-lite/app@sha256:[0-9a-fA-F]{64}$ ]]; then
      if [ "$app_seen" -ne 0 ]; then
        echo "images.lock contains duplicate agentsmith-lite/app ref" >&2
        exit 1
      fi
      app_seen=1
    elif [[ "$line" =~ ^agentsmith-lite/botified-runner@sha256:[0-9a-fA-F]{64}$ ]]; then
      if [ "$runner_seen" -ne 0 ]; then
        echo "images.lock contains duplicate agentsmith-lite/botified-runner ref" >&2
        exit 1
      fi
      runner_seen=1
    elif [[ "$line" =~ ^agentsmith-lite/(app|botified-runner): ]]; then
      echo "images.lock ref must be digest-pinned, not a mutable tag: $line" >&2
      exit 1
    elif [[ "$line" =~ ^agentsmith-lite/(app|botified-runner)@ ]]; then
      echo "images.lock ref has an invalid sha256 digest: $line" >&2
      exit 1
    else
      echo "images.lock contains unsupported image ref: $line" >&2
      exit 1
    fi
  done < "$lock_file"

  if [ "$app_seen" -eq 0 ]; then
    echo "images.lock missing agentsmith-lite/app digest ref" >&2
    exit 1
  fi
  if [ "$runner_seen" -eq 0 ]; then
    echo "images.lock missing agentsmith-lite/botified-runner digest ref" >&2
    exit 1
  fi
}

require_file "$checksums_file"
require_file "$lock_file"
require_file "$app_archive"
require_file "$runner_archive"
require_nonempty_archive "$app_archive"
require_nonempty_archive "$runner_archive"

require_checksum_entry "manifest.yaml"
require_checksum_entry "images.lock"
require_checksum_entry "images/app.tar"
require_checksum_entry "images/botified-runner.tar"

if ! (cd "$bundle" && sha256sum -c checksums.txt >/dev/null); then
  echo "bundle checksum validation failed" >&2
  exit 1
fi

validate_images_lock

load_image() {
  local archive="$1"
  if [ "$dry_run" = true ]; then
    printf 'image load -i %s\n' "$archive"
    return
  fi
  "$runtime" image load -i "$archive"
}

load_image "$app_archive"
load_image "$runner_archive"
