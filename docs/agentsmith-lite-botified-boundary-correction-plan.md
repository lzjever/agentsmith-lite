# AgentSmith Lite / Botified Boundary Correction Plan

## 1. Purpose and stop point

This is a forward implementation plan for AgentSmith Lite. It is not a request
to reset history, revert whole commits, restore old files, or discard unrelated
work from the dirty tree.

The exact starting point is:

- product repository HEAD `9f1fff1`;
- an uncommitted two-Pod startup-generation change across 17 tracked files,
  plus untracked migration
  `infra/db/migrations/079_sandbox_startup_generation.sql`;
- a runner still built from `third_party/botified`, whose pin declares upstream
  `v0.4.37` plus AgentSmith-specific source changes;
- AgentSmith protocol code from `5c94227`, `8422d81`, and `9f1fff1` coupled to
  behavior that shipped historically in Botified `v0.4.41`;
- canonical docs split between the vendored `v0.4.37` fork, historical
  `v0.4.41` contracts, and the uncommitted false-to-true two-Pod design.

Botified `v0.4.41` is immutable historical material. It is not the target
runtime for this correction. AgentSmith must wait for the Botified team to
publish a corrective release that retracts the AgentSmith-driven additions.
Only after publication may AgentSmith select the exact corrective:

- version;
- Linux x86_64 asset name;
- SHA-256.

Those three values become one immutable runner input. Until they are known and
verified, packaging preparation may proceed but runtime activation must not.
AgentSmith does not request another Botified API change and does not build a
temporary compatibility facade.

## 2. Correct product boundary

### Task and Run

- **Task** is the durable user object and stable Botified session identity.
  Every Run for a Task renders the same `runtime.session=taskId`.
- **Run** is one allocation of compute. It owns one immutable runtime ConfigMap
  and one `restartPolicy: Never` Pod from `starting` to `active`, then
  `release_requested`, `failed`, or `released`.
- A Run never changes its runtime config, advances a startup generation, or
  replaces its Pod. If its Pod exits, disappears, or changes identity, that Run
  cannot activate or resume. It is failed/released; later work creates a new
  Run for the Task's same stable session identity.
- The selected corrective Botified release defines session-open behavior.
  AgentSmith renders only that release's documented config. It does not require
  `resume_unfinished`, process-open observations, deployment generations, or an
  open epoch.

### Ownership

AgentSmith owns:

- Task/Run product state and stable Task-to-session naming;
- Run reservation, one startup continuation owner, claim lease/recovery, and
  atomic activation;
- immutable Run config identity and exact app-owned Kubernetes resources;
- structured Pod readiness, real Pod UID/IP, UID-fenced deletion, and final
  identity reread;
- Release convergence, unknown startup-action recovery, cleanup claim release,
  usage settlement, and audit events;
- public stale-action fences such as `expectedRunId`;
- stale Web read/SSE guards;
- the AgentSmith `bash-executor` Terminal sidecar and exact-Run WebSocket
  admission.

Botified owns:

- session open/replay and all journal/checkpoint formats;
- ordinary message admission;
- current runtime state and no-body session-wide Abort;
- timeline and file APIs exposed by the selected corrective release;
- its own local model Bash implementation.

AgentSmith is a thin authenticated client of those published APIs. It does not
own Botified delivery authority, durable downstream control receipts,
background Stop, session compatibility, or internal process state.

## 3. Selected API behavior

The implementation must be derived from the corrective release source and
published artifact, not copied from the `v0.4.41` contract.

### Messages

- Send an ordinary message using the corrective release's normal request and
  response.
- Remove AgentSmith delivery keys, request hashes, `CanonicalLegacy`,
  payload-digest checks, receipt replay/query, and local delivery authority.
- On an ambiguous transport result, return a retryable product error.
  Conversation convergence comes from the selected release's timeline/state;
  AgentSmith does not claim exactly-once admission beyond that release.

### Abort

The final AgentSmith public contract is:

