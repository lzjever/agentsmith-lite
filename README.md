# AgentSmith Lite

AgentSmith Lite is a small product repo for the P0/P2/P3 app skeleton: Node API, minimal Web UI, shared contracts, Postgres ports, sandbox manifest rendering, and Botified runtime integration.

Business logic lives on the server side. The Web UI is a product API client only.

Product plan: [AgentSmith Lite Product Development Plan](docs/agentsmith-lite-product-development-plan.md).

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

`--env` and `--secrets` are the substrate contract. They export only the app-consumed substrate intersection, such as `APP_PUBLIC_BASE_URL`, Kubernetes namespace/context values, `JUICEFS_PVC_NAME`, and product core secrets from `substrate.secrets.env` (`POSTGRES_APP_URL`, `APP_SESSION_SECRET`, plus either `BUILTIN_ADMIN_INITIAL_PASSWORD` for `AUTH_MODE=builtin_admin` or `OIDC_CLIENT_SECRET` for `AUTH_MODE=oidc`). Built-in mode filters empty OIDC placeholders. OIDC mode requires non-empty `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`; errors name keys without printing secret values. App-owned runtime/deploy overrides belong in `--app-env` (`BOTIFIED_RUNNER_IMAGE`, `AGENTSMITH_LITE_DATA_DIR`, sandbox mode/limit/tick settings, and `AGENTSMITH_LITE_MODEL_BASE_URL_*`); model API keys named `AGENTSMITH_LITE_MODEL_API_KEY_*` belong in `--app-secrets`. Raw substrate storage and CSI internals such as `S3_*`, `JUICEFS_META_URL`, `JUICEFS_BUCKET`, `JUICEFS_VOLUME_NAME`, `JUICEFS_SECRET_NAME`, `JUICEFS_CSI_DRIVER`, `JUICEFS_STORAGE_CLASS`, and `JUICEFS_MOUNT_ROOT` are not passed to the API child process or app overlay.

## Manual Checks

These are opt-in developer checks, not part of the default test path:

```bash
npm run check:botified-runner
npm run check:botified-runner-image
npm run e2e:operator-lifecycle
npm run visual:screenshot
```

`check:botified-runner` builds the Node output first, then runs a local Botified runner process from the pinned vendored binary with `--mock-provider`, posts a mock-provider command, observes bash output plus `file.published`, downloads the published artifact through the Botified file API, verifies marker/filename/bytes/sha256, and calls abort. It still expects the Rust binary at `third_party/botified/target/release/botified`. This is local runner process only; Kubernetes Pod/PVC, JuiceFS artifact flow, product task API, and cleanup require an external environment.

`check:botified-runner-image` builds the Node output, builds `agentsmith-lite/botified-runner:check` from `infra/docker/Dockerfile.botified-runner`, runs that runner container with the mock provider, and exercises `/healthz`, `/v1/messages`, `/v1/timeline`, Botified file download, `/v1/state`, and `/v1/abort` through a random loopback port. It requires Docker to pull the Dockerfile base images. When it succeeds, this is runner-container-only; it does not cover Kubernetes, PVC, JuiceFS, product task API, or cancel/reap.

