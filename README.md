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
scripts/dev/up.sh --env substrate.env --secrets substrate.secrets.env
```

Only allowlisted product API variables are exported to the dev server, such as `POSTGRES_APP_URL`, app session/admin secrets, `APP_PUBLIC_BASE_URL`, Kubernetes namespace/context values, `JUICEFS_PVC_NAME`, model base URLs/API keys, and sandbox mode/limit settings. Raw substrate storage and CSI internals such as `S3_*`, `JUICEFS_META_URL`, `JUICEFS_BUCKET`, `JUICEFS_VOLUME_NAME`, `JUICEFS_SECRET_NAME`, `JUICEFS_CSI_DRIVER`, `JUICEFS_STORAGE_CLASS`, and `JUICEFS_MOUNT_ROOT` are not passed to the API child process.

## Manual Checks

These are opt-in developer checks, not part of the default release path:

```bash
npm run e2e:smoke
npm run e2e:operator-lifecycle
npm run visual:screenshot
```

The operator lifecycle e2e and visual screenshot are independent manual gates; they are not run by `npm test` or the default release gate. The screenshot is written to `out/visual/agentsmith-lite-dashboard.png`.

## Deploy Skeleton

```bash
scripts/build-images.sh --tag dev --dry-run
scripts/build-offline-bundle.sh \
  --app-image agentsmith-lite/app@sha256:<64hex> \
  --runner-image agentsmith-lite/botified-runner@sha256:<64hex> \
  --output dist/app-offline-bundle
scripts/deploy/import-images.sh --bundle dist/app-offline-bundle
scripts/deploy/render.sh --env substrate.env --secrets substrate.secrets.env --tag dev --out out/manifests --images-lock dist/app-offline-bundle/images.lock
scripts/deploy/doctor.sh --env substrate.env --secrets substrate.secrets.env --out out/manifests --bundle dist/app-offline-bundle
scripts/deploy/smoke.sh --env substrate.env --secrets substrate.secrets.env
```

Deploy smoke is an API-only remote check. It reads `APP_PUBLIC_BASE_URL` from the env file unless `--base-url` is provided, bootstraps/logs in with `BUILTIN_ADMIN_INITIAL_PASSWORD` from the secrets file, then covers health, workspace/project creation, file upload/list/download/delete, and operator sandbox status. Endpoint/chat smoke is opt-in with `--endpoint-base-url`, `--endpoint-model`, and `--endpoint-secret-ref`, or the matching `SMOKE_ENDPOINT_BASE_URL`, `SMOKE_ENDPOINT_MODEL`, and `SMOKE_ENDPOINT_SECRET_REF` env values. Task artifact smoke stays off by default; enable the Botified `publish_file` artifact smoke explicitly with `--task-smoke` or `SMOKE_TASK=true`, and only with complete endpoint smoke config. On success it creates a task, polls `/events` and `/artifacts`, downloads the artifact, and verifies the marker content. It is still an opt-in acceptance check, not a default gate.

Operator sandbox status and dry-run cleanup use the product API and require an authenticated admin session cookie:

```bash
scripts/deploy/status.sh --env substrate.env --resources --cookie-file admin.cookie --csrf-token <csrf>
scripts/deploy/cleanup-stuck-tasks.sh --env substrate.env --dry-run --cookie-file admin.cookie --csrf-token <csrf>
```

Pass `--base-url` or set `APP_PUBLIC_BASE_URL` in the env file. These scripts do not bootstrap or log in; they only call `/api/operator/sandbox/status` and `/api/operator/sandbox/reap`.

App deploy renders product config into app-owned Kubernetes resources: non-secret model base URLs named `AGENTSMITH_LITE_MODEL_BASE_URL_*` go into the ConfigMap, while `POSTGRES_APP_URL`, `APP_SESSION_SECRET`, `BUILTIN_ADMIN_INITIAL_PASSWORD`, optional OIDC/admin secrets, and model API keys named `AGENTSMITH_LITE_MODEL_API_KEY_*` go into the Secret. S3 raw credentials and `JUICEFS_META_URL` stay with the substrate/CSI layer.

Model endpoints store `apiKeySecretRef` values such as `secret/openai`; the server maps that to both `AGENTSMITH_LITE_MODEL_API_KEY_OPENAI` and `AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI` when handling chat. The endpoint base URL must be HTTPS and must match the server-configured base URL for that secret ref.
