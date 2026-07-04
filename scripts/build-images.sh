#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

tag=dev
dry_run=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) tag="$2"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

commands=(
  "docker build -f infra/docker/Dockerfile.app -t agentsmith-lite/app:${tag} ."
  "docker build -f infra/docker/Dockerfile.botified-runner -t agentsmith-lite/botified-runner:${tag} ."
)

for command in "${commands[@]}"; do
  if [ "$dry_run" = true ]; then
    echo "$command"
  else
    eval "$command"
  fi
done