```http
POST /api/v1/tasks/:taskId/turn/abort
Content-Type: application/json

{"expectedRunId":"<run-id>"}
```

- The body has exactly `expectedRunId`. It has no `turnId`.
- `Idempotency-Key` is neither required nor consumed for this route.
- Resolve and authorize the Task, then compare `expectedRunId` with its current
  Run solely as an AgentSmith stale UI fence.
- A missing/different current Run returns HTTP `409` with
  `code=task_run_target_conflict`.
- A matching Run whose state is not `active` returns HTTP `409` with
  `code=task_run_not_active`.
- A matching active Run receives one authenticated, no-body
  `POST /v1/abort`.
- Downstream success returns HTTP `200` with exactly:

```json
{"outcome":"completed","taskId":"<task-id>","runId":"<run-id>"}
```

- Unreachable Botified or an ambiguous response returns HTTP `503` with the
  normal retryable error envelope and
  `code=botified_abort_unavailable`.
- Do not persist a Botified command key, downstream target, pending Abort
  receipt, request result, or restart recovery record. Do not automatically
  replay an ambiguous Abort.
- Remove `turnId`, `result`, `keyDisposition`, `accepted_in_progress`, and
  rejected-command receipt variants from the Abort request/response path.
- After one call, the Web refreshes canonical state and timeline. The user may
  press Abort again if the Run still appears active; Botified's no-body
  session-wide Abort is itself idempotent.

### Background Stop

- Remove AgentSmith's background Stop API, public capability, UI action,
  downstream persistence, and Botified `/v1/tasks/stop` client method.
- Do not emulate Stop through Abort, Bash process control, timeline inference,
  or a compatibility route.
- Stop may return only in a later product change if a then-selected Botified
  release independently publishes and owns a formal capability. It is not part
  of this correction.

### Provider broker transport

The corrective Botified release has no `allow_insecure_http`. Use one
cross-repository TLS path:

- Service name remains `agentsmith-lite-api`;
- app namespace is the installed `KUBE_NAMESPACE`;
- broker DNS is
  `agentsmith-lite-api.${KUBE_NAMESPACE}.svc.cluster.local`;
- broker HTTPS port is `3443`;
- this is an additional listener and port on the existing AgentSmith API
  Deployment and Service, not a new service or deployment.

The local substrates installer signs a dedicated broker server certificate
during install. Its SAN contains only the fixed broker Service DNS for the
selected app namespace. It generates/reuses a local CA, validates the
certificate before output, and emits this app overlay contract:

```text
app.env:
  AGENTSMITH_LITE_BROKER_HOST
  AGENTSMITH_LITE_BROKER_PORT=3443

app.secrets.env:
  AGENTSMITH_LITE_BROKER_TLS_CERT_PEM_B64
  AGENTSMITH_LITE_BROKER_TLS_KEY_PEM_B64
  AGENTSMITH_LITE_BROKER_TLS_CA_PEM_B64
```

PEM values are base64 encoded so the env files remain one-record-per-line.
Reinstall reuses valid material for the same namespace/DNS and rotates it when
identity changes. The cloud path does not generate a CA: the administrator
provides certificate, key, and CA through the same three base64 variables and
the same host/port contract. Substrates validation rejects a missing value,
malformed base64/PEM, mismatched cert/key, untrusted chain, expired/not-yet-valid
certificate, or SAN that does not equal the derived Service DNS.

AgentSmith app deployment decodes the material into one app-owned Kubernetes
Secret. The API container mounts certificate and key and starts an independent
HTTPS listener on `3443`. That listener registers only the authenticated broker
route; it has no public product API, health, OIDC, Web, Terminal, or static
routes. The existing `agentsmith-lite-api` Service adds a named
`broker-https` port targeting `3443`; public Ingress does not expose it.

