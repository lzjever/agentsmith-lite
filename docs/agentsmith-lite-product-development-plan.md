# AgentSmith Lite Product Development Plan

Status: team-reviewed handoff draft
Date: 2026-07-04
Owner: product + engineering handoff

## 1. Executive Decision

AgentSmith Lite is a clean, pre-GA simplification of the original
`agentsmith-project` system. The target is not a smaller release process around
the old architecture. The target is a smaller architecture.

Core product goal:

> A cloud agent platform that runs sandboxed agents in Kubernetes, uses one
> cloud filesystem provider, and gives operators simple resource lifecycle,
> quota, cleanup, and recovery controls.

Everything that does not serve this goal is suspect by default.

The product will be reduced to two repositories:

| Repo | Purpose | Owns | Does not own |
| --- | --- | --- | --- |
| `agentsmith-lite-substrates` | Self-hosted runtime substrate installer and offline bundle | Kubernetes bootstrap, required dependency services, JuiceFS CSI setup, generated `substrate.env`, offline artifact cache and restore scripts | AgentSmith product code, product migrations, app release gates, cloud resource creation |
| `agentsmith-lite` | Product, API, web UI, sandbox orchestration, Botified integration, app deployment | Node API, static Web UI API client, data model, project/endpoints/chat/tasks/files UI, sandbox controller, Botified runner image, app manifests and simple deploy scripts. P0 does not introduce Next.js unless a future phase explicitly needs it. | JVS versioned filesystem, AFSCP, ASBCP as separate control planes, LLMUP, release-kit governance matrix |

Hard decisions:

1. Keep sandbox capability.
2. Remove LLMUP completely.
3. Support only OpenAI Chat Completions-compatible model endpoints.
4. Remove Codex as the agent core.
5. Use Botified as the resident agent runtime inside sandbox workloads.
6. Remove JVS, file versioning, AFSCP repo/template/export/mount concepts.
7. Use JuiceFS CSI as the only file-system provider for cloud/private runtime.
8. Remove file-library local/remote mount and WebDAV features.
9. Remove engineering-governance overhead from the main development path:
   gates, rehearsal campaigns, release reports, evidence ledgers, and tests
   that only test the test/governance system.
10. Reduce required dependencies to the minimum viable cloud platform:
    Kubernetes, PostgreSQL, S3-compatible object storage, JuiceFS CSI, and app
    images. Redis, MongoDB, Keycloak, MinIO, and an in-cluster registry are
    optional implementation choices, not product requirements.
11. Product terminal / Kubernetes `pods/exec` is not P0. Shell execution happens
    through Botified `bash` inside sandbox pods, with task lifecycle and audit
    owned by the API.
12. Self-hosted Kubernetes uses `k3s` in P0. `kind` may remain a developer-only
    convenience later, but it is not the self-hosted substrate implementation.
13. All business capabilities are server-side. Web UI and any future TUI are
    presentation clients only. They call the product API and must not contain
    agent orchestration, model-provider calls, sandbox lifecycle logic,
    filesystem authorization, direct database writes, or Kubernetes operations.
14. P0 auth is built-in admin. OIDC is optional/deferred unless explicitly
    enabled after the server API and deployment smoke are stable.

Engineering principles:

- KISS: one supported way per capability.
- DRY: reuse reference code by copying modules, then deleting scope.
- YAGNI: no hidden compatibility layer for removed pre-GA behavior.
- Governance must not become the product's mainline.
- Governance/instrumentation is allowed only as an operator/developer
  dashboard, log, or diagnostic output. It must not become the feature-delivery
  path.
- Tests verify product behavior and critical safety boundaries; tests do not
  verify a separate test bureaucracy.
- Visual and e2e suites are manual diagnostic gates. They are not part of the
  default release gate.

Review method:

- product review checked that the Lite scope still expresses the user-facing
  cloud-agent-platform goal;
- engineering review checked deletion feasibility, persistence replacement, and
  Botified event projection;
- DevOps review checked substrate/app ownership, offline rebuild, JuiceFS CSI,
  sandbox RBAC, and resource recovery.

## 2. Reference Baseline

The reference repositories have been cloned under `.reference/`.

| Reference repo | Observed role | Lite decision |
| --- | --- | --- |
| `.reference/agentsmith` | Main Next.js/product/API monorepo. Contains UI, Node API, domain/application/ports, adapters, runner contract, Codex-based agent task runner, deployment templates, and heavy governance scripts. | Primary copy source for `agentsmith-lite`. Keep product UI/API shape; delete AFSCP/ASBCP/JVS/LLMUP/release-governance coupling. |
| `.reference/agentsmith-runner` | Separate TypeScript Codex runner runtime and release evidence repo. | Do not keep as a separate repo. Use only as historical reference for runner packaging boundaries. Replace runtime with Botified. |
| `.reference/agentsmith-fs-control-plane` | AFSCP Go storage control plane: volumes, namespaces, JVS repos, templates, exports, WebDAV, workload mounts. | Remove from product architecture. Do not carry its state model forward. |
| `.reference/jvs` | JuiceFS-backed versioned workspace CLI. | Remove. No save point/versioned filesystem in Lite P0. |
| `.reference/agentsmith-sandbox-control-plane` | ASBCP Go sandbox workload lifecycle service. | Keep sandbox product capability, but fold a minimal sandbox controller into `agentsmith-lite` instead of a third repo/control plane. |
| `.reference/agentsmith-release-kit` | Operator package, online/airgap release evidence, substrate packs, GA reports. | Use only for ideas around substrate env and offline packs. Do not copy the GA/rehearsal evidence system. |
| `.reference/llm-universal-proxy` | Rust LLM proxy and client launcher. | Remove from system. No LLMUP workload, config, image lock, model bridge, or proxy dependency. |
| `.reference/botified` | Rust resident HTTP agent service with TUI, OpenAI-compatible provider router, tools, files, timeline, registry, subagents. | New agent runtime baseline. Package into the Lite sandbox runner image and call via HTTP. |

Important original project facts:

- `agentsmith` already has a useful monorepo structure:
  `src/` for frontend and `packages/*` for API/domain/application/adapters.
- `packages/api-entry-node` already contains the product API, task
  orchestration, Kubernetes client dependency, file-library services, model
  endpoint handling, Keycloak integration, audit/usage, and project governance.
- The heavy complexity is concentrated in:
  AFSCP clients/mapping/storage readiness, ASBCP clients, JVS/file versioning,
  LLMUP, `scripts/governance`, release contract artifacts, unified deploy
  rehearsal, visual/backend-real campaign machinery, and workflow gates.
- `botified` already provides a cleaner runtime contract:
  `botified serve`, `/v1/state`, `/v1/messages`, `/v1/timeline`, `/v1/files`,
  `/v1/abort`, OpenAI-compatible providers, built-in `bash` and `view_image`,
  local skills, context files, subagents, and file-backed timeline/session
  state.

## 3. Repository Design And Required Deliverables

The new project set has exactly two product repositories. For private/offline
P0, Botified is consumed inside the main repo as vendored source from a pinned
commit. A pinned binary or digest-pinned image is an explicit exception that
must be approved for equivalent offline provenance; it is not an undecided third
path. Botified is not a third AgentSmith Lite operations repo.

### 3.1 `agentsmith-lite-substrates`

Purpose: create or validate the substrate that AgentSmith Lite needs, then
produce a normalized environment contract for the app repo.

Required source layout:

```text
agentsmith-lite-substrates/
  README.md
  DEVELOPMENT.md
  docs/
    operator-runbook.md
    offline-install.md
    existing-cloud.md
    env-schema.md
  config/
    substrates.self-hosted.example.yaml
    substrates.existing-cloud.example.yaml
  schemas/
    substrate.env.v1.schema.json
    substrate.secrets.env.v1.schema.json
    substrates-config.v1.schema.json
  scripts/
    download-online.sh
    install-online.sh
    install-offline.sh
    doctor.sh
    reset-dev.sh
    lib/
  manifests/
    namespace/
    postgres/
    minio/
    juicefs-csi/
    quotas/
    ingress-dev/
  out/                         # generated, gitignored
  dist/offline-cache/          # generated, gitignored except sample manifest
```

Required generated outputs:

| Output | Producer | Consumer | Required content |
| --- | --- | --- | --- |
| `out/substrate.env` | install/validate scripts | app deploy/dev scripts | non-secret endpoint names, namespace, PVC, StorageClass, ingress, registry settings |
| `out/substrate.secrets.env` | install/validate scripts or operator | substrate setup/doctor; app deploy/dev scripts consume product-secret subset only | PostgreSQL app URL, app session/auth secrets, bootstrap admin secret if used, and substrate-only S3/JuiceFS raw credentials |
| `out/kubeconfig` | self-hosted install | local operator scripts | kubeconfig for the created `k3s` cluster |
| `dist/offline-cache/manifest.yaml` | `download-online.sh` | `install-offline.sh` and `doctor.sh` | artifact list, checksums, image digests, versions |
| `dist/offline-cache/images/*.tar` | `download-online.sh` | `install-offline.sh` | OCI archives for substrate images only |
| `out/doctor-report.json` | `doctor.sh` | operator/developer | factual readiness result; not a release gate ledger |

Secret handling deliverables:

- `substrate.env` contains only non-secret configuration.
- `substrate.secrets.env` contains all credentials and must be written with
  `chmod 0600`.
- `schemas/substrate.env.v1.schema.json` validates non-secret config.
- `schemas/substrate.secrets.env.v1.schema.json` validates required secret
  keys without printing values.
- `scripts/validate-env.sh --env out/substrate.env --secrets
  out/substrate.secrets.env` is required.
- logs, status output, and doctor reports show only secret fingerprints, never
  raw secret values.
- App deploy may read `substrate.secrets.env`, but it renders only product
  secrets into app-owned K8s Secrets: `POSTGRES_APP_URL`,
  `APP_SESSION_SECRET`, `BUILTIN_ADMIN_INITIAL_PASSWORD`, and OIDC/admin
  secrets when enabled.
- S3 raw credentials and `JUICEFS_META_URL` are substrate/CSI inputs only. They
  must not be injected into web/API server containers, sandbox pods, Botified
  env, or app-owned Secrets.

Allowed copied sources:

- simple shell helper patterns from `.reference/agentsmith-release-kit`;
- minimal routability probe ideas from release-kit substrate packs;
- K8s template ideas from `.reference/agentsmith/infra/deploy/shared`;
- redaction helpers if they are small and do not pull in evidence/report
  machinery.

Forbidden copied sources:

