# Operator Notes

This repo consumes a substrate env contract produced by `agentsmith-lite-substrates`.

Required app product secrets:

- `POSTGRES_APP_URL`
- `APP_SESSION_SECRET`
- `BUILTIN_ADMIN_INITIAL_PASSWORD` for built-in admin bootstrap

OIDC/Keycloak is deferred. The current app does not consume or render `OIDC_CLIENT_SECRET`. The app deploy contract tolerates generated builtin auth metadata and empty OIDC placeholders (`AUTH_MODE=builtin_admin`, `OIDC_ISSUER_URL=`, `OIDC_CLIENT_ID=`, `OIDC_CLIENT_SECRET=`) and filters them; non-builtin auth modes and non-empty OIDC values fail closed without printing values.

Substrate-only secrets such as `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `JUICEFS_META_URL` must not be injected into app server, sandbox pods, Botified env, or app-owned Secrets.

`--env`/`--secrets` are the substrate contract. App-owned deploy/runtime/workflow-check overrides belong in `--app-env`/`--app-secrets`; product core secrets still come from substrate secrets, and raw S3/JuiceFS substrate secrets must not be placed in app overlay.

App doctor owns app delivery checks: image metadata, schema bootstrap job, web/API readiness, sandbox RBAC shape, and Botified pin/config shape. Use `scripts/deploy/preflight.sh --env substrate.env --secrets substrate.secrets.env --app-env app.env --app-secrets app.secrets.env --out out/manifests --bundle dist/app-offline-bundle` for manual local/config diagnosis before deploy; it runs doctor static checks only and does not run product workflow, e2e, visual, build, push, import, or live K8s calls. Use `scripts/deploy/check-product-workflow.sh --env substrate.env --secrets substrate.secrets.env --app-env app.workflow.env` for a remote API workflow check: it bootstraps/logs in with the configured built-in admin secret, checks product API health, workspace/project/file CRUD, optional endpoint/chat, optional task artifact creation, optional task cancel/reap, and operator sandbox status. Add `--check-k8s-run-resources` only when read-only Kubernetes run-resource observation is needed. The workflow command prints redacted JSON to stdout and exits non-zero on failure. App doctor always runs static manifest/env checks; when the substrate env file sets `KUBECONFIG_PATH` or `KUBE_CONTEXT`, it also verifies deployed schema/API/PVC/RBAC facts unless `--static-only` is passed. Substrate doctor owns Kubernetes/PostgreSQL/S3/JuiceFS/RWX substrate readiness.

## Sandbox Operator CLI

Sandbox lifecycle status and cleanup are API-backed. Use an admin session cookie file and CSRF token from an explicit login flow; the deploy scripts do not bootstrap or log in.

```bash
scripts/deploy/status.sh --env substrate.env --resources --cookie-file admin.cookie --csrf-token <csrf>
scripts/deploy/cleanup-stuck-tasks.sh --env substrate.env --dry-run --cookie-file admin.cookie --csrf-token <csrf>
scripts/deploy/cleanup-stuck-tasks.sh --env substrate.env --apply --cookie-file admin.cookie --csrf-token <csrf> [--run-id <run-id>]
scripts/deploy/down.sh --env substrate.env [--dry-run]
```

Use `--base-url` or set `APP_PUBLIC_BASE_URL` in the substrate env file. Status, cleanup, and down only need substrate env, not app overlay. `status.sh --resources` calls `GET /api/operator/sandbox/status`; `cleanup-stuck-tasks.sh` calls `POST /api/operator/sandbox/reap`. Dry-run sends `{}` or `{ "runId": "..." }`; apply sends `{ "apply": true }` plus `runId` when `--run-id` is provided. `--dry-run` and `--apply` cannot be combined.

The formatted cleanup plan comes only from the product API. `kubectl` must not be used to derive sandbox cleanup targets.

## Manual Checks

`npm run e2e:operator-lifecycle` and `npm run visual:screenshot` are independent manual checks. They are useful before risky runtime, operator, or UI changes, but they are not part of `npm test`.