Each Run Pod projects only `ca.crt` from the app-owned Secret. It never mounts
the broker server certificate or private key. Botified `base_url` is
`https://agentsmith-lite-api.${KUBE_NAMESPACE}.svc.cluster.local:3443/...`.
At corrective-release selection, verify and record the one documented
standard CA-file mechanism supported by that binary. The intended mechanism is
`SSL_CERT_FILE=/etc/agentsmith-lite/broker-ca/ca.crt`; use it only after an
artifact-level HTTPS check proves the release honors it. If that release does
not support `SSL_CERT_FILE`, select its documented equivalent and update this
single value before activation. If it supports no standard/system CA-file
mechanism, release selection is blocked. Do not patch Botified, disable
verification, restore `allow_insecure_http`, or add a second runtime path.

The Run NetworkPolicy permits TCP egress to API pods only on `3443`, plus the
existing DNS rule. It removes Run-to-API port `3000` egress. Broker
authentication remains exact-Run scoped, and provider credentials remain only
inside AgentSmith.

## 4. Startup and Release invariants

### Single-Pod startup

Each Run has one immutable config identity:

- derive the identity from the exact serialized runtime config bytes;
- use a content-addressed immutable ConfigMap name scoped by `runId`;
- persist the expected ConfigMap name and content hash before Kubernetes apply;
- mount that exact ConfigMap in the Pod and make the startup command read only
  that mount path.

Kubernetes readiness is structured:

```ts
type PodReadiness =
  | { state: "ready" | "pending" | "failed"; podUid: string; podIp?: string }
  | "not_found"
  | "fence_mismatch";
```

Do not retain string `"ready"`, fabricated local/legacy UIDs, config generation,
startup phase, or runtime generation annotations.

The first observed real Pod UID is persisted against the Run. Every later
readiness poll and the final pre-activation reread must match it. If the Pod
disappears, a Pod with the same name but another UID is a replacement and is
never adopted for that Run. `restartPolicy: Never` prevents process restart
inside the selected Pod; controller reconciliation must also refuse Pod
recreation for a Run that already recorded a UID.

Activation requires:

1. the Task still points to the exact Run;
2. startup claim and fencing token still match;
3. ConfigMap name and actual data bytes still match the persisted content hash;
4. the exact recorded Pod UID is Ready and has a usable real Pod IP;
5. authenticated health and state calls to that exact Pod succeed;
6. state `session_id` matches the Task ID;
7. a final Pod and ConfigMap reread still matches before atomic activation.

Call the Pod IP directly for startup verification. Do not route startup proof
through a Service that could select another Pod. Success proves only that the
exact owned Pod serves the selected release for the expected session; it does
not claim a Botified process-open epoch.

### Startup owner and unknown actions

Retain the existing logic that is independent of two-Pod generation:

- one durable startup reservation and one process-local continuation per Run;
- startup claim token, lease expiry, takeover after expiry, and exact fencing;
- begin/complete/recover records around Kubernetes apply and readiness calls;
- hard deadlines and `AbortSignal` cancellation;
- unknown apply/readiness outcomes remain `starting` until exact reconciliation
  resolves ownership;
- release of a stale/expired startup claim so another coordinator can continue;
- Release cancellation of the process-local startup operation;
- no activation after Release advances the Run fence;
- atomic Run activation plus Terminal-start receipt completion where applicable.

Remove only generation-specific phase transitions, false/true config changes,
Pod deletion/replacement, and generation evidence.

### Release convergence

Retain and finish:

- public `expectedRunId` stale fence;
- durable `accepted_in_progress` Release reservation;
- process-local startup cancellation after the Release fence commits;
- exact app-owned resource enumeration and UID/label-fenced deletion;
- unknown deletion recovery and cleanup claim release;
- completion only after all exact Run resources are confirmed absent;
- one usage settlement, final `released` state, and stable completed response;
- no cleanup of resources not owned by the exact Run.

Release does not depend on Botified Abort/Stop success.

## 5. Simplified local cutover

AgentSmith Lite has not been released and all existing sessions are test data.
There is no production migration or compatibility requirement.

Perform one coordinated local cutover:

1. publish and verify the Botified corrective release;
2. select and record its version, asset, and SHA-256 in AgentSmith packaging;
3. stop local new-work admission;
4. unconditionally request Release for every existing unreleased Run and
   reconcile until its app-owned resources are absent;
5. stop the local AgentSmith deployment;
6. resolve the local migration-079 branch in Phase 0 and, when it was applied,
   reset/recreate the disposable local app database;
7. delete all local Botified test session data;
8. deploy the coordinated app, Web client, runner image, runtime config, and
   broker TLS configuration;
9. create a new Task/session and resume admission only after the focused local
   core path succeeds.

Do not migrate, dual-read, replay, preserve, or classify old test sessions. Do
not create a drain report, evidence bundle, compatibility ledger, cutover
certificate, or other ceremony.

## 6. Implementation phases

### Phase 0: Remove the uncommitted two-Pod branch

From the current dirty tree, preserve unrelated hunks and:

- remove startup generation/phase fields and store methods;
- remove false-to-true config transitions and Pod replacement;
- remove fabricated readiness identities;
- retain immutable config name/hash, first real Pod UID, optional Pod IP,
  structured readiness, final identity reread, and no-recreation guard;
- retain independent Release receipts, unknown-action recovery, startup claim
  release, and their focused tests.

Before deleting `infra/db/migrations/079_sandbox_startup_generation.sql`, query
the target local app database:

```sql
select id, checksum, applied_at
from agentsmith_migrations
where id = '079_sandbox_startup_generation';
```

- If no row exists, delete the untracked `079` file. No migration is needed.
- If a row exists, never edit the applied file. Because this project is
  unreleased and local app data is disposable, first Release all Runs and stop
  the app, then reset the local AgentSmith app database and rebuild it from the
  committed migration set after deleting `079`. This is the preferred path.
- Only if the specific database contains data that cannot be discarded may the
  team retain the applied `079` unchanged and add the next numbered forward
  migration to remove its generation/phase columns, constraints, and indexes.
  That exception does not introduce a production migration framework.

### Phase 1: Add broker TLS

Substrates repository:

- extend `scripts/lib/config.sh` to derive the fixed Service DNS, generate/reuse
  local broker TLS, and write the five `app.env`/`app.secrets.env` values in
  both self-hosted and existing-cloud modes;
- extend `schemas/substrates-config.v1.schema.json` for cloud-admin TLS inputs
  and validate the emitted app overlay directly in the shared config writer;
  do not place app-only TLS values in `substrate.env` or
  `substrate.secrets.env`;
- extend `config/substrates.self-hosted.example.yaml` only with inputs needed
  for deterministic local generation, and
  `config/substrates.existing-cloud.example.yaml` with the same-format
  administrator-provided TLS inputs;
- update `scripts/install-online.sh` and `scripts/install-offline.sh` through
  their shared config/install functions, without creating a second install
  path;
- add focused assertions to
  `scripts/test-self-hosted-rendered-env-contract.sh` and
  `scripts/test-config-kubeconfig-path-contract.sh`; add one existing-cloud
  contract case for externally supplied material;
- update `docs/env-schema.md` and `docs/existing-cloud.md` as the canonical
  operator contract.

AgentSmith repository:

- add broker TLS parsing to `packages/api-entry-node/src/runtimeConfig.ts` and
  listener ownership to `packages/api-entry-node/src/server.ts`/`main.ts`;
- update `packages/sandbox-controller/src/appManifestRenderer.ts` to render the
  TLS Secret, API mount, container port `3443`, and `broker-https` Service port;
- update `packages/sandbox-controller/src/manifestRenderer.ts` so each Run
  mounts only `ca.crt`, sets the verified CA-file environment variable, and
  permits broker egress only to API pods on TCP `3443`;
- update `packages/botified-runtime/src/config.ts` to render the HTTPS Service
  DNS base URL without `allow_insecure_http`;
- retain exact-Run broker authentication and provider-credential isolation;
- cover listener route isolation in
  `tests/api/botified-chat-broker.test.ts`, app Secret/port rendering in
  `tests/deploy/app-manifest-secrets.test.ts`, and Run CA/NetworkPolicy rendering
  in `tests/service/sandbox-renderer.test.ts`.