- release evidence stores, GA report generation, rehearsal matrices, readiness
  verdict machinery;
- AFSCP, ASBCP, LLMUP, JVS manifests as installable services;
- `kind` as the self-hosted substrate path;
- app product code or product DB migrations.

### 3.2 `agentsmith-lite`

Purpose: own the product, API, web UI, sandbox controller, Botified runtime
integration, app images, and app deployment manifests.

Required source layout:

```text
agentsmith-lite/
  README.md
  DEVELOPMENT.md
  OPERATOR.md
  docs/
    architecture.md
    api-contract.md
    botified-runtime.md
    sandbox-controller.md
    storage-and-files.md
    migration-from-reference.md
  src/                         # static Web UI, API client only
  public/
  messages/
  packages/
    api-entry-node/
    application/
    domain/
    ports/
    contracts/
    adapters-postgres/
    sandbox-controller/
    botified-runtime/
    openai-compatible-client/
  third_party/
    botified/                  # P0 default vendored source, no product TUI logic
  infra/
    docker/
    k8s/
    deploy/
  scripts/
    dev/
    deploy/
    build-images.sh
    check-forbidden-surfaces.sh
  e2e/
    smoke/
```

Required generated outputs:

| Output | Producer | Consumer | Required content |
| --- | --- | --- | --- |
| app image | `scripts/build-images.sh` | K8s deploy | static Web UI + Node API, either combined or split images depending on first implementation |
| `botified-runner` image | `scripts/build-images.sh` | sandbox pods | Botified server binary, Lite wrapper, no product TUI entrypoint |
| `out/manifests/` | `scripts/deploy/render.sh` | `scripts/deploy/apply.sh` | namespace-scoped app manifests, RBAC, services, jobs, network policy |
| DB migration bundle | build/deploy scripts | `schema-bootstrap` job | product schema only; never JuiceFS metadata schema |
| OpenAPI/API contract snapshot | API build | Web/TUI clients and smoke tests | product server contract; no direct Botified or K8s dependency for UI clients |
| `out/smoke-report.json` | smoke script | developer/operator | product behavior smoke; not a release governance artifact |
| `dist/app-offline-bundle/manifest.yaml` | `scripts/build-offline-bundle.sh` | offline app deploy | app image list, checksums, image digests, schema bundle, deploy script versions |
| `dist/app-offline-bundle/images/*.tar` | `scripts/build-offline-bundle.sh` | offline app deploy | OCI archives for web/api/schema-bootstrap/botified-runner images |
| `dist/app-offline-bundle/images.lock` | `scripts/build-offline-bundle.sh` | deploy render/apply | immutable image references used in offline deploy |

Allowed copied sources:

- product UI components and route shell from `.reference/agentsmith/src`;
- domain/application/ports contracts from `.reference/agentsmith/packages`;
- Node API composition patterns from `.reference/agentsmith/packages/api-entry-node`;
- selected Docker/build patterns from `.reference/agentsmith/infra`;
- Botified source from `.reference/botified`, vendored from a pinned commit.
  Binary/image consumption requires an explicit exception with checksum/digest
  and offline provenance.

Forbidden copied sources:

- `.reference/agentsmith/packages/agent-task-runner` as runtime code;
- `.reference/agentsmith/packages/agent-runner-contract` as a release-contract
  subsystem;
- LLMUP, AFSCP, ASBCP, JVS clients/config/manifests as live dependencies;
- governance scripts, rehearsal reports, gate manifests, product readiness
  artifacts;
- Botified TUI as product logic. Botified may keep its own developer TUI in
  vendored source, but AgentSmith Lite must not route business behavior through
  it.

### 3.3 Server And UI Boundary

Business logic belongs to the server-side product:

| Capability | Owner | UI/TUI role |
| --- | --- | --- |
| auth/session/permissions | API/domain/application | render login/session state and send API requests |
| endpoint/model config | API | form UI only; no provider calls from client |
| chat | API | send message request and display stream/result |
| agent task creation/cancel/release | API + sandbox controller | show controls and status; no direct Botified calls |
| Botified orchestration | API + `botified-runtime` | no UI ownership |
| sandbox pod lifecycle | API + `sandbox-controller` | no Kubernetes calls |
| file authorization/path safety | API | file picker/browser only |
| resource quota/recycling | API reconciler | status/dashboard only |
| audit/usage | API | read-only views later; not a P0 blocker |

Hard UI/TUI rules:

- Web UI and TUI may call only AgentSmith Lite product APIs.
- They must not call OpenAI-compatible providers directly.
- They must not call Botified sandbox services directly.
- They must not create/delete/watch Kubernetes resources.
- They must not read/write PostgreSQL, object storage, or JuiceFS directly.
- They must not implement task state machines, cleanup logic, permission
  decisions, or artifact promotion.
- Generated API clients are allowed; duplicated business rules in UI are not.

Botified TUI decision:

- Botified's TUI is not part of AgentSmith Lite P0 runtime.
- `botified-runner` starts `botified serve` inside sandbox pods.
- If a future product TUI is needed, it is a separate client of AgentSmith Lite
  APIs, not a direct wrapper around Botified's agent loop.

### 3.4 Development Deliverable Inventory

The development team should track these deliverables as product artifacts, not
as governance theater.

| Deliverable | Repo | Path | Phase | Acceptance |
| --- | --- | --- | --- | --- |
| architecture decision record | app | `docs/architecture.md` | P0 | states two-repo boundary and removed systems |
| migration ledger | app | `docs/migration-from-reference.md` | P0 | every copied reference path is keep/modify/delete |
| product API contract | app | `docs/api-contract.md` and generated snapshot | P2 | UI/TUI clients use product API only |
| PostgreSQL schema | app | `infra/db/migrations/` or `scripts/db/migrations/` | P2 | idempotent migrations; no Mongo/Redis required |
| server auth bootstrap spec | app | `docs/auth-bootstrap.md` | P2 | built-in admin login works |
| file/storage contract | app | `docs/storage-and-files.md` | P2 | JuiceFS path layout and path safety rules documented |
| sandbox controller contract | app | `docs/sandbox-controller.md` | P3 | DB state, K8s labels/RBAC, reconciler documented |
| Botified runtime contract | app | `docs/botified-runtime.md` | P3 | config schema, event projection, file/artifact boundary documented |
| app images | app | `scripts/build-images.sh` | P4 | app and runner images build with immutable tags/digests |
| app offline bundle | app | `dist/app-offline-bundle/` | P4 | disconnected app deploy can import and apply |
| app deploy scripts | app | `scripts/deploy/` | P4 | render/apply/status/smoke/down/doctor work against env contract |
| substrate config schema | substrates | `schemas/substrates-config.v1.schema.json` | P1 | self-hosted and existing-cloud examples validate |
| env schemas | substrates | `schemas/substrate.env.v1.schema.json`, `schemas/substrate.secrets.env.v1.schema.json` | P1 | env/secrets validate and secrets are redacted |
| substrate installers | substrates | `scripts/install-*.sh` | P1 | online and offline paths both produce env contract |
| substrate offline cache | substrates | `dist/offline-cache/` | P1 | disconnected substrate rebuild works |
| substrate doctor | substrates | `scripts/doctor.sh` | P1 | validates K8s/Postgres/S3/JuiceFS/RWX only |
| operator runbooks | both | `OPERATOR.md`, `docs/operator-runbook.md` | P4 | one page covers normal install/deploy/status/cleanup |
| focused test/smoke suite | both | `tests/`, `e2e/smoke/`, `scripts/*smoke*` | each phase | verifies behavior or safety boundary only |

## 4. Target Product Scope

Keep:

- Workspace/project management.
- Members and permissions, simplified to product needs.
- Endpoint/model configuration, but only OpenAI-compatible.
- Chat using configured OpenAI-compatible endpoints.
- Agent tasks using sandboxed Botified runtime.
- Files as a live project/task filesystem backed by JuiceFS CSI.
- Project secrets needed by model endpoints and runtime env.
- Audit/usage records that product users actually inspect; full audit/usage UI
  is deferred and read-only when added.
- Admin setup and bootstrap needed for private deployment.

Remove:

- JVS save points, restore previews, restore runs, templates, repo lifecycle,
  and versioned filesystem concepts.
- AFSCP volume/namespace/repo/export/workload-mount APIs.
- File library WebDAV export and local/remote mount UX.
- LLMUP and universal proxy model translation.
- Anthropic/native-provider bridging unless it is exposed through an
  OpenAI-compatible endpoint by the operator.
- Codex CLI runner and Codex-specific built-in skills/runtime env.
- Separate runner release repo, runner contract artifact pipeline, image
  handoff reports, adoption locks.
- Release kit GA reports, rehearsal packs, product readiness reports, current
  gate manifests, evidence ledgers, and governance-run stores.
- Storybook/visual/rehearsal gates as required workflow. Keep Storybook only if
  the frontend team actively uses it as a component workbench.

P0 functional boundary:

| Area | P0 includes | P0 excludes |
| --- | --- | --- |
| Auth | built-in admin auth, secure session cookie, CSRF protection, optional OIDC schema placeholders | mandatory Keycloak, multi-IdP directory sync, external invite flows |
| Workspace/project | CRUD, owner/admin role enforcement, minimal membership records only where needed by permissions | full members UI, groups/templates/governance approval workflows |
| Model endpoints | OpenAI Chat Completions-compatible `base_url`, model, API key secret, timeout, basic capability flags | LLMUP, provider translation, pricing catalog automation, first-party subscription/entitlement |
| Chat | server-side OpenAI-compatible request, persisted messages, endpoint snapshot | client-side provider calls, multi-provider routing rules |
| Files | live JuiceFS project file tree, upload/list/download/delete, path safety | JVS save/restore/versioning, WebDAV, local mount, remote mount, file sync daemon |
| Agent tasks | server-created sandbox pod, Botified HTTP orchestration, timeline projection, artifacts, cancel/timeout/cleanup | Codex runner, Botified TUI workflow, live Kubernetes exec terminal, subagents/team mode, warm pool |
| Resource management | per-task CPU/memory, project concurrency, namespace cap, reconciler, status views | custom scheduler, autoscaling policy engine, multi-replica HA task controller |
| Audit/usage | product-visible auth/task/file/endpoint/resource events as server records | P0-blocking audit/usage UI, evidence ledgers, release readiness reports, governance verdicts |

P0 page/component boundary:

- keep simple workspace/project list and settings;
- P0 UI must cover endpoint create/edit narrowed to OpenAI-compatible fields;
- keep chat page backed by the server API;
- keep files page/file browser after removing save/restore/version/mount/WebDAV
  actions;