The operator lifecycle e2e and visual screenshot are independent manual checks; they are not run by `npm test`. The screenshot is written to `out/visual/agentsmith-lite-dashboard.png`.

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
scripts/deploy/check-product-workflow.sh --env substrate.env --secrets substrate.secrets.env --app-env app.workflow.env
```

Use `scripts/build-images.sh --tag dev --push --images-lock dist/images.lock --dry-run` to print the build/push/write-lock intent without calling the container runtime. The digest-pinned lock is written only after a successful push, using the runtime-provided `RepoDigests`; a real registry digest is not available from the local image ID alone.

The app offline bundle is fixed to `manifest.yaml`, `images.lock`, `checksums.txt`, `images/app.tar`, and `images/botified-runner.tar`. `checksums.txt` is an exact allowlist for `manifest.yaml`, `images.lock`, `images/app.tar`, and `images/botified-runner.tar`; bundle consumers reject duplicate entries, path traversal, absolute paths, URL-like paths, and non-allowlist paths. `scripts/build-offline-bundle.sh --images-lock`, `scripts/deploy/render.sh --images-lock`, and `scripts/deploy/apply.sh --images-lock` all reuse the app lock semantics from `parseAppImagesLock()`: source locks may include comments, blank lines, and surrounding whitespace, while the bundle lock is normalized to the two digest refs for app and runner. `scripts/deploy/doctor.sh --bundle` validates the bundle files, checksum allowlist, bundle `images.lock`, and agreement with rendered manifests; when `--images-lock` is also provided, the explicit lock must match the bundle lock. This is only the app image bundle, not the substrates p1-real offline cache, and it does not replace substrate doctor or live Kubernetes/JuiceFS/disconnected deploy checks.

`scripts/deploy/check-product-workflow.sh` runs the remote product workflow check. It reads `APP_PUBLIC_BASE_URL` from the substrate env file unless `--base-url` is provided. Built-in mode bootstraps/logs in with `BUILTIN_ADMIN_INITIAL_PASSWORD`; OIDC mode uses an explicit existing session via `--cookie-file` and `--csrf-token` or `PRODUCT_WORKFLOW_COOKIE_FILE` and `PRODUCT_WORKFLOW_CSRF_TOKEN` from `--app-env`. The check covers health, auth, workspace/project creation, file upload/list/download/delete, and operator sandbox status. Endpoint/chat is opt-in with `--endpoint-base-url`, `--endpoint-model`, and `--endpoint-secret-ref`, or the matching `PRODUCT_WORKFLOW_ENDPOINT_BASE_URL`, `PRODUCT_WORKFLOW_ENDPOINT_MODEL`, and `PRODUCT_WORKFLOW_ENDPOINT_SECRET_REF` values from `--app-env`. Task artifact checking is explicit with `--check-task-artifact` or `PRODUCT_WORKFLOW_CHECK_TASK_ARTIFACT=true` in `--app-env`; task reclaim is explicit with `--check-task-reclaim` or `PRODUCT_WORKFLOW_CHECK_TASK_RECLAIM=true`, and `--check-task-reclaim-reap-apply` or `PRODUCT_WORKFLOW_CHECK_TASK_RECLAIM_REAP_APPLY=true` runs scoped dry-run, scoped apply, and final scoped dry-run for only the returned `runId`. `--check-k8s-run-resources` adds read-only Kubernetes observation scoped to returned run IDs. The command prints redacted JSON to stdout and exits non-zero on failure.

Operator sandbox status and cleanup use the product API and require an authenticated admin session cookie:

```bash
scripts/deploy/status.sh --env substrate.env --resources --cookie-file admin.cookie --csrf-token <csrf>
scripts/deploy/cleanup-stuck-tasks.sh --env substrate.env --dry-run --cookie-file admin.cookie --csrf-token <csrf>
scripts/deploy/cleanup-stuck-tasks.sh --env substrate.env --apply --cookie-file admin.cookie --csrf-token <csrf> [--run-id <run-id>]
scripts/deploy/down.sh --env substrate.env [--dry-run]
```

Pass `--base-url` or set `APP_PUBLIC_BASE_URL` in the substrate env file. Status, cleanup, and down only need substrate env, not app overlay. Cleanup defaults to dry-run unless `--apply` is passed; `--dry-run` and `--apply` cannot be combined. These scripts do not bootstrap or log in; status and cleanup only call `/api/operator/sandbox/status` and `/api/operator/sandbox/reap`.

App deploy renders product config into app-owned Kubernetes resources: substrate env provides the app-consumed public/namespace/PVC fields, `--app-env` provides non-secret app-owned runtime values such as `AGENTSMITH_LITE_MODEL_BASE_URL_*`, and substrate secrets provide `POSTGRES_APP_URL`, `APP_SESSION_SECRET`, and the active auth secret. OIDC public config renders into the app ConfigMap and `OIDC_CLIENT_SECRET` renders into the app Secret; builtin mode keeps generated empty OIDC metadata filtered before manifest rendering. Model API keys named `AGENTSMITH_LITE_MODEL_API_KEY_*` come from `--app-secrets`. S3 raw credentials and JuiceFS substrate secrets such as `JUICEFS_META_URL` stay with the substrate/CSI layer and must not be placed in app overlay.

Model endpoints store `apiKeySecretRef` values such as `secret/openai`; the server maps that to both `AGENTSMITH_LITE_MODEL_API_KEY_OPENAI` and `AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI` when handling chat. The endpoint base URL must be HTTPS and must match the server-configured base URL for that secret ref.