This phase must be complete before selecting the corrective runner for live
Runs.

### Phase 2: Select and package the corrective Botified release

After the release exists:

- pin exact version, Linux x86_64 asset, and SHA-256;
- change `infra/docker/Dockerfile.botified-runner` to install the verified
  published binary;
- continue building only AgentSmith's `packages/bash-executor`;
- delete `third_party/botified/**` and `PINNED_SOURCE.json`;
- remove `vendored_source` bundle metadata and vendored Cargo-layout tests;
- retain the runner image digest lock and offline image archive contract;
- keep `botified-runner-entrypoint.sh` as the launcher for official Botified and
  the AgentSmith Terminal sidecar.

There is no fallback runner and no activation of `v0.4.41`.

### Phase 3: Correct the AgentSmith protocol

After Phase 2 fixes the exact published wire contract, make one coherent
API/application/Web change:

- simplify Botified message types to the selected corrective release;
- implement the exact Abort route/body/status/error contract in Section 3;
- remove all Stop surfaces;
- remove delivery and downstream-control persistence;
- keep `expectedRunId` only where it prevents stale product actions;
- remove Web mutation recovery that exists solely for delivery/Abort/Stop
  downstream state;
- make the Web perform one Abort call, refresh state/timeline, and leave a new
  user click as the only retry.

Migration `078_exact_task_controls.sql` may already be applied and must not be
edited. Add the next forward migration to remove only its exact Abort/Stop
state:

- drop `task_idempotency_exact_control_pending_idx`;
- drop `task_idempotency_exact_control_envelope_check`;
- terminalize or delete pending `abort-turn` and `work-stop` test rows without
  downstream replay;
- drop `expected_run_id`, `interaction_id`, `downstream_command_key`, and
  `downstream_target_id` only after confirming no retained Terminal, Release,
  message, or unrelated idempotency path uses them.

Do not create a replacement command ledger.

### Phase 4: Finish the one-Pod lifecycle

- render one immutable ConfigMap and one Pod per Run;
- persist config identity and first real Pod UID;
- activate only after exact-Pod health/state and final identity reread;
- fail/release instead of recreating a missing Pod;
- preserve startup ownership/recovery and Release convergence;
- preserve direct AgentSmith API-to-Terminal-sidecar transport.

### Phase 5: Coordinate cutover and canonical docs

- execute the local cutover in Section 5;
- rewrite `docs/botified-runtime.md`, `docs/architecture.md`,
  `docs/api-contract.md`, and `docs/sandbox-controller.md` around the selected
  corrective release and one-Pod Run lifecycle;
- remove `v0.4.41` exact API assumptions and false-to-true startup material from
  `docs/async-state-consistency-product-improvement-plan.md`;
- delete that superseded process plan if no current product work remains.

## 7. Commit and file matrix