- P0 UI must cover task create, cancel, detail, timeline, artifacts, and file
  browser access;
- remove or hide agent runner management pages unless they are rebuilt as
  Botified runtime settings served by the API;
- remove live terminal panels and any `xterm` dependency from active P0 UI;
- remove governance/release/readiness pages from active navigation;
- defer members, audit, and usage dashboards from P0 acceptance. When added,
  audit/usage are read-only views over product-visible server records.

## 5. Target Runtime Architecture

### 5.1 Services

`agentsmith-lite` runtime components:

| Component | Runtime | Notes |
| --- | --- | --- |
| `web` | static Web UI served by Node or a static server | Product UI API client. Can run locally for UI dev or as K8s Deployment. No business logic and no Next.js requirement in P0. |
| `api` | Node.js | Product API, auth, persistence, file operations, sandbox controller, Botified orchestration. |
| `botified-runner` | sandbox Pod image | Contains Botified binary plus Lite runtime wrapper/config generator. One pod per active task/session in P0. |
| `schema-bootstrap` | K8s Job or local script | Applies product DB schema/bootstrap only. |

Required substrate capabilities consumed through `substrate.env`:

- Kubernetes API / kubeconfig context.
- PostgreSQL with pgvector; use JSONB where the original system used MongoDB
  document collections. The self-hosted path should also use PostgreSQL as the
  JuiceFS metadata engine to avoid adding Redis.
- S3-compatible object storage; cloud object storage in managed environments,
  MinIO only for self-hosted/offline installs.
- JuiceFS CSI driver and a RWX StorageClass/PVC.
- Optional registry coordinates for offline image loading.

Ingress/TLS decision:

- P0 assumes the operator or cloud platform provides the external ingress/TLS
  endpoint named by `APP_PUBLIC_BASE_URL`.
- The substrate repo may install ingress-nginx and cert-manager only for
  self-hosted/dev convenience. They are not app requirements and must not appear
  in the app repo's required dependency list.

Optional later capabilities:

- OIDC provider integration. P0 may use a built-in admin/session model to avoid
  forcing Keycloak into every private install.
- Redis only if measured runtime requirements need shared volatile state after
  API multi-replica support is introduced.

### 5.2 Data And State

| State | Storage |
| --- | --- |
| Product records, projects, endpoints, permissions, audit | PostgreSQL tables plus JSONB documents |
| Relational schema/bootstrap needs | PostgreSQL migrations |
| Presence, queues, short-lived tickets, rate counters | PostgreSQL first; Redis only after a measured need |
| File contents and task workspaces | JuiceFS CSI PVC |
| Botified session/timeline/files for each task | Under JuiceFS task directory |
| Raw secrets | K8s Secret, env refs, or existing provider secret references; never committed to env examples |

Database separation:

- `POSTGRES_APP_URL` is used by AgentSmith Lite product data and migrations.
- `JUICEFS_META_URL` is used by JuiceFS metadata when self-hosted or
  when the cloud operator chooses PostgreSQL as JuiceFS metadata.
- The two URLs may point to different databases in the same cluster, but they
  must use separate database users and least-privilege grants.
- Migration/bootstrap scripts may create schemas/tables only through
  `POSTGRES_APP_URL`; they must never mutate JuiceFS metadata tables.

PostgreSQL replacement scope:

| Domain | Tables / shape | Required semantics |
| --- | --- | --- |
| users/auth | `users`, `auth_sessions`, optional `oidc_identities` | built-in admin user id is stable; password hash only; secure session cookie; CSRF protection for browser mutations |
| workspaces/projects | `workspaces`, `projects` | unique names per parent; owner id; soft delete if needed; transactional create/bootstrap |
| membership/permissions | `project_members`, `project_groups`, `project_permissions` or JSONB policy column for P0 | indexed by workspace/project/user; permission checks cannot depend on in-memory state |
| endpoints/models | `model_endpoints`, `endpoint_secrets` | only OpenAI-compatible protocol; secret value stored encrypted or as K8s Secret ref |
| chat | `chat_sessions`, `chat_messages`, `chat_attachments` | append-only message order; endpoint snapshot used for replay/debug |
| files | `project_file_records` optional metadata cache | source of truth is JuiceFS path; DB only tracks product metadata and recent UI cache |
| agent tasks | `agent_tasks`, `agent_task_events`, `agent_task_artifacts` | append task event stream from Botified projection; idempotent by Botified cursor/seq |
| sandbox | `sandbox_runs`, `sandbox_run_leases` | idempotent create/resume/delete; pod identity labels; expiry; cleanup status |
| audit/usage | `audit_events`, `usage_events` | product-visible facts only; no governance evidence reports |
| leases/cache | `runtime_leases`, `runtime_kv` | transaction-backed compare-and-set, TTL expiry, fencing token, cleanup job |

`packages/adapters-postgres` must provide two explicit ports:

- `PostgresJsonDocStore`: a compatibility bridge for copied business code while
  domains are moved to typed tables. It must use JSONB, typed collection names,
  indexes for every query pattern, and no unbounded scans.
- `PostgresLeaseStore`: replaces Redis `compareAndSet` for active task/run
  coordination. It must provide `acquire`, `renew`, `compareAndSet`,
  `release`, `expire`, and `listExpired` using transactions and fencing tokens.

Acceptance for dependency removal:

- API starts with no `MONGO_*`, `REDIS_*`, `KEYCLOAK_*`, `AFSCP_*`, `ASBCP_*`,
  `LLMUP_*`, or Codex env.
- Duplicate task submit, API restart, cancel, and sandbox cleanup still behave
  deterministically with only PostgreSQL and Kubernetes state.

P0 keeps API replicas at 1 unless the team explicitly implements shared active
run control. This avoids pretending that long-running task control is already
HA-safe.

### 5.3 Files

The product Files feature becomes a live filesystem browser/uploader/downloader
over one JuiceFS-backed project tree.

Recommended layout:

```text
/agentsmith-lite/
  workspaces/<workspace_id>/
    projects/<project_id>/
      files/
      tasks/<task_id>/
        home/
        botified/
        artifacts/
```

Rules:

- API and sandbox pods mount the same JuiceFS PVC.
- API file routes operate on normalized paths under the project root.
- No JVS control root.
- No save points.
- No WebDAV gateway.
- No local/remote user mount feature.
- No AFSCP repo mapping table. Keep only a small product record:
  workspace id, project id, root path, status, created/updated timestamps.
- Path traversal and symlink escape checks are product-critical tests.

### 5.4 Sandbox

Sandbox remains a first-class capability, but the control plane is collapsed.

P0 sandbox design:

1. API creates or resumes one sandbox pod per active task.
2. The pod mounts only the project subPath of the JuiceFS PVC, never the whole
   filesystem root.
3. The pod starts Botified on `0.0.0.0:<port>` inside the pod. API calls the
   sandbox Pod IP or a per-task Service using a generated service key; it must
   not assume `localhost` works across pods.
4. API stores the pod name, task id, Botified service key secret ref,
   task home path, phase, and expiry in product storage.
5. API sends task input to Botified `/v1/messages`.
6. API tails Botified `/v1/timeline` and projects events into the existing
   Agent task conversation/progress model.
7. API exposes cancel through Botified `/v1/abort` and deletes the pod on task
   release/expiry.

This preserves sandbox isolation without ASBCP:

- no AFSCP mount plan;
- no workspace mount binding state machine;
- no PV/PVC-per-binding lifecycle service;
- no separate ASBCP release contract.

Kubernetes responsibilities stay minimal:

- namespaced Role/RoleBinding for API to create/get/list/watch/delete pods,
  per-task Secrets, per-task ConfigMaps, and optional per-task Services;
- no `pods/exec` permission in P0;
- no cluster-wide persistent-volume manager in the app repo;
- PVC is provided by substrates and referenced by name.

Sandbox security contract:

- every sandbox pod has immutable labels:
  `agentsmith-lite/workspace-id`, `project-id`, `task-id`, `run-id`, and
  `managed-by=agentsmith-lite`;
- API may act only on pods/secrets/configmaps/services whose labels match the
  `sandbox_runs` DB record;
- runner pod service account has no product API privileges and
  `automountServiceAccountToken: false`;
- pod security context uses `runAsNonRoot`, `allowPrivilegeEscalation: false`,
  dropped Linux capabilities, `seccompProfile: RuntimeDefault`, no hostPath, no
  privileged mode, no hostNetwork;
- NetworkPolicy allows API -> sandbox Botified port and denies unrelated
  inbound access;
- sandbox egress is explicit: allow model endpoint/S3 only when required by the
  generated Botified config and substrate policy;
- S3/JuiceFS raw credentials are held by CSI/K8s Secret and are not projected
  into ordinary sandbox environment variables;
- Botified service key is a per-task Secret, redacted in logs, and cleaned with
  the sandbox run;
- API pre-creates canonical project/task directories and rejects symlink/path
  escape before mounting subPath or exposing product file operations.

Filesystem isolation:

- project root on PVC:
  `workspaces/<workspace_id>/projects/<project_id>`;
- sandbox mount:
  PVC `subPath` = that project root, mounted at `/workspace/project`;
- task home:
  `/workspace/project/tasks/<task_id>/home`;
- task artifacts:
  `/workspace/project/tasks/<task_id>/artifacts`;
- project files:
  `/workspace/project/files`;
- Botified `runtime.cwd` = task home;
- Botified `runtime.data_dir` = `/workspace/project/tasks/<task_id>/botified`.

### 5.5 Resource Lifecycle And Recycling

Resource management is a core product capability, not release governance.

P0 must provide:

- per-task pod CPU/memory request and limit;
- per-task idle timeout and max lifetime;
- explicit cancel/release;
- background reconciler that deletes expired pods;
- task state transitions for `queued`, `starting`, `running`, `stopping`,
  `completed`, `failed`, `expired`, and `cleaned`;
- project-level concurrent task limit;
- namespace-level safety cap for total active sandbox pods;
- cleanup command for stuck tasks;
- operator-visible status for active pods and reclaimed pods.
- `scripts/deploy/status.sh --env substrate.env --resources --cookie-file admin.cookie`
  showing active task count, sandbox pods, task runtime directories, PVC usage
  if available, and recent cleanup failures. Use `--base-url <url>` instead of
  relying on `APP_PUBLIC_BASE_URL` from the env file when needed; `--csrf-token`
  is optional for status.
