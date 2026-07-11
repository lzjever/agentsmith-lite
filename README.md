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

`--env` and `--secrets` are the substrate contract. They export only the app-consumed substrate intersection, such as `APP_PUBLIC_BASE_URL`, Kubernetes namespace/context values, `JUICEFS_PVC_NAME`, OIDC issuer/client/backchannel values from `substrate.env` (`OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and optional `OIDC_BACKCHANNEL_BASE_URL`), and product core secrets from `substrate.secrets.env` (`POSTGRES_APP_URL`, `APP_SESSION_SECRET`, plus either `BUILTIN_ADMIN_INITIAL_PASSWORD` for `AUTH_MODE=builtin_admin` or `OIDC_CLIENT_SECRET` for `AUTH_MODE=oidc`). Built-in mode filters empty OIDC placeholders and fails closed on non-empty OIDC runtime keys. OIDC mode requires non-empty `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`; optional `OIDC_ADMIN_EMAILS` and `OIDC_ADMIN_SUBJECTS` come only from `--app-env`. Errors name keys without printing secret values. App-owned runtime/deploy overrides belong in `--app-env` (`OIDC_ADMIN_EMAILS`, `OIDC_ADMIN_SUBJECTS`, `BOTIFIED_RUNNER_IMAGE`, `AGENTSMITH_LITE_DATA_DIR`, sandbox mode/limit/tick settings, and `AGENTSMITH_LITE_MODEL_BASE_URL_*`); model API keys named `AGENTSMITH_LITE_MODEL_API_KEY_*` belong in `--app-secrets`. Raw substrate storage and CSI internals such as `S3_*`, `JUICEFS_META_URL`, `JUICEFS_BUCKET`, `JUICEFS_VOLUME_NAME`, `JUICEFS_SECRET_NAME`, `JUICEFS_CSI_DRIVER`, `JUICEFS_STORAGE_CLASS`, and `JUICEFS_MOUNT_ROOT` are not passed to the API child process or app overlay.

## Manual Browser Check

`npm run visual:screenshot` is an independently selected browser diagnostic, not part of `npm test`. The screenshot is written to `out/visual/agentsmith-lite-dashboard.png`.

## Deploy Skeleton

For the direct local development path after the k3s substrate install, build the renderer-default `:dev` images and import them into that installed k3s before rendering/applying with `--tag dev`:

```bash
scripts/build-images.sh --tag dev
scripts/deploy/import-dev-images.sh \
  --k3s-bin "$(command -v k3s)" \
  --kubectl-bin "$(command -v kubectl)" \
  --kubeconfig "$(awk -F= '$1 == "KUBECONFIG_PATH" { print $2 }' substrate.env)" \
  --kube-context "$(awk -F= '$1 == "KUBE_CONTEXT" { print $2 }' substrate.env)" \
  --namespace "$(awk -F= '$1 == "KUBE_NAMESPACE" { print $2 }' substrate.env)"
scripts/deploy/render.sh --env substrate.env --secrets substrate.secrets.env \
  --app-env app.env --app-secrets app.secrets.env --tag dev --out out/manifests
scripts/deploy/apply.sh --env substrate.env --out out/manifests
```

To execute a sandbox task, set `AGENTSMITH_LITE_SANDBOX_MODE=live` in `app.env` before rendering. `dry-run` is the intentional default and does not execute the task pod. This uses the existing `agentsmith-lite/app:dev` and `agentsmith-lite/botified-runner:dev` references, which the renderer uses with Kubernetes `IfNotPresent` behavior. The explicit substrate kubeconfig, context, and namespace scope the API deployment probe and restart. Each re-import restarts `deployment/agentsmith-lite-api` only when it already exists, so the first import can precede render/apply; the runner image is used by future sandbox Pods. It is local development only: it neither pushes to a registry nor creates or imports an offline digest bundle.

```bash
scripts/build-images.sh --tag dev --push --images-lock dist/images.lock
scripts/build-offline-bundle.sh \
  --images-lock dist/images.lock \
  --output dist/app-offline-bundle
# Installed k3s
scripts/deploy/import-images.sh --bundle dist/app-offline-bundle --k3s-bin "$(command -v k3s)"
# Offline substrate cache
scripts/deploy/import-images.sh --bundle dist/app-offline-bundle --k3s-bin dist/offline-cache/bin/k3s
scripts/deploy/render.sh --env substrate.env --secrets substrate.secrets.env \
  --app-env app.env --app-secrets app.secrets.env \
  --tag dev --out out/manifests --images-lock dist/app-offline-bundle/images.lock
scripts/deploy/apply.sh --env substrate.env --out out/manifests \
  --images-lock dist/app-offline-bundle/images.lock
```

Use `scripts/build-images.sh --tag dev --push --images-lock dist/images.lock --dry-run` to print the build/push/write-lock intent without calling the container runtime. The digest-pinned lock is written only after a successful push, using the runtime-provided `RepoDigests`; a real registry digest is not available from the local image ID alone. Building the offline bundle requires `skopeo` on the producer host; it uses Skopeo's normal registry authentication configuration.

The app offline bundle is fixed to `manifest.yaml`, `images.lock`, `checksums.txt`, `images/app.tar`, and `images/botified-runner.tar`. `checksums.txt` is an exact allowlist for `manifest.yaml`, `images.lock`, `images/app.tar`, and `images/botified-runner.tar`; bundle consumers reject duplicate entries, path traversal, absolute paths, URL-like paths, and non-allowlist paths. Each lock must name a single linux/amd64 OCI image manifest. Each archive must have exactly one `index.json` root descriptor with OCI image-manifest media type, matching digest, matching size, and matching blob hash; its config and layers are checked the same way. `scripts/build-offline-bundle.sh --images-lock`, `scripts/deploy/render.sh --images-lock`, `scripts/deploy/import-images.sh --bundle --k3s-bin "$(command -v k3s)"`, and `scripts/deploy/apply.sh --images-lock` reuse the app lock semantics from `parseAppImagesLock()`: source locks may include comments, blank lines, and surrounding whitespace, while the bundle lock is normalized to the two digest refs for app and runner. Import uses `ctr images import --base-name ... --digests`, binds the verified manifest with `ctr images tag --force`, and verifies the exact lock ref with `ctr images ls`; use `dist/offline-cache/bin/k3s` for the offline substrate cache workflow. This is only the app image bundle, not the substrates p1-real offline cache or a replacement for Kubernetes/JuiceFS install checks.

Operator sandbox reaping uses the product API and requires an authenticated admin session cookie:

```bash
scripts/deploy/status.sh --env substrate.env
node scripts/deploy/operator-sandbox.mjs status --base-url <url> --cookie-file admin.cookie
node scripts/deploy/operator-sandbox.mjs reap --base-url <url> --cookie-file admin.cookie --csrf-token <csrf> --dry-run
node scripts/deploy/operator-sandbox.mjs reap --base-url <url> --cookie-file admin.cookie --csrf-token <csrf> --apply [--run-id <run-id>]
scripts/deploy/down.sh --env substrate.env [--dry-run]
```

Pass `--base-url` or set `APP_PUBLIC_BASE_URL` in the substrate env file. Status and down only need substrate env, not app overlay. Reap defaults to dry-run unless `--apply` is passed; `--dry-run` and `--apply` cannot be combined. These commands do not bootstrap or log in.

App deploy renders product config into app-owned Kubernetes resources: substrate env provides the app-consumed public/namespace/PVC fields plus OIDC issuer/client/backchannel values, `--app-env` provides non-secret app-owned runtime values such as `AGENTSMITH_LITE_MODEL_BASE_URL_*` plus optional `OIDC_ADMIN_EMAILS` and `OIDC_ADMIN_SUBJECTS`, and substrate secrets provide `POSTGRES_APP_URL`, `APP_SESSION_SECRET`, and the active auth secret. OIDC env values render into the app ConfigMap from those sources and `OIDC_CLIENT_SECRET` renders into the app Secret; builtin mode keeps generated empty OIDC metadata filtered before manifest rendering and fails closed on non-empty OIDC runtime keys. Model API keys named `AGENTSMITH_LITE_MODEL_API_KEY_*` come from `--app-secrets`. S3 raw credentials and JuiceFS substrate secrets such as `JUICEFS_META_URL` stay with the substrate/CSI layer and must not be placed in app overlay.

Model endpoints store `apiKeySecretRef` values such as `secret/openai`; the server maps that to both `AGENTSMITH_LITE_MODEL_API_KEY_OPENAI` and `AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI` when handling chat. The endpoint base URL must be HTTPS and must match the server-configured base URL for that secret ref.
