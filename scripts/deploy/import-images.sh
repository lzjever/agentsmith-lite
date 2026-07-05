#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

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

validate_checksum_contract() {
  awk '
    BEGIN {
      allowed["manifest.yaml"] = 1
      allowed["images.lock"] = 1
      allowed["images/app.tar"] = 1
      allowed["images/botified-runner.tar"] = 1
    }
    /^[[:space:]]*$/ { next }
    {
      line = $0
      sub(/\r$/, "", line)
      sha = substr(line, 1, 64)
      separator = substr(line, 65, 2)
      file = substr(line, 67)
      if (sha !~ /^[0-9a-fA-F]{64}$/ || separator != "  " || file == "" || file ~ /[[:space:]]/) {
        printf "checksums.txt line %d is invalid\n", NR > "/dev/stderr"
        exit 1
      }
      if (!(file in allowed)) {
        printf "checksums.txt contains unsupported entry: %s\n", file > "/dev/stderr"
        exit 1
      }
      if (seen[file]) {
        printf "checksums.txt contains duplicate entry: %s\n", file > "/dev/stderr"
        exit 1
      }
      seen[file] = 1
    }
    END {
      for (file in allowed) {
        if (!seen[file]) {
          printf "checksums.txt missing required entry: %s\n", file > "/dev/stderr"
          exit 1
        }
      }
    }
  ' "$checksums_file"
}

validate_images_lock() {
  if [ ! -f "$repo_root/dist/packages/sandbox-controller/src/appImageLock.js" ]; then
    (cd "$repo_root" && npm run build >/dev/null)
  fi
  node "$repo_root/scripts/deploy/app-images-lock.mjs" "$lock_file" >/dev/null
}

require_file "$checksums_file"
require_file "$lock_file"
require_file "$app_archive"
require_file "$runner_archive"
require_nonempty_archive "$app_archive"
require_nonempty_archive "$runner_archive"

validate_checksum_contract

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
