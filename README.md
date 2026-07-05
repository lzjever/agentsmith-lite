# AgentSmith Lite

AgentSmith Lite is a small product repo for the P0/P2/P3 app skeleton: Node API, minimal Web UI, shared contracts, Postgres ports, sandbox manifest rendering, and Botified runtime integration.

Business logic lives on the server side. The Web UI is a product API client only.

Product planning: [AgentSmith Lite Product Development Plan](docs/agentsmith-lite-product-development-plan.md).

## Quick Start

```bash
npm install
npm run typecheck
npm test
npm run dev
```

Default local login:

- email: `admin@agentsmith-lite.local`
- password: `admin-password`

Open `http://127.0.0.1:3000`.

`scripts/dev/up.sh` is the local-dev wrapper around `npm run dev`. With no flags it keeps the same local dry-run defaults and does not require substrate files. To run the local API with product-level substrate config, pass:

```bash
scripts/dev/up.sh --env substrate.env --secrets substrate.secrets.env \
  --app-env app.env --app-secrets app.secrets.env
```

`--env` and `--secrets` are the substrate contract. They export only the app-consumed substrate intersection, such as `APP_PUBLIC_BASE_URL`, Kubernetes namespace/context values, `JUICEFS_PVC_NAME`, and product core secrets from `substrate.secrets.env` (`POSTGRES_APP_URL`, `APP_SESSION_SECRET`, `BUILTIN_ADMIN_INITIAL_PASSWORD`, and optional OIDC client secret). App-owned runtime/deploy overrides belong in `--app-env` (`BOTIFIED_RUNNER_IMAGE`, `AGENTSMITH_LITE_DATA_DIR`, sandbox mode/limit/tick settings, and `AGENTSMITH_LITE_MODEL_BASE_URL_*`); model API keys named `AGENTSMITH_LITE_MODEL_API_KEY_*` belong in `--app-secrets`. Raw substrate storage and CSI internals such as `S3_*`, `JUICEFS_META_URL`, `JUICEFS_BUCKET`, `JUICEFS_VOLUME_NAME`, `JUICEFS_SECRET_NAME`, `JUICEFS_CSI_DRIVER`, `JUICEFS_STORAGE_CLASS`, and `JUICEFS_MOUNT_ROOT` are not passed to the API child process or app overlay.

## Manual Checks

These are opt-in developer checks, not part of the default release path:

```bash
npm run acceptance:botified-runner
npm run acceptance:botified-runner-image
npm run e2e:smoke
npm run e2e:operator-lifecycle
npm run visual:screenshot
```

`acceptance:botified-runner` builds the Node output first, then runs a local Botified runner process from the pinned vendored binary with `--mock-provider`, posts the release-smoke trigger, observes bash output in timeline/state, and calls abort. It still expects the Rust binary at `third_party/botified/target/release/botified`. This is local runner process acceptance only; Kubernetes Pod/PVC, JuiceFS artifact smoke, and cleanup evidence still require an external environment.

`acceptance:botified-runner-image` builds the Node output, builds `agentsmith-lite/botified-runner:acceptance` from `infra/docker/Dockerfile.botified-runner`, runs that runner container with the mock provider, and exercises `/healthz`, `/v1/messages`, `/v1/timeline`, `/v1/state`, and `/v1/abort` through a random loopback port. It requires Docker to pull the Dockerfile base images; if the registry or base images are unavailable, the command cannot be used as evidence. When it succeeds, this is runner-container-only acceptance; it does not cover Kubernetes, PVC, JuiceFS, product task API, `publish_file`, or cancel/reap evidence.

The operator lifecycle e2e and visual screenshot are independent manual gates; they are not run by `npm test` or the default release gate. The screenshot is written to `out/visual/agentsmith-lite-dashboard.png`.

## Deploy Skeleton

```bash
scripts/build-images.sh --tag dev --push --images-lock dist/images.lock
scripts/build-offline-bundle.sh \
  --images-lock dist/images.lock \
  --output dist/app-offline-bundle
scripts/deploy/import-images.sh --bundle dist/app-offline-bundle
scripts/deploy/render.sh --env substrate.env --secrets substrate.secrets.env \
  --app-env app.env --app-secrets app.secrets.env \
  --tag dev --out out/manifests --images-lock dist/app-offline-bundle/images.lock
scripts/deploy/doctor.sh --env substrate.env --secrets substrate.secrets.env \
  --app-env app.env --app-secrets app.secrets.env \
  --out out/manifests --bundle dist/app-offline-bundle
scripts/deploy/smoke.sh --env substrate.env --secrets substrate.secrets.env --app-env app.smoke.env [--report out/smoke-report.json]
```

