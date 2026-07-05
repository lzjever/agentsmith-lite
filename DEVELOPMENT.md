# Development

## Commands

```bash
npm run typecheck
npm test
npm run check:forbidden-surfaces
npm run acceptance:botified-runner
npm run acceptance:botified-runner-image
npm run e2e:smoke
npm run e2e:operator-lifecycle
npm run visual:screenshot
```

`npm test` runs focused unit/service/API/boundary tests. `acceptance:botified-runner` is an opt-in local runner process check: it builds the Node output, starts the vendored Botified binary with `--mock-provider`, observes the bash release-smoke marker through timeline/state, and calls abort.

`acceptance:botified-runner-image` is the next opt-in layer: it builds `agentsmith-lite/botified-runner:acceptance` from `infra/docker/Dockerfile.botified-runner`, runs the runner container with the mock provider, and checks health/messages/timeline/state/abort over a random loopback port. It requires Docker to pull the Dockerfile base images; if the registry or base images are unavailable, the command cannot be used as evidence. When it succeeds, it is runner-container-only acceptance and does not prove Kubernetes scheduling, PVC/JuiceFS behavior, product task artifact flow, `publish_file`, or cancel/reap; those remain external acceptance evidence.

The independent smoke, operator lifecycle e2e, and browser visual checks are manual commands; operator lifecycle and visual are not default release gates.

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
