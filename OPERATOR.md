# Operator Notes

This repo consumes a substrate env contract produced by `agentsmith-lite-substrates`.

Required app product secrets:

- `POSTGRES_APP_URL`
- `APP_SESSION_SECRET`
- `BUILTIN_ADMIN_INITIAL_PASSWORD` for built-in admin bootstrap
- optional OIDC/admin secrets when OIDC is enabled later

Substrate-only secrets such as `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `JUICEFS_META_URL` must not be injected into app server, sandbox pods, Botified env, or app-owned Secrets.

App doctor/smoke owns app delivery checks: image metadata, schema bootstrap job, web/API readiness, sandbox RBAC shape, and Botified serve smoke. Substrate doctor owns Kubernetes/PostgreSQL/S3/JuiceFS/RWX substrate readiness.

