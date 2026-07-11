# Operator Notes

This repo consumes a substrate env contract produced by `agentsmith-lite-substrates`.

Required app product secrets:

- `POSTGRES_APP_URL`
- `APP_SESSION_SECRET`
- `BUILTIN_ADMIN_INITIAL_PASSWORD` when `AUTH_MODE=builtin_admin`
- `OIDC_CLIENT_SECRET` when `AUTH_MODE=oidc`

The app deploy contract supports `AUTH_MODE=builtin_admin` and `AUTH_MODE=oidc`. Built-in admin keeps generated empty OIDC placeholders filtered out and fails closed on non-empty OIDC runtime keys. OIDC requires non-empty `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`; issuer/client values and optional `OIDC_BACKCHANNEL_BASE_URL` come only from substrate env, `OIDC_CLIENT_SECRET` comes from substrate secrets, and optional `OIDC_ADMIN_EMAILS` and `OIDC_ADMIN_SUBJECTS` come only from app env overlay. OIDC env values render into app config and `OIDC_CLIENT_SECRET` renders into the app Secret. Contract errors name keys without printing secret values.

Substrate-only secrets such as `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `JUICEFS_META_URL` must not be injected into app server, sandbox pods, Botified env, or app-owned Secrets.

`--env`/`--secrets` are the substrate contract. App-owned deploy/runtime overrides belong in `--app-env`/`--app-secrets`; product core secrets still come from substrate secrets, and raw S3/JuiceFS substrate secrets must not be placed in app overlay.

Use `scripts/deploy/render.sh` and `scripts/deploy/apply.sh` for app manifest rendering and apply-time readiness.

## Sandbox Operator CLI

Sandbox lifecycle status and reaping are API-backed. Use an admin session cookie file and CSRF token from an explicit login flow; the deploy scripts do not bootstrap or log in.

```bash
scripts/deploy/status.sh --env substrate.env
node scripts/deploy/operator-sandbox.mjs status --base-url <url> --cookie-file admin.cookie
node scripts/deploy/operator-sandbox.mjs reap --base-url <url> --cookie-file admin.cookie --csrf-token <csrf> --dry-run
node scripts/deploy/operator-sandbox.mjs reap --base-url <url> --cookie-file admin.cookie --csrf-token <csrf> --apply [--run-id <run-id>]
scripts/deploy/down.sh --env substrate.env [--dry-run]
```

Use `--base-url` or set `APP_PUBLIC_BASE_URL` in the substrate env file. Status and down only need substrate env, not app overlay. `operator-sandbox.mjs status` calls `GET /api/operator/sandbox/status`; `operator-sandbox.mjs reap` calls `POST /api/operator/sandbox/reap`. Dry-run sends `{}` or `{ "runId": "..." }`; apply sends `{ "apply": true }` plus `runId` when `--run-id` is provided. `--dry-run` and `--apply` cannot be combined.

The formatted cleanup plan comes only from the product API. `kubectl` must not be used to derive sandbox cleanup targets.
