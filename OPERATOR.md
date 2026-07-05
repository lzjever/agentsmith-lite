# Operator Notes

This repo consumes a substrate env contract produced by `agentsmith-lite-substrates`.

Required app product secrets:

- `POSTGRES_APP_URL`
- `APP_SESSION_SECRET`
- `BUILTIN_ADMIN_INITIAL_PASSWORD` for built-in admin bootstrap
- optional OIDC/admin secrets when OIDC is enabled later

Substrate-only secrets such as `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `JUICEFS_META_URL` must not be injected into app server, sandbox pods, Botified env, or app-owned Secrets.

App doctor owns app delivery checks: image metadata, schema bootstrap job, web/API readiness, sandbox RBAC shape, and Botified serve smoke. Deploy smoke is API-only: it bootstraps/logs in with the configured built-in admin secret, checks product API health, workspace/project/file CRUD, optional endpoint/chat, and operator sandbox status. Optional task create/cancel smoke requires explicit `--task-smoke` or `SMOKE_TASK=true` plus complete endpoint smoke config. App doctor always runs static manifest/env checks; when the substrate env file sets `KUBECONFIG_PATH` or `KUBE_CONTEXT`, it also verifies deployed schema/API/PVC/RBAC facts. Substrate doctor owns Kubernetes/PostgreSQL/S3/JuiceFS/RWX substrate readiness.

## Sandbox Operator CLI

Sandbox lifecycle status and dry-run cleanup are API-backed. Use an admin session cookie file and CSRF token from an explicit login flow; the deploy scripts do not bootstrap or log in.

```bash
scripts/deploy/status.sh --env substrate.env --resources --cookie-file admin.cookie --csrf-token <csrf>
scripts/deploy/cleanup-stuck-tasks.sh --env substrate.env --dry-run --cookie-file admin.cookie --csrf-token <csrf>
```

Use `--base-url` or set `APP_PUBLIC_BASE_URL` in the env file. `status.sh --resources` calls `GET /api/operator/sandbox/status`; `cleanup-stuck-tasks.sh --dry-run` calls `POST /api/operator/sandbox/reap` with `{}` or `{ "runId": "..." }` when `--run-id` is provided. The cleanup script intentionally refuses apply mode in this release.

The formatted cleanup plan comes only from the product API. `kubectl` must not be used to derive sandbox cleanup targets.

## Manual Gates

`npm run e2e:smoke`, `npm run e2e:operator-lifecycle`, and `npm run visual:screenshot` are independent manual gates. They are useful before risky runtime, operator, or UI changes, but they are not part of `npm test` or the default release gate.
