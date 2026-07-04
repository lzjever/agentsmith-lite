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
scripts/build-offline-bundle.sh --tag dev --output dist/app-offline-bundle
scripts/deploy/render.sh --env substrate.env --secrets substrate.secrets.env --tag dev --out out/manifests
scripts/deploy/doctor.sh --env substrate.env --secrets substrate.secrets.env
scripts/deploy/smoke.sh --base-url http://127.0.0.1:3000
```

App deploy renders only product secrets into app-owned Kubernetes Secrets: `POSTGRES_APP_URL`, `APP_SESSION_SECRET`, `BUILTIN_ADMIN_INITIAL_PASSWORD`, and optional OIDC/admin secrets. S3 raw credentials and `JUICEFS_META_URL` stay with the substrate/CSI layer.
