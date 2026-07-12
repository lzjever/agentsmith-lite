#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

tag=dev
runtime="${CONTAINER_RUNTIME:-docker}"
push=false
images_lock=
dry_run=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "--tag requires a value" >&2
        exit 2
      fi
      tag="$2"
      shift 2
      ;;
    --runtime)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "--runtime requires docker, podman, or another compatible runtime" >&2
        exit 2
      fi
      runtime="$2"
      shift 2
      ;;
    --push)
      push=true
      shift
      ;;
    --images-lock)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "--images-lock requires a path" >&2
        exit 2
      fi
      images_lock="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$images_lock" ] && [ "$push" != true ]; then
  echo "--images-lock requires --push so registry RepoDigests are available" >&2
  exit 2
fi

app_image="agentsmith-lite/app:${tag}"
runner_image="agentsmith-lite/botified-runner:${tag}"
node_build_heap_mb="${NODE_BUILD_HEAP_MB:-2048}"
cargo_build_jobs="${CARGO_BUILD_JOBS:-1}"

if [ -z "${APP_PUBLIC_BASE_URL:-}" ]; then
  echo "APP_PUBLIC_BASE_URL is required to build the Next application" >&2
  exit 2
fi
APP_PUBLIC_BASE_URL="$(node scripts/public-base-url.mjs "$APP_PUBLIC_BASE_URL")"
export APP_PUBLIC_BASE_URL

run_runtime() {
  if [ "$dry_run" = true ]; then
    printf '%s %s\n' "$runtime" "$*"
    return
  fi
  "$runtime" "$@"
}

capture_repo_digest() {
  local image_ref="$1"
  local image_name="$2"
  local inspect_json=
  local digest=
  local status=0

  if ! inspect_json="$("$runtime" image inspect "$image_ref")"; then
    echo "failed to inspect pushed image: $image_ref" >&2
    exit 1
  fi

  set +e
  digest="$(printf '%s' "$inspect_json" | EXPECTED_IMAGE_NAME="$image_name" node -e '
const fs = require("node:fs");
const imageName = process.env.EXPECTED_IMAGE_NAME;
const input = fs.readFileSync(0, "utf8");
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let inspectDocs;
try {
  inspectDocs = JSON.parse(input);
} catch (error) {
  console.error(`runtime image inspect returned invalid JSON for ${imageName}`);
  process.exit(11);
}

const docs = Array.isArray(inspectDocs) ? inspectDocs : [inspectDocs];
const digestPattern = new RegExp(`^${escapeRegExp(imageName)}@sha256:[0-9a-fA-F]{64}$`);
const matches = [];
for (const doc of docs) {
  if (!doc || !Array.isArray(doc.RepoDigests)) continue;
  for (const repoDigest of doc.RepoDigests) {
    if (typeof repoDigest === "string" && digestPattern.test(repoDigest)) {
      matches.push(repoDigest);
    }
  }
}

const uniqueMatches = [...new Set(matches)];
if (uniqueMatches.length === 0) {
  console.error(`no canonical RepoDigest found for ${imageName}`);
  process.exit(10);
}
if (uniqueMatches.length > 1) {
  console.error(`multiple canonical RepoDigests found for ${imageName}`);
  process.exit(12);
}
console.log(uniqueMatches[0]);
')"
  status=$?
  set -e

  if [ "$status" -ne 0 ]; then
    echo "failed to capture canonical RepoDigest for $image_name from runtime image inspect" >&2
    exit 1
  fi

  printf '%s\n' "$digest"
}

write_images_lock() {
  local lock_file="$1"
  local app_digest="$2"
  local runner_digest="$3"
  local lock_dir=
  local temp_lock=

  lock_dir="$(dirname "$lock_file")"
  mkdir -p "$lock_dir"
  temp_lock="$(mktemp "$lock_dir/.images.lock.XXXXXX")"
  {
    printf '%s\n' "$app_digest"
    printf '%s\n' "$runner_digest"
  } > "$temp_lock"
  mv "$temp_lock" "$lock_file"
}

run_runtime build --build-arg "APP_PUBLIC_BASE_URL=${APP_PUBLIC_BASE_URL}" --build-arg "NODE_BUILD_HEAP_MB=${node_build_heap_mb}" -f infra/docker/Dockerfile.app -t "$app_image" .
run_runtime build --build-arg "CARGO_BUILD_JOBS=${cargo_build_jobs}" -f infra/docker/Dockerfile.botified-runner -t "$runner_image" .

if [ "$push" = true ]; then
  run_runtime push "$app_image"
  run_runtime push "$runner_image"
fi

if [ -n "$images_lock" ]; then
  if [ "$dry_run" = true ]; then
    printf 'write images.lock from RepoDigests to %s\n' "$images_lock"
  else
    rm -f "$images_lock"
    app_digest="$(capture_repo_digest "$app_image" "agentsmith-lite/app")"
    runner_digest="$(capture_repo_digest "$runner_image" "agentsmith-lite/botified-runner")"
    write_images_lock "$images_lock" "$app_digest" "$runner_digest"
  fi
fi