- `scripts/deploy/cleanup-stuck-tasks.sh --env substrate.env --dry-run --cookie-file admin.cookie --csrf-token <csrf>`
  showing exactly which pods/secrets/configmaps/services/task runtime dirs would
  be cleaned.

P1/P2 can add:

- warm pod pool if startup time is too high;
- priority/preemption policy;
- per-project CPU/memory budget;
- file retention policy for old task directories;
- task archive/export if users need long-lived artifacts.

Do not add a separate scheduler or resource-control service unless the API
controller proves insufficient under real load.

Persistent reconciler contract:

- `sandbox_runs` is the source of desired state; Kubernetes is observed state.
- create is idempotent by `(workspace_id, project_id, task_id, run_id)`.
- each active run has a fencing token in PostgreSQL; stale API instances cannot
  overwrite a newer run state.
- API startup lists pods with `managed-by=agentsmith-lite`, joins them to
  `sandbox_runs`, adopts valid pods, and marks unknown pods for cleanup.
- Botified timeline cursor is stored after each projected event; on reconnect,
  API resumes from the stored cursor and falls back to `/v1/state` when Botified
  returns stale cursor.
- idle timeout is based on last accepted user input, Botified timeline activity,
  task callbacks, and explicit keepalive.
- cleanup removes resources in this order: stop/abort Botified, delete pod,
  delete per-task Service, delete ConfigMap, delete Secret, mark DB cleaned.
- cleanup failures are retried with backoff and shown in operator status.
- namespace `ResourceQuota` and `LimitRange` are installed by the app deploy
  manifests or validated as prerequisites.
- P0 cleanup may remove task runtime directories after a task is cleaned, but
  must not automatically delete project files or durable task artifacts unless a
  later explicit retention policy is configured.

### 5.6 Botified Integration

Botified replaces the Codex-based runner.

Botified contract used by API:

- `GET /healthz`
- `GET /v1/state`
- `POST /v1/messages`
- `GET /v1/timeline`
- `POST /v1/files`
- `GET /v1/files/{file_id}`
- `POST /v1/abort`

Generated Botified config per task:

- provider `base_url`, `model`, `api_key_env` from the selected AgentSmith Lite
  endpoint;
- `runtime.cwd` points to the task workspace directory;
- `runtime.data_dir` points to the task Botified state directory on JuiceFS;
- `tools.enabled` defaults to `[bash, view_image]` inside sandbox only;
- `service.host` binds inside the pod;
- `service.service_key_env` points to an injected secret;
- `context_files.enabled` may stay enabled for `AGENTS.md`-style project
  instructions;
- `skills.explicit` is populated from Lite-managed safe skills, not Codex
  system skills.

Lite P0 hardened Botified profile:

- `service.host: 0.0.0.0`;
- service key required;
- `registry.enabled: false`;
- `subagents.enabled: false` unless product explicitly enables team mode later;
- `llm_text_preview.enabled: false`;
- `profiling.enabled: false`;
- file size and total file store limits set from project policy;
- `tools.enabled: [bash, view_image]` only inside sandbox;
- non-sandbox/local API processes must not enable Botified `bash`;
- Botified source is vendored from a pinned commit for private/offline P0.
  A pinned binary or digest-pinned runner image is allowed only as an explicit
  exception with checksum/digest and offline provenance. No mutable tags.

Botified event projection:

| Botified timeline event | Lite projection |
| --- | --- |
| `input.accepted` / `input.rejected` | task user input status |
| `cycle.started/completed/failed` | task turn lifecycle |
| `assistant_message.completed` | assistant message |
| `provider_request.*` | trace/debug event, not user-facing by default |
| `command_execution.*` | tool execution event and terminal-like output summary |
| `background_task.*` / `task_reply.*` | task sub-event if enabled by Botified tool runtime |
| `file.published` | task artifact record |
| `service.error` / unknown `service.event` | typed runtime error or diagnostic trace |

Projection rules:

- store Botified `cursor`, `seq`, `session_id`, and raw event type with each
  projected task event;
- projection is idempotent by `(task_id, botified_seq)`;
- blank timeline heartbeat lines are ignored;
- `410 stale_cursor` triggers `/v1/state` bootstrap and resumes from returned
  cursor;
- raw timeline payloads are redacted before storing user-visible traces.

File and artifact boundary:

- Product Files are the JuiceFS project tree under `/workspace/project/files`.
- Botified `/v1/files` is only for message attachments and Botified internal
  published-file download. It is not the product file browser.
- Agent-created durable outputs should be written under
  `$TASK_ARTIFACTS_DIR` or promoted from Botified `file.published`.
- `file.published` creates/updates an `agent_task_artifacts` row and stores the
  bytes under `/workspace/project/tasks/<task_id>/artifacts`.
- Product UI may show task artifacts and project files in separate tabs; it
  must not imply Botified's file store is a mounted project library.

Remove Codex-specific elements:

- `@mbos/agent-task-runner` Codex command builder, output filter, Codex env,
  Codex skill packaging.
- `INTERNAL_AGENT_BUILTIN_SKILLS_DIR` and Codex skill assumptions.
- Codex CLI image/base image dependencies.
- Runner contract artifact flow built around Codex process assumptions.

Keep or rebuild as Lite concepts:

- task conversation projection;
- artifacts;
- process output from Botified timeline. A live Kubernetes exec terminal is
  deferred beyond P0 and must come with explicit RBAC, refcount, and teardown
  design if reintroduced;
- task cancellation;
- runtime status and event timeline.

### 5.7 Model Endpoints

Only OpenAI-compatible endpoints are supported.

Endpoint fields:

```text
name
base_url
model
api_key_secret_ref or encrypted project secret
capabilities: text | image | tool_calls
request_timeout_secs
optional thinking profile passthrough
```

Rules:

- No LLMUP workload.
- No provider translation bridge.
- No Anthropic SSE translation path.
- No first-party app subscription or CLI entitlement integration.
- If a provider can expose an OpenAI-compatible endpoint, it can be configured.
  Otherwise it is out of scope.
- API uses one OpenAI-compatible client for Chat.
- Botified uses the same endpoint record projected into its YAML config for
  Agent tasks.

## 6. Substrate Repo Plan

`agentsmith-lite-substrates` must be independently installable and must output a
single env contract that `agentsmith-lite` consumes: one non-secret env file plus
one secret env file.

### 6.1 Supported Operator Paths

| Path | Who owns infrastructure | Operator provides | Script does |
| --- | --- | --- | --- |
| `self-hosted` | Lite substrates repo | machine/VMs, storage disk, domain inputs | installs/rebuilds K8s and required dependency services, installs JuiceFS CSI, writes `substrate.env` and `substrate.secrets.env` |
| `existing-cloud` | cloud/provider/admin | same env schema with managed service endpoints and credentials | validates reachability and writes normalized `substrate.env` and `substrate.secrets.env` |

The app repo does not care which path produced the env contract.

### 6.2 One Env Schema

Recommended non-secret `substrate.env` keys:

```bash
SUBSTRATE_SCHEMA_VERSION=agentsmith-lite.substrate.env/v1

KUBECONFIG_PATH=/path/to/kubeconfig
KUBE_CONTEXT=agentsmith-lite
KUBE_NAMESPACE=agentsmith

S3_ENDPOINT=https://...
S3_REGION=...
S3_BUCKET=...
S3_FORCE_PATH_STYLE=true

AUTH_MODE=builtin_admin
OIDC_ISSUER_URL=
OIDC_CLIENT_ID=agentsmith-lite

JUICEFS_VOLUME_NAME=agentsmith-lite-files
JUICEFS_BUCKET=s3://agentsmith-lite-files
JUICEFS_SECRET_NAME=agentsmith-lite-juicefs
JUICEFS_CSI_DRIVER=csi.juicefs.com
JUICEFS_STORAGE_CLASS=agentsmith-lite-juicefs-rwx
JUICEFS_PVC_NAME=agentsmith-lite-files
JUICEFS_MOUNT_ROOT=/agentsmith-lite

APP_PUBLIC_BASE_URL=https://agentsmith.example.com
APP_INGRESS_CLASS=
APP_TLS_SECRET_NAME=
REGISTRY_URL=...
IMAGE_PULL_SECRET_NAME=...
```

Required secret `substrate.secrets.env` keys:

```bash
POSTGRES_APP_URL=postgresql://...
APP_SESSION_SECRET=...
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
JUICEFS_META_URL=postgresql://...
BUILTIN_ADMIN_INITIAL_PASSWORD=
OIDC_CLIENT_SECRET=
```

P0 requires split files. The app deploy script accepts `--env` and `--secrets`
and renders only the product-secret subset from the secret file. A single mixed
env file is not a supported P0 path. S3 raw credentials and `JUICEFS_META_URL`
belong to substrate/CSI setup and validation; app server, web server, sandbox
pods, and Botified runtime env must receive only product secrets and the
existing PVC/Secret names they reference.

Schema contract:

| Key | Required | Secret | Producer | Consumer | Notes |
| --- | --- | --- | --- | --- | --- |
| `SUBSTRATE_SCHEMA_VERSION` | yes | no | substrates/cloud admin | app deploy | must equal supported major version |
| `KUBECONFIG_PATH` | local scripts yes | no | substrates/cloud admin | scripts | may be omitted when running inside cluster with service account |
| `KUBE_CONTEXT` | local scripts yes | no | substrates/cloud admin | scripts | empty only for in-cluster deploy jobs |
| `KUBE_NAMESPACE` | yes | no | substrates/cloud admin | app deploy/API | app owns namespaced resources only |
| `POSTGRES_APP_URL` | yes | yes | substrates/cloud admin | schema/API | product DB; separate from JuiceFS metadata |
| `APP_SESSION_SECRET` | yes | yes | operator | app deploy/API | product session signing/encryption secret |
| `S3_ENDPOINT` | yes | no | substrates/cloud admin | JuiceFS setup/doctor | cloud or MinIO endpoint |
| `S3_REGION` | yes | no | substrates/cloud admin | JuiceFS setup/doctor | use `auto` only if provider supports it |
| `S3_BUCKET` | yes | no | substrates/cloud admin | JuiceFS setup/doctor | bucket must already exist in existing-cloud mode |
| `S3_ACCESS_KEY` | yes | yes | substrates/cloud admin | substrate/CSI setup/doctor only | may be a short-lived bootstrap credential; never inject into app or sandbox env |
| `S3_SECRET_KEY` | yes | yes | substrates/cloud admin | substrate/CSI setup/doctor only | never written to generated examples; never inject into app or sandbox env |
| `S3_FORCE_PATH_STYLE` | yes | no | substrates/cloud admin | JuiceFS setup/doctor | required for MinIO |
| `AUTH_MODE` | yes | no | operator | API | `builtin_admin` or `oidc` |
| `OIDC_ISSUER_URL` | if OIDC | no | operator | API | empty allowed only when `AUTH_MODE=builtin_admin` |
| `OIDC_CLIENT_ID` | if OIDC | no | operator | API | empty allowed only when `AUTH_MODE=builtin_admin` |
| `OIDC_CLIENT_SECRET` | if OIDC | yes | operator | API | empty allowed only when `AUTH_MODE=builtin_admin` |
| `BUILTIN_ADMIN_INITIAL_PASSWORD` | if builtin admin bootstrap | yes | substrates/operator | bootstrap/API | consumed once or rotated after first login |
| `JUICEFS_VOLUME_NAME` | yes | no | substrates/cloud admin | JuiceFS setup/app | logical volume name |
| `JUICEFS_META_URL` | yes | yes | substrates/cloud admin | substrate/CSI setup/doctor only | usually PostgreSQL metadata URL; never inject into app or sandbox env |
| `JUICEFS_BUCKET` | yes | no | substrates/cloud admin | JuiceFS setup/doctor | JuiceFS bucket URL, for example `s3://bucket/prefix` |
| `JUICEFS_SECRET_NAME` | yes | no | substrates | app deploy | K8s Secret containing CSI mount credentials |
| `JUICEFS_CSI_DRIVER` | yes | no | substrates/cloud admin | app deploy/doctor | expected `csi.juicefs.com` |
| `JUICEFS_STORAGE_CLASS` | yes | no | substrates | app deploy/doctor | RWX StorageClass provided by substrate |
| `JUICEFS_PVC_NAME` | yes | no | substrates | app deploy/API | app references this existing PVC |
| `JUICEFS_MOUNT_ROOT` | yes | no | substrates | API/runner | logical root prefix in the volume |
| `APP_PUBLIC_BASE_URL` | yes | no | operator | web/API | public URL used in callbacks and UI |
| `APP_INGRESS_CLASS` | no | no | operator | app deploy | blank means use cluster default or external ingress |
| `APP_TLS_SECRET_NAME` | no | no | operator | app deploy | blank means TLS terminated outside app ingress |
| `REGISTRY_URL` | no | no | substrates/operator | build/deploy | required only when image push/pull uses private registry |
| `IMAGE_PULL_SECRET_NAME` | no | no | substrates/operator | app deploy | required only for private registry pull |

`substrate.secrets.env` may hold only keys marked secret. `substrate.env` should
hold non-secret routing/config values. Existing-cloud operators can provide both
files directly without running the self-hosted installer.

Generated file rules:

- both env files include `SUBSTRATE_SCHEMA_VERSION`;
- `substrate.env` is safe to attach to support tickets;
- `substrate.secrets.env` is `chmod 0600`;
- generated examples contain placeholders only in `.example` files, never in
  runnable `out/` files;
- `doctor.sh`, `status.sh`, and failure logs redact every secret and show only
  stable fingerprints.

### 6.3 Operator Config Examples

The substrate repo should keep one human-authored config file format and render
the env schema from it.

Self-hosted example:

```yaml
mode: self-hosted
kubernetes:
  distribution: k3s
  namespace: agentsmith
  kubeconfigOutput: out/kubeconfig
postgres:
  storageClass: local-path
  appDatabase: agentsmith_lite
  juicefsDatabase: juicefs_meta
objectStorage:
  provider: minio
  bucket: agentsmith-lite-files
juicefs:
  volumeName: agentsmith-lite-files
  storageClass: agentsmith-lite-juicefs-rwx
  pvcName: agentsmith-lite-files
auth:
  mode: builtin_admin
ingress:
  publicBaseUrl: https://agentsmith.example.com
  installDevIngress: true
offline:
  registry: registry.local:5000
```

Existing-cloud example:

```yaml
mode: existing-cloud
kubernetes:
  namespace: agentsmith
  kubeconfigPath: /secure/path/kubeconfig
  context: production
postgres:
  appUrlFromEnv: POSTGRES_APP_URL
  juicefsMetaUrlFromEnv: JUICEFS_META_URL
objectStorage:
  endpoint: https://s3.us-east-1.amazonaws.com
  region: us-east-1
  bucket: agentsmith-lite-files
  accessKeyFromEnv: S3_ACCESS_KEY
  secretKeyFromEnv: S3_SECRET_KEY
juicefs:
  csiDriver: csi.juicefs.com
  storageClass: agentsmith-lite-juicefs-rwx
  pvcName: agentsmith-lite-files
auth:
  mode: oidc
  issuerUrl: https://idp.example.com/
  clientId: agentsmith-lite
ingress:
  publicBaseUrl: https://agentsmith.example.com
  ingressClass: ""
  tlsSecretName: ""
```

### 6.4 One-Click Script Requirements

The substrate repo must provide:

```bash
scripts/download-online.sh --output dist/offline-cache
scripts/install-online.sh --config config/substrates.yaml --output out/
scripts/install-offline.sh --cache dist/offline-cache --config config/substrates.yaml --output out/
scripts/validate-env.sh --env out/substrate.env --secrets out/substrate.secrets.env
scripts/doctor.sh --env out/substrate.env --secrets out/substrate.secrets.env
scripts/reset-dev.sh
```

`download-online.sh` must download all artifacts needed to rebuild offline:

- `k3s` binaries/images and required node artifacts.
- `kubectl`.
- Helm or Kustomize only if actually used.
- container images for dependency services.
- JuiceFS CSI manifests/images.
- PostgreSQL/pgvector image.
- MinIO image and client image, only for self-hosted/offline object storage.
- app namespace bootstrap manifests.
- checksums/manifest for every artifact.

`install-offline.sh` must not download from the public internet. It must:

- verify artifact checksums;
- load container images into the local registry/cluster;
- rebuild or reconnect K8s;
- install dependency services;
- initialize or validate the JuiceFS metadata database and object bucket;
- install JuiceFS CSI;
- create the StorageClass/PVC;
- initialize built-in admin bootstrap material or validate OIDC only when
  `AUTH_MODE=oidc`;
- write `substrate.env`;
- write `substrate.secrets.env` with mode `0600`;
- run `validate-env.sh`;
- run `doctor.sh`.

### 6.5 JuiceFS CSI Delivery Contract

Substrates owns JuiceFS CSI installation and validation. The app repo consumes
only the PVC name and mount paths.

Required behavior:

- install or validate the cluster-scoped JuiceFS CSI driver;
- create or validate `JUICEFS_SECRET_NAME` with metadata URL and object-storage
  credentials in the format required by the CSI driver;
- run idempotent `juicefs format` for `JUICEFS_VOLUME_NAME` against
  `JUICEFS_META_URL` and `JUICEFS_BUCKET`;
- create or validate an RWX `StorageClass` named `JUICEFS_STORAGE_CLASS`;
- create or validate an RWX PVC named `JUICEFS_PVC_NAME` in `KUBE_NAMESPACE`;
- verify reclaim policy and retention choice are explicit in the generated
  substrate output;
- create the logical `JUICEFS_MOUNT_ROOT` directory prefix and verify it is
  writable from Kubernetes;
- record the CSI driver version and image digests in the offline manifest.

Required manifest details:

- `JUICEFS_SECRET_NAME` must contain fixed data keys:
  `name`, `metaurl`, `storage`, `bucket`, `access-key`, `secret-key`, and
  optional provider-specific keys. Secret values are rendered from
  `substrate.secrets.env`.
- StorageClass must use `provisioner: csi.juicefs.com`, the generated secret
  name/namespace, explicit reclaim policy, and mount options chosen by the
  substrate installer.
- PVC must be in `KUBE_NAMESPACE`, use `ReadWriteMany`, reference
  `JUICEFS_STORAGE_CLASS`, and request an explicit capacity even if the backing
  store is elastic.
- `juicefs format` is idempotent only when existing volume name, metadata URL,
  bucket, and bucket prefix match. Mismatches fail with a clear adoption error;
  they must not silently reformat.
- Existing-cloud mode may validate a pre-existing CSI driver/StorageClass/PVC,
  but must not require app deploy to hold cluster-admin permissions.
- Bucket prefix should isolate the Lite volume, for example
  `s3://agentsmith-lite-files/agentsmith-lite/`.
- The substrate repo records supported Kubernetes and JuiceFS CSI versions in
  `docs/operator-runbook.md`.

App repo constraints:

- app manifests must not create PVs, install CSI drivers, or run `juicefs
  format`;
- API/sandbox pods reference the existing PVC and mount project `subPath`s;
- app deploy references `JUICEFS_SECRET_NAME` by name only and must not copy
  S3 raw credentials or `JUICEFS_META_URL` into app-owned Secrets or pod env;
- app deploy may fail fast if the PVC, StorageClass, or CSI driver validation
  fails.

### 6.6 Offline Cache Contract

`download-online.sh` writes a cache that is portable to a disconnected machine:

```text
dist/offline-cache/
  manifest.yaml
  checksums.txt
  bin/
    kubectl
    helm-or-kustomize-if-used
    k3s-artifacts
  images/
    images.lock
    oci/
      *.tar
  charts/
  manifests/
    juicefs-csi/
    namespace-bootstrap/
  scripts/
    import-images.sh
```

Rules:

- every image is digest-pinned in `images.lock`;
- every binary, chart, manifest, and image archive has a checksum;
- `install-offline.sh` imports OCI archives into the target cluster or configured
  local registry before applying manifests;
- app images are not silently downloaded by the substrate installer. Substrates
  may reserve registry coordinates, but `agentsmith-lite` owns app image build
  and push;
- `doctor.sh --offline-cache dist/offline-cache --env out/substrate.env` must be
  able to prove that no public registry or public download URL is required for
  substrate rebuild.

### 6.7 Doctor Checks

`agentsmith-lite-substrates/scripts/doctor.sh` should be boring, fast, and
directly useful. It validates the substrate only:

- kubeconfig/context can reach the cluster;
- namespace exists;
- PostgreSQL app DB connects, TLS policy is visible, and `pgvector` is
  available if enabled;
- JuiceFS metadata DB connects independently from the product DB;
- S3 bucket can read/write/delete a small object through the provided
  credentials;
- JuiceFS CSI driver, StorageClass, PVC, and Secret exist;
- a two-pod RWX smoke writes from one pod and reads from another using the PVC;
- offline cache manifest is complete when `--offline-cache` is supplied.

`agentsmith-lite/scripts/deploy/doctor.sh` or `smoke.sh` validates app delivery:

Default deploy smoke is lightweight and stays on the mainline:

- app, schema-bootstrap, and botified-runner images resolve to immutable digests
  or entries in `images.lock`;
- image pull works from the configured registry or imported offline bundle;
- schema-bootstrap job can run migrations against `POSTGRES_APP_URL`;
- web/API deployments become ready;
- app API health and schema endpoints respond through the configured ingress or
  port-forward path;
- sandbox service account RBAC can create/delete only the namespaced resources
  the app requires, verified with `kubectl auth can-i`.

Full acceptance smoke is an explicit/manual acceptance profile in product
terms, not the default deploy path. It is selected by supplying endpoint config
and enabling task smoke with `--task-smoke` or `SMOKE_TASK=true`. It covers
login, endpoint create, chat, one file operation, one sandbox task, task
timeline/artifacts, cancel/cleanup, status visibility, API sandbox create/clean
through RBAC, and Botified calls with the per-task service key.

### 6.8 Install Idempotency And Data Safety

Install scripts must be safe to rerun:

- default install is idempotent and preserves existing product data, JuiceFS
  metadata, object bucket contents, and PVC data;
- `--force` may repair/reapply manifests and regenerate non-secret config, but
  still preserves data;
- `--destroy-data` is the only flag allowed to delete Postgres databases,
  object-storage data, PVCs, or MinIO volumes;
- failed installs leave a resumable state and print the next command to run;
- uninstall for production removes app/substrate workloads only by default and
  leaves data behind;
- dev reset may delete data, but only when config mode is explicitly
  self-hosted/dev and `--destroy-data` is present.

### 6.9 What Not To Copy From Release Kit

Do not copy:

- GA aggregate reports;
- four-quadrant release verdicts;
- rehearsal evidence machinery;
- operator-inputs package matrix;
- source-boundary/gate bureaucracy;
- tests that only prove report formatting.

May copy/adapt:

- substrate env naming ideas;
- offline image bundle manifest ideas;
- simple routability checks;
- minimal K8s resource rendering helpers;
- redaction helper patterns.

## 7. App Repo Plan

### 7.1 Initial Copy Strategy

Create `agentsmith-lite` by copying reusable source from `.reference`, then
deleting and narrowing. The team should prefer file copying plus modification
over retyping large modules.

Recommended commit sequence:

1. `bootstrap-repo`: create the new empty repo, README, license, Node version,
   package manager lockfile policy, and tiny CI.
2. `copy-reference-product-shell`: copy product UI/API/domain source from
   `.reference/agentsmith`.
3. `delete-removed-surfaces`: remove governance, LLMUP, AFSCP, JVS, WebDAV,
   Codex runner, ASBCP external-service dependencies.
4. `add-lite-ports`: add `adapters-postgres`, `sandbox-controller`,
   `botified-runtime`, and `openai-compatible-client`.
5. `wire-first-smoke`: make auth/project/endpoint/chat/file/task smoke paths run
   through the new ports.
6. `package-k8s`: add images, manifests, deploy scripts, and smoke.

Initial copy commands, executed from the workspace that contains `.reference/`:

```bash
mkdir -p ../agentsmith-lite
cp -a .reference/agentsmith/src ../agentsmith-lite/
cp -a .reference/agentsmith/public ../agentsmith-lite/
cp -a .reference/agentsmith/messages ../agentsmith-lite/
cp -a .reference/agentsmith/packages ../agentsmith-lite/
cp -a .reference/agentsmith/assets ../agentsmith-lite/
cp -a .reference/agentsmith/components.json ../agentsmith-lite/
cp -a .reference/agentsmith/next.config.ts ../agentsmith-lite/
cp -a .reference/agentsmith/postcss.config.js ../agentsmith-lite/
cp -a .reference/agentsmith/eslint.config.mjs ../agentsmith-lite/
cp -a .reference/agentsmith/package.json ../agentsmith-lite/
cp -a .reference/agentsmith/package-lock.json ../agentsmith-lite/
cp -a .reference/agentsmith/tsconfig.json ../agentsmith-lite/ 2>/dev/null || true
cp -a .reference/agentsmith/infra/runner ../agentsmith-lite/infra/reference-runner
```

After the first copy, delete immediately:

```bash
rm -rf ../agentsmith-lite/packages/agent-task-runner
rm -rf ../agentsmith-lite/packages/agent-runner-contract
rm -rf ../agentsmith-lite/packages/adapters-cf
rm -rf ../agentsmith-lite/packages/api-entry-cf
rm -rf ../agentsmith-lite/src/lib/governance
rm -rf ../agentsmith-lite/scripts/governance
rm -rf ../agentsmith-lite/scripts/unified-deploy
rm -rf ../agentsmith-lite/scripts/post-deploy-product-smoke
rm -rf ../agentsmith-lite/release
rm -rf ../agentsmith-lite/artifacts/release-*
rm -rf ../agentsmith-lite/e2e/generated
rm -rf ../agentsmith-lite/e2e/stories
```

Then prune by search rather than memory:

```bash
rg -n "AFSCP|JVS|WebDAV|LLMUP|universal proxy|Codex|ASBCP|product:ready|gate:|release:campaign" ../agentsmith-lite
```

Every remaining match must be one of:

- reference migration documentation;
- an explicit negative test;
- a deletion note in the plan.

Botified P0 consumption is fixed for private/offline builds: vendor source from
`.reference/botified` at a pinned commit into `third_party/botified`. Pinned
binary or pinned image consumption is an explicit exception, not a pending
choice, and must document equivalent checksum/digest and offline provenance.

| Mode | Command shape | Use in P0 | Requirement |
| --- | --- | --- | --- |
| vendored source | `mkdir -p third_party && cp -a .reference/botified third_party/botified && rm -rf third_party/botified/.git` | default | pinned commit recorded in migration docs and lockfile |
| pinned binary | download binary by version/checksum in build script | exception only | approval note plus checksum and offline cache entry |
| pinned image | consume digest-pinned `botified-runner` base image | exception only | approval note plus digest, image lock, and offline import path |

If vendored, keep only runtime-relevant Botified pieces in the product build:

- keep `Cargo.toml`, `Cargo.lock`, `src/`, `docs/http-examples.md`,
  `docs/ops-manual.md`, and runtime tests for HTTP, files, provider, timeline,
  bash, and config;
- do not expose Botified's TUI as product runtime;
- remove or ignore `botified-playground`, `botified-claw-gateway`, visual TUI
  gates, and unrelated release smoke in the Lite build path;
- add a Lite wrapper that generates config and starts `botified serve`.

Substrate repo copy strategy:

```bash
mkdir -p ../agentsmith-lite-substrates/{scripts/lib,config,schemas,manifests,docs}
cp -a .reference/agentsmith-release-kit/substrate-packs/minimal/tools ../agentsmith-lite-substrates/reference-tools
cp -a .reference/agentsmith/infra/deploy/shared ../agentsmith-lite-substrates/reference-deploy-shared
```

Then copy only tiny helper functions into `scripts/lib/` and delete the
`reference-*` directories before the first real commit. The substrate repo must
not preserve release-kit evidence/report abstractions.

Package namespace rename:

- P0 may keep `@mbos/*` temporarily if it avoids blocking the first smoke.
- Before P5, rename public package names, env names, docs, and user-facing text
  to AgentSmith Lite terminology.
- Do not rename and rewrite architecture in the same commit.

### 7.2 Package Shape

Recommended P0 workspace. Keep the current `src/` static Web UI shape as an API
client; do not introduce `apps/web` or Next.js until a later phase explicitly
needs them.

```text
src/                              # current static Web UI shape
packages/api-entry-node/          # simplified product API
packages/application/
packages/domain/
packages/ports/
packages/adapters-postgres/
packages/contracts/
packages/sandbox-controller/     # K8s pod/service/secret lifecycle and reconciler
packages/botified-runtime/        # Lite wrapper/config projection around Botified
infra/
  deploy/
  docker/
  k8s/
scripts/
  dev/
  deploy/
  db/
```

Avoid adding a separate release-kit-like package.

P0 active package graph:

- `src/` UI calls AgentSmith Lite API/client contracts only.
- `api-entry-node` wires `application`, `domain`, `ports`, `contracts`,
  `adapters-postgres`, `sandbox-controller`, `botified-runtime`, and
  `openai-compatible-client`.
- `application` depends on `domain` and `ports`.
- `domain` depends on no adapters, Kubernetes client, HTTP provider client, or
  filesystem implementation.
- `ports` defines interfaces; it does not import concrete adapters.
- `contracts` contains shared product API types, not release evidence
  contracts.
- There is exactly one active implementation each for model calls, file access,
  sandbox lifecycle, leases, auth mode selection, and task event projection.
- Forbidden old packages are absent from package manager workspaces before P0
  acceptance.

### 7.3 Required Commands

Developer:

```bash
npm install
npm run dev:web
npm run dev:api
npm run dev
scripts/dev/up.sh --env ../agentsmith-lite-substrates/out/substrate.env --secrets ../agentsmith-lite-substrates/out/substrate.secrets.env
scripts/dev/down.sh
```

Build:

```bash
npm run build
scripts/build-images.sh --tag <tag>
scripts/build-offline-bundle.sh --tag <tag> --output dist/app-offline-bundle
```

Deploy:

```bash
scripts/deploy/render.sh --env substrate.env --tag <tag> --out out/manifests
scripts/deploy/render.sh --env substrate.env --secrets substrate.secrets.env --images-lock dist/app-offline-bundle/images.lock --out out/manifests
scripts/deploy/apply.sh --env substrate.env --tag <tag>
scripts/deploy/import-images.sh --bundle dist/app-offline-bundle
scripts/deploy/status.sh --env substrate.env
scripts/deploy/status.sh --env substrate.env --resources --cookie-file admin.cookie
scripts/deploy/status.sh --base-url https://agentsmith.example.com --resources --cookie-file admin.cookie --csrf-token <csrf>
scripts/deploy/smoke.sh --env substrate.env
scripts/deploy/smoke.sh --env substrate.env --secrets substrate.secrets.env --endpoint-base-url <url> --endpoint-model <model> --endpoint-secret-ref <secret-ref> --task-smoke
scripts/deploy/doctor.sh --env substrate.env --secrets substrate.secrets.env
scripts/deploy/down.sh --env substrate.env
```

Verification:

```bash
npm run typecheck
npm test
npm run e2e:smoke
```

No default `product:ready`, `gate:*`, `release:*`, or rehearsal commands.

Offline app bundle contract:

- `dist/app-offline-bundle/manifest.yaml` lists app version, schema version,
  build inputs, image archives, digests, and checksums;
- `dist/app-offline-bundle/images.lock` pins every deploy image by digest;
- `dist/app-offline-bundle/images/*.tar` contains OCI archives for app,
  schema-bootstrap, and botified-runner images;
- deploy scripts support `--images-lock` and reject mutable tags in offline
  mode;
- substrate offline cache and app offline bundle are separate artifacts.

Allowed app K8s resource kinds:

- `Deployment`
- `Service`
- `Job`
- `ConfigMap`
- `Secret`
- `ServiceAccount`
- `Role`
- `RoleBinding`
- `NetworkPolicy`
- `ResourceQuota`
- `LimitRange`
- `Ingress`

Every app resource must include standard `app.kubernetes.io/*` labels and
`agentsmith-lite/managed-by=agentsmith-lite`. `down.sh` deletes only app-owned
namespaced resources by default; it must not delete PVCs, PVs, object buckets,
databases, CSI drivers, or cluster-wide resources.

## 8. Deletion Map

Delete from copied `agentsmith`:

| Area | Delete |
| --- | --- |
| AFSCP | `afscp-client*`, `afscp-config*`, `file-library-afscp-storage*`, project AFSCP namespace/mapping/ownership stores, AFSCP deploy templates, AFSCP image locks |
| JVS | all JVS release/download/image smoke scripts, JVS docs/contracts, save point/version restore UI/API |
| WebDAV/export | export gateway config, WebDAV docs/routes/UX/capabilities |
| ASBCP separate service | ASBCP client and config as external service, ASBCP image locks, ASBCP deploy manifests; replace with in-repo sandbox controller |
| LLMUP | llmup deploy workload, `MBOS_UNIVERSAL_PROXY_*`, universal proxy service/tests/docs, image locks |
| Codex runner | Codex command builder, Codex env, Codex skill packaging, runner contract artifact flow |
| Governance overhead | `scripts/governance`, current gate/workflow manifests, product readiness report/status, release contract artifact, gate/lane/rehearsal scripts |
| CI | quality-gates, product-readiness-artifact, post-deploy-product-smoke, release-contract-artifact, runner-contract-artifact |
| Docs | readiness checklists, evidence directory models, release/governance runbooks, obsolete AFSCP/JVS/ASBCP/LLMUP docs |

Keep/adapt:

- auth and workspace/project records, backed by PostgreSQL;
- endpoint/model resource services after OpenAI-compatible narrowing;
- chat route handlers after provider simplification;
- agent task UI and task persistence after Botified event projection;
- file browser UI after removing save/restore/version/mount/WebDAV actions;
- audit/usage server records if product-visible; dashboards are deferred and
  read-only when added;
- Dockerfile app build patterns;
- simple K8s manifests for web/api/schema-bootstrap/sandbox RBAC.

### 8.1 Copy / Modify / Delete Ledger

Every copied reference surface must have an explicit decision before it enters
the active workspace.

| Reference path | Action | Destination | Required changes | Acceptance |
| --- | --- | --- | --- | --- |
| `.reference/agentsmith/src` | modify | `src/` | remove governance/release nav, terminal UI, file version/mount/WebDAV UI, provider-translation UI | UI builds and calls only AgentSmith Lite APIs |
| `.reference/agentsmith/src/components/agent-tasks` | modify | `src/components/agent-tasks` | keep timeline/status/artifacts; remove live terminal and Codex-specific panels | task UI shows Botified projection and no `xterm` runtime dependency |
| `.reference/agentsmith/src/components/files` | modify | `src/components/files` | keep live browser/upload/download/delete; remove JVS save/restore/mount/WebDAV/recovery UX | file smoke covers JuiceFS path operations |
| `.reference/agentsmith/src/components/agent-runners` | delete/defer | none or rebuilt settings page | remove managed runner/Codex concepts; rebuild later only for Botified runtime settings | no runner management route in P0 unless backed by API settings |
| `.reference/agentsmith/src/lib/governance` | delete | none | remove release/governance feature wiring | no active import |
| `.reference/agentsmith/packages/api-entry-node` | modify | `packages/api-entry-node` | remove AFSCP/ASBCP/LLMUP/Codex/terminal wiring; replace Mongo/Redis/Keycloak assumptions with Lite ports | API boots with Postgres/K8s/JuiceFS env only |
| `.reference/agentsmith/packages/application` | modify | `packages/application` | keep product use cases; remove governance/release/control-plane semantics | domain tests pass without removed ports |
| `.reference/agentsmith/packages/domain` | modify | `packages/domain` | keep core entities; delete JVS/AFSCP/runner-release concepts | no adapter imports |
| `.reference/agentsmith/packages/ports` | modify | `packages/ports` | define Postgres, file store, sandbox, Botified, OpenAI-compatible ports | all concrete implementations live outside ports |
| `.reference/agentsmith/packages/contracts` | modify | `packages/contracts` | keep product API contracts; delete runner/release evidence contracts | generated client contains product API only |
| `.reference/agentsmith/packages/adapters-private` | mine/delete | `packages/adapters-postgres` | copy only useful SQL/helper ideas; do not keep Mongo/Redis/Keycloak adapter package active | package manager has `adapters-postgres`, not `adapters-private` |
| `.reference/agentsmith/packages/agent-task-runner` | delete | none | replaced by Botified runner image/runtime wrapper | no active package or image built from Codex runner |
| `.reference/agentsmith/packages/agent-runner-contract` | delete | none or tiny types in `contracts` | remove release-contract subsystem | no runner contract artifact command |
| `.reference/agentsmith/packages/api-entry-cf` | delete | none | Cloudflare runtime path out of P0 | no active workspace package |
| `.reference/agentsmith/packages/adapters-cf` | delete | none | Cloudflare adapters out of P0 | no active workspace package |
| `.reference/agentsmith/infra/runner` | mine | `infra/docker` | reuse Docker patterns only; replace Codex base with Botified runner | image contains Botified server, not Codex CLI |
| `.reference/agentsmith/infra/deploy/unified` | mine/delete | `infra/k8s`, `scripts/deploy` | copy only namespace-scoped rendering ideas; no AFSCP/ASBCP/LLMUP templates | rendered manifests pass denylist |
| `.reference/agentsmith/scripts` | selective | `scripts/` | keep only dev/build/deploy helpers; remove gates/rehearsal/release/evidence scripts | README command list is short |
| `.reference/agentsmith/e2e` | selective | `e2e/smoke` | keep minimal product smoke patterns; delete story/gate/visual/release suites | one browser smoke and one deploy smoke |
| `.reference/botified/src` | adapt | `third_party/botified` or runner build context | run `botified serve`; harden config; no product logic through TUI | API can send/follow/abort through HTTP |
| `.reference/botified/src/*tui*` | delete/defer from product runtime | none | diagnostic only if explicitly added later | forbidden-surface check prevents product import |
| `.reference/botified/botified-playground` | delete/defer | none | not P0 runtime | not copied to active repo |
| `.reference/botified/botified-claw-gateway` | delete/defer | none | not P0 runtime | not copied to active repo |
| `.reference/botified/gates` | delete | none | no TUI visual gate | no gate command |
| `.reference/agentsmith-release-kit` | mine | `agentsmith-lite-substrates/scripts/lib` | copy only small checksum/redaction/offline ideas | no release evidence/report abstraction |
| `.reference/agentsmith-fs-control-plane` | do not copy | none | removed architecture | no AFSCP client/service/env |
| `.reference/agentsmith-sandbox-control-plane` | mine concepts only | `packages/sandbox-controller` | reuse lifecycle/RBAC/NetworkPolicy ideas, not service code/release machinery | sandbox controller is in app repo |
| `.reference/jvs` | do not copy | none | removed architecture | no save point/version CLI |
| `.reference/llm-universal-proxy` | do not copy | none | removed architecture | no LLMUP workload/env/client |

### 8.2 Path-Level Denylist

Do not copy these paths into active source:

- `.reference/agentsmith/artifacts/`
- `.reference/agentsmith/release/`
- `.reference/agentsmith/secrets/`
- `.reference/agentsmith/scripts/governance/`
- `.reference/agentsmith/scripts/unified-deploy/`
- `.reference/agentsmith/scripts/post-deploy-product-smoke/`
- `.reference/agentsmith/packages/agent-task-runner/`
- `.reference/agentsmith/packages/agent-runner-contract/`
- `.reference/agentsmith/packages/api-entry-cf/`
- `.reference/agentsmith/packages/adapters-cf/`
- `.reference/agentsmith/infra/deploy/unified/templates/app/afscp.yaml.tpl`
- `.reference/agentsmith/infra/deploy/unified/templates/local-kind-admin-preflight/asbcp-pv-rbac.yaml.tpl`
- `.reference/agentsmith/infra/deploy/shared/*afscp*`
- `.reference/agentsmith/infra/deploy/shared/*asbcp*`
- `.reference/agentsmith/infra/deploy/shared/*llmup*`
- `.reference/agentsmith/infra/deploy/shared/universal-proxy/`
- `.reference/agentsmith-release-kit/operator-inputs/`
- `.reference/agentsmith-release-kit/scripts/verify-*gate*`
- `.reference/agentsmith-release-kit/scripts/verify-*evidence*`
- `.reference/agentsmith-release-kit/scripts/test-*gate*`
- `.reference/agentsmith-sandbox-control-plane/docs/release-evidence/`
- `.reference/agentsmith-sandbox-control-plane/dangerous-system-tools/`
- `.reference/agentsmith-sandbox-control-plane/manager-service/internal/afscp/`
- `.reference/agentsmith-sandbox-control-plane/manager-service/internal/k8s/exec.go`

Allowed to inspect but not preserve as architecture:

- ASBCP workload RBAC, NetworkPolicy, ResourceQuota, lifecycle tests;
- release-kit checksum/offline bundle/redaction helpers;
- unified deploy rendering helpers after deleting removed workloads.

## 9. Development Phases

### P-1: Repo Skeleton, Persistence And Sandbox Spike

This is a short entry gate after minimum repo skeletons exist and before broad
code copying. It reduces the two highest technical risks without becoming a
governance program. The spike must not start by building orphan packages in a
scratch directory: create the two repo skeletons and their tiny test harnesses
first, then implement the spike packages inside those boundaries.

Deliverables:

- minimal `agentsmith-lite-substrates` skeleton with README, config/schema
  directories, `scripts/validate-env.sh`, `scripts/doctor.sh` stubs, and one
  test command/harness that can validate sample env files;
