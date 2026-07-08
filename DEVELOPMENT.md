# Development

## Commands

```bash
npm run typecheck
npm test
npm run check:forbidden-surfaces
npm run acceptance:botified-runner
npm run acceptance:botified-runner-image
npm run e2e:operator-lifecycle
npm run visual:screenshot
```

`npm test` runs focused unit/service/API/boundary tests. `acceptance:botified-runner` is an opt-in local runner process check: it builds the Node output, starts the vendored Botified binary with `--mock-provider`, observes the mock-provider bash marker through timeline/state, verifies the published file, and calls abort.

`acceptance:botified-runner-image` is the next opt-in layer: it builds `agentsmith-lite/botified-runner:acceptance` from `infra/docker/Dockerfile.botified-runner`, runs the runner container with the mock provider, and checks health/messages/timeline/file download/state/abort over a random loopback port. It requires Docker to pull the Dockerfile base images. When it succeeds, it is runner-container-only acceptance and does not exercise Kubernetes scheduling, PVC/JuiceFS behavior, product task artifact flow, `publish_file`, or cancel/reap.

The operator lifecycle e2e and browser visual checks are manual commands, not default test commands. Use `scripts/deploy/doctor.sh --env substrate.env --secrets substrate.secrets.env --app-env app.env --app-secrets app.secrets.env --out out/manifests --bundle dist/app-offline-bundle` for direct app deploy checks.

For local API development, `scripts/dev/up.sh` defaults to `.data`, `admin-password`, and `dev-session-secret`, so the normal local dry-run flow does not need substrate output. When debugging against product-level substrate config, `scripts/dev/up.sh --env substrate.env --secrets substrate.secrets.env [--app-env app.env] [--app-secrets app.secrets.env]` parses those files through the deploy env contract. `--env`/`--secrets` are the substrate contract and export only the app-consumed substrate intersection, including product core secrets and `JUICEFS_PVC_NAME` for sandbox PVC rendering. Auth supports `AUTH_MODE=builtin_admin` and `AUTH_MODE=oidc`; builtin mode filters empty OIDC placeholders, while OIDC mode requires `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` without printing secret values in errors. App-owned runtime/model overrides such as `AGENTSMITH_LITE_SANDBOX_MODE`, `AGENTSMITH_LITE_MODEL_BASE_URL_*`, and `AGENTSMITH_LITE_MODEL_API_KEY_*` belong in the app overlay flags. Raw `S3_*` values, generated substrate metadata, registry/pull-secret hints, and JuiceFS meta/storage/CSI internals such as `JUICEFS_META_URL`, `JUICEFS_BUCKET`, `JUICEFS_VOLUME_NAME`, `JUICEFS_SECRET_NAME`, `JUICEFS_CSI_DRIVER`, `JUICEFS_STORAGE_CLASS`, and `JUICEFS_MOUNT_ROOT` are intentionally withheld from the child environment and app overlay.

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