| Origin / area | Delete or change | Preserve |
| --- | --- | --- |
| Uncommitted 17-file startup diff and `079` | Generation, phases, false/true transition, Pod replacement, fabricated IDs; query `agentsmith_migrations` before deleting `079` | Config identity, real UID/IP readiness, no-recreation fence, startup/Release unknown-action recovery |
| `5c94227` | `CanonicalLegacy`, delivery receipt union, payload hash validation, `allow_insecure_http`, `v0.4.41` response assumptions | Generic HTTP error handling, timeline/state client behavior not tied to removed fields |
| `8422d81` | Durable Abort/Stop bindings, downstream command keys/targets, pending recovery, Stop API/UI, exact-turn Abort plumbing | `expectedRunId` stale fences, Release convergence, Terminal startup ownership, unrelated command outcome/UI monotonicity |
| `9f1fff1` | Legacy turn/delivery receipt preservation expectation added by its focused test | Existing non-legacy command convergence coverage |
| Migration `078` | Exact-control columns, constraint, partial index, pending test rows through a forward migration | All Terminal-start, Release, message, and unrelated idempotency records |
| `third_party/botified/**`, `PINNED_SOURCE.json` | Entire vendored Botified source and Lite delta | Nothing; Botified is a published external product |
| Runner Dockerfile/build/bundle metadata | Botified Cargo build and vendored-source metadata | AgentSmith `bash-executor`, runner digest lock, offline runner archive |
| Substrates config/install/env output | Add local signing and cloud-supplied broker cert/key/CA in one app overlay contract | Existing four-file env/secrets output, namespace derivation, online/offline shared path |
| API runtime config/server/app manifest | Add isolated HTTPS broker listener and existing Service port `3443`; never expose it through Ingress | Existing API Deployment/Service and exact-Run broker authorization |
| `packages/botified-runtime/src/config.ts` | `resume_unfinished`, `allow_insecure_http`, unsupported `v0.4.41` fields | Stable Task session, HTTPS broker URL, documented corrective-release config |
| Sandbox renderer/Kubernetes port/reconciler | Generation annotations, string readiness, Pod replacement/adoption after UID, broker egress to API port `3000` | Immutable config identity, real UID/IP, CA-only mount, API broker port `3443`, labels, UID fences, `restartPolicy: Never` |
| Startup store/task service | Generation phases and two-open transitions | Claim/lease, begin/complete/recover unknown action, claim release, atomic activation |
| Release service/store/reconciler | Nothing solely because Botified controls are removed | Accepted-to-completed convergence, exact deletion, absence proof, settlement |
| Web Task/Terminal state | Stop action and downstream-control recovery | stale read/SSE guards, `expectedRunId`, exact-Run Terminal intent disposal |
| `packages/bash-executor`, Terminal WebSocket and NetworkPolicy | Any Botified Terminal route assumption | AgentSmith-owned sidecar handshake and exact-Run authorization |

The three AgentSmith commits are shared-hunk commits, not whole-file rollback
units. Inspect each commit parent, commit, current `HEAD`, and current dirty hunk.
Never restore a whole file from an old commit. Later team work and unrelated
behavior in the same functions must survive.

## 8. Focused TDD acceptance

Write the smallest failing behavior test before each production change and run
only the selected checks serially.

### Boundary and packaging

- no selected runner version exists until a corrective release is published;
- wrong corrective asset SHA fails packaging immediately;
- runner build neither copies nor compiles `third_party/botified`;
- no config or client contains `allow_insecure_http`,
  `resume_unfinished`, `canonical_legacy`, or `/v1/tasks/stop`;
- `v0.4.41` appears only as historical/non-target context.

### Broker TLS

- self-hosted install derives
  `agentsmith-lite-api.${KUBE_NAMESPACE}.svc.cluster.local`, emits valid
  cert/key/CA material, and reuses it for an unchanged identity;
- existing-cloud accepts administrator material in the same output variables
  and rejects incomplete or mismatched input;
- Botified reaches the broker at its HTTPS Service DNS name;
- the mounted CA validates chain and hostname;
- an untrusted CA, wrong hostname, expired certificate, or plaintext URL fails;
- the API listener on `3443` serves only the broker route, the existing Service
  exposes it as `broker-https`, and public Ingress does not;
- the Run Pod mount contains only `ca.crt`, and NetworkPolicy permits API pod
  egress only on TCP `3443`, not `3000`;
- the selected corrective artifact honors the one recorded CA-file mechanism,
  expected to be `SSL_CERT_FILE`; otherwise selection is blocked;
- broker authentication still rejects a wrong Run/service credential;
- provider credentials remain only in AgentSmith.

### Startup and Release

- one Run renders one immutable ConfigMap and one `restartPolicy: Never` Pod;
- readiness returns only structured state with real UID and optional IP;
- first UID is persisted and a same-name replacement UID cannot activate;
- missing Pod is not recreated for the same Run;
- config data hash mismatch, session mismatch, or final identity mismatch cannot
  activate;