Use `scripts/build-images.sh --tag dev --push --images-lock dist/images.lock --dry-run` to print the build/push/write-lock intent without calling the container runtime. The digest-pinned lock is written only after a successful push, using the runtime-reported `RepoDigests`; a real registry digest is not available from the local image ID alone.

Deploy smoke is an API-only remote check. It reads `APP_PUBLIC_BASE_URL` from the substrate env file unless `--base-url` is provided, bootstraps/logs in with `BUILTIN_ADMIN_INITIAL_PASSWORD` from substrate secrets, then covers health, workspace/project creation, file upload/list/download/delete, and operator sandbox status. On success it prints redacted JSON to stdout and writes the same JSON to `out/smoke-report.json` by default; use `--report <path>` to override the report path. The report includes `profile: "light"` unless task or task reclaim smoke is enabled, in which case it is `profile: "full"`. Endpoint/chat smoke is opt-in with `--endpoint-base-url`, `--endpoint-model`, and `--endpoint-secret-ref`, or the matching `SMOKE_ENDPOINT_BASE_URL`, `SMOKE_ENDPOINT_MODEL`, and `SMOKE_ENDPOINT_SECRET_REF` values from `--app-env`. Task artifact smoke stays off by default; enable the Botified `publish_file` artifact smoke explicitly with `--task-smoke` or `SMOKE_TASK=true` in `--app-env`, and only with complete endpoint smoke config. On success it creates a task, polls `/events` and `/artifacts`, downloads the artifact, and verifies the marker content. Task reclaim smoke is another explicit manual opt-in with `--task-reclaim-smoke` or `SMOKE_TASK_RECLAIM=true` in `--app-env`; it creates a separate task, cancels it, then calls scoped `/api/operator/sandbox/reap` dry-run for that `runId`. Add `--task-reclaim-reap-apply` or `SMOKE_TASK_RECLAIM_REAP_APPLY=true` in `--app-env` only with reclaim smoke to run scoped dry-run, scoped apply, and final scoped dry-run. These task smokes are not default gates and do not replace real Kubernetes/JuiceFS external evidence.

Operator sandbox status and cleanup use the product API and require an authenticated admin session cookie:

```bash
scripts/deploy/status.sh --env substrate.env --resources --cookie-file admin.cookie --csrf-token <csrf>
scripts/deploy/cleanup-stuck-tasks.sh --env substrate.env --dry-run --cookie-file admin.cookie --csrf-token <csrf>
scripts/deploy/cleanup-stuck-tasks.sh --env substrate.env --apply --cookie-file admin.cookie --csrf-token <csrf> [--run-id <run-id>]
scripts/deploy/down.sh --env substrate.env [--dry-run]
```

Pass `--base-url` or set `APP_PUBLIC_BASE_URL` in the substrate env file. Status, cleanup, and down only need substrate env, not app overlay. Cleanup defaults to dry-run unless `--apply` is passed; `--dry-run` and `--apply` cannot be combined. These scripts do not bootstrap or log in; status and cleanup only call `/api/operator/sandbox/status` and `/api/operator/sandbox/reap`.

App deploy renders product config into app-owned Kubernetes resources: substrate env provides the app-consumed public/namespace/PVC fields, `--app-env` provides non-secret app-owned runtime values such as `AGENTSMITH_LITE_MODEL_BASE_URL_*`, and substrate secrets provide `POSTGRES_APP_URL`, `APP_SESSION_SECRET`, `BUILTIN_ADMIN_INITIAL_PASSWORD`, and optional OIDC/admin secrets. Model API keys named `AGENTSMITH_LITE_MODEL_API_KEY_*` come from `--app-secrets`. S3 raw credentials and JuiceFS substrate secrets such as `JUICEFS_META_URL` stay with the substrate/CSI layer and must not be placed in app overlay.

Model endpoints store `apiKeySecretRef` values such as `secret/openai`; the server maps that to both `AGENTSMITH_LITE_MODEL_API_KEY_OPENAI` and `AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI` when handling chat. The endpoint base URL must be HTTPS and must match the server-configured base URL for that secret ref.
