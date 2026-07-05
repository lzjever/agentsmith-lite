# AgentSmith Lite

AgentSmith Lite is a small product repo for the P0/P2/P3 app skeleton: Node API, minimal Web UI, shared contracts, Postgres ports, sandbox manifest rendering, and Botified runtime integration.

Business logic lives on the server side. The Web UI is a product API client only.

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

## Manual Checks

These are opt-in developer checks, not part of the default release path:

```bash
npm run e2e:smoke
npm run visual:screenshot
```

The screenshot is written to `out/visual/agentsmith-lite-dashboard.png`.

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
scripts/deploy/smoke.sh --base-url http://127.0.0.1:3000
```

App deploy renders product config into app-owned Kubernetes resources: non-secret model base URLs named `AGENTSMITH_LITE_MODEL_BASE_URL_*` go into the ConfigMap, while `POSTGRES_APP_URL`, `APP_SESSION_SECRET`, `BUILTIN_ADMIN_INITIAL_PASSWORD`, optional OIDC/admin secrets, and model API keys named `AGENTSMITH_LITE_MODEL_API_KEY_*` go into the Secret. S3 raw credentials and `JUICEFS_META_URL` stay with the substrate/CSI layer.

Model endpoints store `apiKeySecretRef` values such as `secret/openai`; the server maps that to both `AGENTSMITH_LITE_MODEL_API_KEY_OPENAI` and `AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI` when handling chat. The endpoint base URL must be HTTPS and must match the server-configured base URL for that secret ref.