- unknown apply/readiness keeps the Run recoverable under its claim lease;
- an expired/stale claim is released and startup can continue once;
- Release during unknown startup fences activation and converges only after
  exact owned resources are absent;
- usage settles once and unrelated Kubernetes resources remain untouched.

### Messages, Abort, and Stop removal

- normal message send parses only the selected corrective release response;
- no delivery receipt authority or legacy replay record is persisted;
- Abort accepts exactly `{expectedRunId}` and neither requires nor consumes
  `Idempotency-Key`;
- stale `expectedRunId` returns `409 task_run_target_conflict` before any
  Botified call;
- a matching non-active Run returns `409 task_run_not_active` before any
  Botified call;
- valid Abort sends exactly one no-body request to the exact Run, never reads a
  turn ID, and returns exactly HTTP `200`
  `{outcome:"completed",taskId,runId}`;
- unreachable/ambiguous Botified returns HTTP `503`
  `botified_abort_unavailable` with `retryable=true`;
- AgentSmith restart does not replay an ambiguous Abort, and no Abort receipt,
  result, key disposition, or accepted-in-progress state is stored;
- Web refreshes state/timeline after the call and permits only a fresh
  user-initiated Abort retry;
- Stop route, capability, client method, UI action, and persistence are absent.

### Terminal and Web

- Terminal connects Web to AgentSmith API to the exact Run's sidecar without a
  Botified Terminal route;
- Run change, capability loss, Task change, or non-active lifecycle disposes
  old Terminal intent;
- older reads and command responses cannot regress the current Task/Run view.

### Local cutover

- admission is stopped before releasing existing Runs;
- all existing Run resources are absent before test session data is deleted;
- migration lookup uses
  `agentsmith_migrations.id='079_sandbox_startup_generation'`;
- absent `079` is deleted directly; applied disposable-local `079` causes an
  app DB reset/rebuild from committed migrations; an applied non-disposable
  database uses only a later forward migration and never edits `079`;
- app, client, runner, config, and TLS deploy as one coordinated version set;
- one fresh Task/session can send work, write/list/download an artifact, open
  Terminal, Release, and create a later fresh Run.

There is no fixed `v0.4.41` route, request/response, status-code, delivery,
exact-control, or session compatibility acceptance test.

## 9. Rollback boundaries

- Before corrective-runner activation, keep the current local environment
  stopped or on its existing coordinated image set; do not partially select the
  new client/config.
- After activation, rollback the app/client/runner/config/TLS set together.
  Never mix the corrected AgentSmith client with `v0.4.41`.
- After the forward migration removing `078` state, do not deploy code that
  requires those columns without a deliberate new forward migration.
- Never change image, config, Pod, or UID under an existing `runId`; release it
  and create a new Run.
- Release cleanup, exact ownership labels, and UID fences remain invariant.

## 10. Handoff

The correction is complete when:

- AgentSmith pins one published corrective Botified version/asset/SHA and does
  not select `v0.4.41`;
- no vendored Botified source, generation/phase, Pod replacement,
  `CanonicalLegacy`, delivery authority, exact-turn Abort, downstream control
  ledger, Stop surface, `resume_unfinished`, or `allow_insecure_http` remains;
- Abort is exact-Run-fenced in AgentSmith and bodyless downstream;
- substrates and cloud inputs emit one broker cert/key/CA overlay contract;
  the existing API Deployment/Service owns an isolated `3443` listener/port,
  Runs mount only its CA, and broker traffic uses the selected release's
  verified standard CA-file mechanism;
- startup persists immutable config identity and one real Pod UID, refuses
  replacement, and retains unknown-action/claim recovery;
- Release convergence, Kubernetes ownership, stale UI guards, and AgentSmith
  Terminal sidecar behavior remain intact;
- existing local Runs and test sessions were discarded through the simple
  coordinated cutover;
- canonical code, tests, packaging, and product docs describe one boundary.

No governance report, compatibility ledger, evidence bundle, proof wrapper,
generated handoff record, or default release gate is part of this work.
