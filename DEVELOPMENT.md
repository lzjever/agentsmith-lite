# Development

## Commands

```bash
npm run typecheck
npm test
npm run visual:screenshot
```

`npm test` runs focused unit, service, and API behavior tests. Browser visual checks are manual commands, not default test commands. Use `scripts/deploy/render.sh` and `scripts/deploy/apply.sh` for app deployment.

For local API development, `scripts/dev/up.sh` defaults to `.data`, `admin-password`, and `dev-session-secret`, so the normal local dry-run flow does not need substrate output. When debugging against product-level substrate config, `scripts/dev/up.sh --env substrate.env --secrets substrate.secrets.env [--app-env app.env] [--app-secrets app.secrets.env]` parses those files through the deploy env contract. `--env`/`--secrets` are the substrate contract and export only the app-consumed substrate intersection, including product core secrets and `JUICEFS_PVC_NAME` for sandbox PVC rendering. Auth supports `AUTH_MODE=builtin_admin` and `AUTH_MODE=oidc`; builtin mode filters empty OIDC placeholders and fails closed on non-empty OIDC runtime keys, while OIDC mode requires `OIDC_ISSUER_URL` and `OIDC_CLIENT_ID` from substrate env plus `OIDC_CLIENT_SECRET` from substrate secrets; `OIDC_BACKCHANNEL_BASE_URL`, when set, also comes from substrate env. Optional admin allowlists in `OIDC_ADMIN_EMAILS` and `OIDC_ADMIN_SUBJECTS` come only from `--app-env`, without printing secret values in errors. App-owned runtime/model overrides such as `AGENTSMITH_LITE_SANDBOX_MODE`, `AGENTSMITH_LITE_MODEL_BASE_URL_*`, and `AGENTSMITH_LITE_MODEL_API_KEY_*` belong in the app overlay flags. Raw `S3_*` values, generated substrate metadata, registry/pull-secret hints, and JuiceFS meta/storage/CSI internals such as `JUICEFS_META_URL`, `JUICEFS_BUCKET`, `JUICEFS_VOLUME_NAME`, `JUICEFS_SECRET_NAME`, `JUICEFS_CSI_DRIVER`, `JUICEFS_STORAGE_CLASS`, and `JUICEFS_MOUNT_ROOT` are intentionally withheld from the child environment and app overlay.

## Package Boundaries

- `packages/contracts`: product API and shared data types.
- `packages/domain`: small domain validation/errors/IDs.
- `packages/ports`: storage and runtime interfaces.
- `packages/adapters-postgres`: migration contract plus in-memory test adapter.
- `packages/application`: auth, workspace/project, endpoint, chat, file path validation, task services.
- `packages/sandbox-controller`: dry-run app/sandbox manifest builders.
- `packages/botified-runtime`: config generator, event projection, serve wrapper.
- `packages/openai-compatible-client`: OpenAI-compatible validation and P0 mock client.
- `packages/api-entry-node`: Node HTTP API and static Web serving.

The Web UI under `src/web` must call only `/api/*`.
