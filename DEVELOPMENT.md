# Development

## Commands

```bash
npm run typecheck
npm test
npm run check:forbidden-surfaces
npm run e2e:smoke
npm run e2e:operator-lifecycle
npm run visual:screenshot
```

`npm test` runs focused unit/service/API/boundary tests. The independent smoke, operator lifecycle e2e, and browser visual checks are manual commands; operator lifecycle and visual are not default release gates.

For local API development, `scripts/dev/up.sh` defaults to `.data`, `admin-password`, and `dev-session-secret`, so the normal local dry-run flow does not need substrate output. When debugging against product-level substrate config, `scripts/dev/up.sh --env substrate.env --secrets substrate.secrets.env` sources those files and exports only the API allowlist, including `JUICEFS_PVC_NAME` for sandbox PVC rendering. Raw `S3_*` values and JuiceFS meta/storage/CSI internals such as `JUICEFS_META_URL`, `JUICEFS_BUCKET`, `JUICEFS_VOLUME_NAME`, `JUICEFS_SECRET_NAME`, `JUICEFS_CSI_DRIVER`, `JUICEFS_STORAGE_CLASS`, and `JUICEFS_MOUNT_ROOT` are intentionally withheld from the child environment.

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
