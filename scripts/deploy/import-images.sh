#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

bundle=
k3s_bin=
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
    --k3s-bin)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "--k3s-bin requires a path" >&2
        exit 2
      fi
      k3s_bin="$2"
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
if [ -z "$k3s_bin" ]; then
  echo "--k3s-bin is required" >&2
  exit 2
fi
if [ ! -d "$bundle" ]; then
  echo "bundle directory does not exist: $bundle" >&2
  exit 1
fi
if [ ! -f "$k3s_bin" ] || [ ! -x "$k3s_bin" ]; then
  echo "--k3s-bin must be an executable file: $k3s_bin" >&2
  exit 1
fi

checksums_file="$bundle/checksums.txt"
lock_file="$bundle/images.lock"
app_archive="$bundle/images/app.tar"
runner_archive="$bundle/images/botified-runner.tar"
app_image_ref=
runner_image_ref=
oci_validator="$script_dir/validate-oci-archive.sh"

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
  local refs

  if [ ! -f "$repo_root/dist/packages/sandbox-controller/src/appImageLock.js" ]; then
    (cd "$repo_root" && npm run build >/dev/null)
  fi
  refs="$(node "$repo_root/scripts/deploy/app-images-lock.mjs" "$lock_file")"
  app_image_ref="$(printf '%s\n' "$refs" | sed -n '1p')"
  runner_image_ref="$(printf '%s\n' "$refs" | sed -n '2p')"
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

validate_oci_archive() {
  local archive="$1"
  local image_ref="$2"
  bash "$oci_validator" "$archive" "${image_ref#*@}"
}

validate_oci_archive "$app_archive" "$app_image_ref"
validate_oci_archive "$runner_archive" "$runner_image_ref"

load_image() {
  local archive="$1"
  local image_ref="$2"
  local image_name="${image_ref%%@*}"
  if [ "$dry_run" = true ]; then
    printf '%s ctr -n k8s.io images import --base-name %s --digests %s\n' "$k3s_bin" "$image_name" "$archive"
    printf '%s ctr -n k8s.io images tag --force %s@%s %s\n' "$k3s_bin" "$image_name" "${image_ref#*@}" "$image_ref"
    printf '%s ctr -n k8s.io images ls -q name==%s\n' "$k3s_bin" "$image_ref"
    return
  fi
  "$k3s_bin" ctr -n k8s.io images import --base-name "$image_name" --digests "$archive"
  "$k3s_bin" ctr -n k8s.io images tag --force "$image_name@${image_ref#*@}" "$image_ref"
  local resolved_image
  if ! resolved_image="$("$k3s_bin" ctr -n k8s.io images ls -q "name==$image_ref")"; then
    echo "k3s containerd could not resolve imported image: $image_ref" >&2
    exit 1
  fi
  if [ "$resolved_image" != "$image_ref" ]; then
    echo "k3s containerd did not resolve imported image: $image_ref" >&2
    exit 1
  fi
}

load_image "$app_archive" "$app_image_ref"
load_image "$runner_archive" "$runner_image_ref"