- minimal `agentsmith-lite` skeleton with package manager metadata,
  `packages/adapters-postgres`, `packages/sandbox-controller`,
  `packages/botified-runtime`, `tests/` or equivalent, and one test command;
- minimal PostgreSQL adapter proving JSONB document lookup, typed table
  migration, and transaction-backed lease/fencing token;
- minimal sandbox pod launched by API or script, mounting JuiceFS PVC subPath;
- Botified runs in the pod on `0.0.0.0`, accepts a message, emits timeline, and
  writes an artifact under the task directory;
- reconciler can delete the pod, service/configmap/secret, and mark DB state
  cleaned;
- one thin forbidden-surface check using `rg` to fail obvious reintroduction of
  `AFSCP`, `JVS`, `WebDAV`, `LLMUP`, and Codex runtime env in active source.

Acceptance:

- both repo skeletons run their minimal test harnesses before adapter/controller
  implementation begins;
- duplicate task/run creation is idempotent;
- API restart can adopt or clean the sandbox pod;
- the two-pod PVC smoke and Botified artifact smoke pass;
- the result fits in the proposed package boundaries:
  `adapters-postgres`, `sandbox-controller`, and `botified-runtime`.

### P0: Repo And Scope Bootstrap

Deliverables:

- Promote the P-1 skeletons into the `agentsmith-lite-substrates` and
  `agentsmith-lite` remote repos if they were started locally.
- Expand README, development guide, env examples, and minimal CI in each repo.
- Copy reference code into `agentsmith-lite`.
- Remove obvious release/governance/AFSCP/JVS/LLMUP/Codex surfaces from package
  scripts so the repo has a small command surface from day one.

Acceptance:

- `npm install`, `npm run typecheck`, and a small smoke test run.
- No `product:ready`, `gate:*`, `release:*`, LLMUP, JVS, AFSCP, or Codex command
  appears in the default README command path.
- The thin forbidden-surface check is present, understandable, and under 50
  lines of script/config.
- active package list is explicit in `package.json` workspaces;
- forbidden old packages are absent from package manager workspaces;
- app starts without `MONGO_*`, `REDIS_*`, `KEYCLOAK_*`, `AFSCP_*`, `ASBCP_*`,
  `LLMUP_*`, or Codex env vars.

### P1: Substrate Installer

Deliverables:

- Online installer for local/private self-hosted substrate.
- `config/substrates.yaml` examples for self-hosted and existing-cloud.
- Offline artifact downloader and offline installer.
- JuiceFS CSI StorageClass/PVC.
- `substrate.env` and `substrate.secrets.env` generation.
- `validate-env.sh` plus `schemas/substrate.env.v1.schema.json`,
  `schemas/substrate.secrets.env.v1.schema.json`, and
  `schemas/substrates-config.v1.schema.json`.
- substrate `doctor.sh` checks K8s, PostgreSQL, S3, JuiceFS, RWX PVC behavior,
  and offline-cache completeness when supplied.
- documented idempotency, `--force`, and `--destroy-data` behavior.

Acceptance:

- A clean machine can run online install and produce `substrate.env`.
- A disconnected machine can run offline install from the downloaded cache and
  produce the same env schema.
- `agentsmith-lite` can consume both self-hosted and cloud-provided env files.
- `doctor.sh --offline-cache` proves the substrate path does not need public
  downloads after cache creation.
- secret file is mode `0600`, and doctor/status output redacts secrets.
- app images are not part of the substrate cache unless explicitly imported
  from an `agentsmith-lite` app offline bundle.

### P2: Product API Without Removed Control Planes

Deliverables:

- Simplified API boots with PostgreSQL and the chosen auth mode.
- P0 auth mode is built-in admin. OIDC is optional/deferred unless explicitly
  enabled by a later phase.
- Endpoint/model config accepts only OpenAI-compatible endpoints.
- Chat works through direct OpenAI-compatible client.
- File routes operate directly on JuiceFS project paths.
- Removed AFSCP/JVS/WebDAV concepts no longer appear in product API.

Acceptance:

- Create workspace/project.
- Configure endpoint.
- Send chat message.
- Upload/list/download/delete file under project path.
- Path traversal and symlink escape tests pass.
- migrations are idempotent.
- built-in admin login works through the server API.
- UI/TUI clients contain no direct model-provider, database, JuiceFS, K8s, or
  Botified pod access.

### P3: Botified Sandbox Agent Tasks

Deliverables:

- Botified runner image.
- Botified source is vendored from a pinned commit; pinned binary/image use
  requires an approved exception with checksum/digest and offline provenance.
- Sandbox controller in API.
- Task create starts/resumes sandbox pod.
- API sends `/v1/messages` and tails `/v1/timeline`.
- UI shows task progress and final result.
- Cancel calls `/v1/abort`; release deletes pod or waits for TTL.
- Resource controller enforces per-task limits, idle/max-lifetime, project
  concurrency, and expired pod cleanup.

Acceptance:

- Start a task that writes a file through Botified `bash`.
- See timeline/progress in UI.
- Task artifact appears in the task artifacts view. Files appear in the project
  file browser only when written under the project `files/` tree.
- Cancel/timeout works.
- Expired pods are reclaimed by the reconciler.
- Project concurrency limit rejects or queues excess tasks.
- No Codex binary or Codex env is required.
- service key auth is required for every Botified API call.
- API restart resumes timeline projection from the stored cursor or rebuilds
  state from `/v1/state`.
- sandbox RBAC and NetworkPolicy are verified by smoke behavior, not by a
  governance report.

### P4: K8s App Packaging And Deploy

Deliverables:

- Web/API/schema-bootstrap manifests.
- Sandbox RBAC.
- PVC reference validation, but no PV/CSI installation.
- Ingress manifests that can either use operator-provided ingress/TLS or cluster
  defaults without forcing an ingress controller dependency.
- Render/apply/status/smoke/down scripts.
- Image build script for app and Botified runner.
- app offline bundle with image archives, `images.lock`, manifest, and
  checksums.

Acceptance:

- Deploy to self-hosted substrate cluster.
- Deploy to an existing cloud cluster using the same env schema.
- Existing-cloud deploy does not mutate provider-owned databases, buckets, CSI
  driver installs, or cluster-wide resources.
- Default smoke covers deploy readiness and app health. Full acceptance smoke
  covers login, endpoint config, chat, file op, one sandbox task,
  timeline/artifacts, and cancel/cleanup only when explicitly run.
- offline deploy can import the app offline bundle and render/apply with
  `--images-lock` without mutable tags.

### P5: Cleanup And Hardening

Deliverables:

- Remove remaining stale docs/routes/scripts/env names.
- Rename package namespace if desired.
- Focused security tests:
  path safety, secret redaction, sandbox pod namespace boundaries, OpenAI endpoint
  validation, Botified service key handling.
- Small operator runbook.

Acceptance:

- P5 is cleanup only. Critical safety tests land in the phase that introduces
  the feature, not here.
- `rg` for removed concepts returns only archived reference notes or explicit
  negative tests:
  `AFSCP`, `JVS`, `WebDAV`, `LLMUP`, `Codex`, `product:ready`, `gate:`,
  `release:campaign`.
- Default developer and operator paths fit on one README page each.

## 10. Minimal Test Policy

Keep:

- unit tests for pure product/domain logic;
- focused integration tests for API routes and adapters;
- one browser smoke for main workflows when explicitly run;
- one lightweight K8s smoke for deployment by default;
- security boundary tests for filesystem paths, secrets, sandbox namespace/RBAC,
  and endpoint validation.

Remove:

- tests of gate manifests;
- tests of workflow manifests;
- tests of evidence report schemas;
- rehearsal tests that do not exercise product/runtime behavior;
- release report aggregation tests;
- tests whose only purpose is proving another test command is wired.

Rule: every required test must answer one of these:

1. Does the product behavior work?
2. Is a critical runtime boundary safe?
3. Can the operator install/deploy the system?

If not, delete or make it an optional developer diagnostic.

Visual checks, full e2e runs, and full acceptance smoke beyond the lightweight
deploy smoke are opt-in/manual. The default developer and release path must not
require visual review, Storybook gates, endpoint-backed task smoke, or a full
e2e campaign.

## 11. Risks And Open Questions

| Risk/question | Proposed handling |
| --- | --- |
| Botified is powerful when `bash` is enabled. | Keep it only inside sandbox pods with restricted service account, resource limits, network policy, and JuiceFS path scope. |
| Botified service lifecycle per task may be slower than an in-process runner. | P0 accepts one pod per task for correctness. Optimize later with warm pool only if measured startup latency requires it. |
| API local dev cannot directly mount K8s PVC. | Full backend/files/sandbox dev should use local K8s dev mode. UI-only dev can run locally against mocks or a dev API. Avoid introducing a second filesystem implementation. |
| Existing AgentSmith file UI assumes save/restore/version actions. | Remove those actions first, then reconnect list/upload/download to live filesystem routes. |
| Self-hosted K8s with `k3s` still varies by host OS and network. | P1 installer supports one documented Linux target first, with `doctor.sh` explaining unsupported host assumptions. |
| Replacing Mongo/Redis with PostgreSQL increases first-cut backend work. | Accept this cost because dependency reduction is a product requirement, not cleanup. Copy service logic, not storage adapters. |
| Auth without Keycloak must not become insecure. | P0 built-in admin auth is acceptable for private installs only; OIDC can be optional for production teams that already have an identity provider. |

## 12. Handoff Checklist

Before implementation starts:

- [ ] Confirm final remote repo names.
- [ ] Confirm whether package namespace rename happens in P0 or after first
      functional smoke.
- [ ] Record the pinned Botified vendored-source commit, or approve an explicit
      exception for pinned binary/image with equivalent offline provenance.
- [ ] Confirm deployment domain/TLS assumptions for first private install.
- [ ] Confirm existing-cloud credential handoff format for PostgreSQL, S3, and
      JuiceFS CSI.

Definition of "ready for development team":

- repo boundary is two repos only;
- deletion map is explicit;
- Botified replaces Codex in the task runtime;
- sandbox remains in product scope;
- LLMUP is out;
- OpenAI-compatible is the only model-provider interface;
- required dependencies are minimized and documented;
- sandbox resource lifecycle/recycling is a product feature;
- both self-hosted and cloud deployments consume the same `substrate.env`;
- `substrate.env` is non-secret and `substrate.secrets.env` is mandatory;
- every copied reference surface has a keep/modify/delete decision;
- no client UI contains agent business logic or direct Botified pod access;
- no governance system is on the critical path of feature delivery.
