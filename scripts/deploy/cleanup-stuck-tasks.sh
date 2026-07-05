#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
namespace=agentsmith
dry_run=false
apply=false
base_url="${APP_PUBLIC_BASE_URL:-}"
cookie_file=""
csrf_token=""
run_id=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env) source "$2"; namespace="${KUBE_NAMESPACE:-agentsmith}"; base_url="${APP_PUBLIC_BASE_URL:-${base_url}}"; shift 2 ;;
    --base-url) base_url="$2"; shift 2 ;;
    --cookie-file) cookie_file="$2"; shift 2 ;;
    --csrf-token) csrf_token="$2"; shift 2 ;;
    --run-id) run_id="$2"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    --apply) apply=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$dry_run" = false ] || [ "$apply" = false ] || { echo "--dry-run and --apply cannot be used together" >&2; exit 2; }
mode_flag=--dry-run
if [ "$apply" = true ]; then
  mode_flag=--apply
fi
[ -n "$base_url" ] || { echo "cleanup-stuck-tasks.sh $mode_flag requires --base-url or APP_PUBLIC_BASE_URL plus operator sandbox API auth." >&2; exit 2; }
[ -n "$cookie_file" ] || { echo "cleanup-stuck-tasks.sh $mode_flag requires --cookie-file for operator sandbox API auth." >&2; exit 2; }
[ -f "$cookie_file" ] || { echo "cookie file not found: $cookie_file" >&2; exit 2; }
[ -n "$csrf_token" ] || { echo "cleanup-stuck-tasks.sh $mode_flag requires --csrf-token for operator sandbox API auth." >&2; exit 2; }

helper_args=(scripts/deploy/operator-sandbox.mjs reap "$mode_flag" --base-url "$base_url" --cookie-file "$cookie_file" --csrf-token "$csrf_token")
if [ -n "$run_id" ]; then
  helper_args+=(--run-id "$run_id")
fi
node "${helper_args[@]}"
