# AgentSmith Lite / Botified Boundary Correction Plan

## 1. Purpose and stop point

This is the forward implementation plan for correcting the AgentSmith Lite and
Botified boundary. It is not a request to reset history, revert whole commits,
restore old files, or discard unrelated work from the dirty tree.

The starting point is:

- product repository HEAD `014096b`;
- an uncommitted single-Pod startup-identity and Release-convergence change
  across tracked files, plus untracked migration
  `infra/db/migrations/079_sandbox_startup_identity.sql`;
- a runner still built from `third_party/botified`, whose pin declares upstream
  `v0.4.37` plus AgentSmith-specific source changes;
- AgentSmith protocol code coupled to withdrawn Botified `v0.4.41` behavior;
- runtime config code that still renders unsupported fields and reuses one
  credential for two trust directions.

The fixed Botified runtime input is:

```text
version: v0.4.44
asset: botified-core-linux-x86_64-musl.tar.gz
sha256: 1fdd193eeaea911951d58a15b1b42a786c6962d7af70af01f96fb13af56bf8f0
```

Packaging verifies the asset SHA-256 before extraction and fails immediately
on mismatch. There is no runtime selection process, compatibility fallback,
vendored source build, or request for an AgentSmith-specific Botified change.

### Execution boundary

- Implement only in the `agentsmith-lite` repository.
- `.reference/**` is permanently read-only: do not write, run Git commands,
  build, test, install, or generate files there.
- Do not modify `agentsmith-lite-substrates` unless the user explicitly
  authorizes it for the current task.

## 2. Correct product boundary

### Task and Run

- **Task** is the durable user object and stable Botified session identity.
  Every Run for a Task renders `runtime.session` as that Task ID.
- **Run** is one allocation of compute. It owns one immutable runtime ConfigMap
  and one `restartPolicy: Never` Pod from `starting` to `active`, then
  `release_requested`, `failed`, or `released`.
- A Run never changes its runtime config, advances a startup generation, or
  replaces its Pod. If its Pod exits, disappears, or changes identity, the Run
  cannot activate or resume. Later work creates a new Run.
- Existing test sessions are disposable. After the runtime correction, use a
  fresh session rather than migration, dual-read, or compatibility replay.

### AgentSmith ownership

AgentSmith owns:

- Task and Run product state, authorization, and stable Task-to-session naming;
- Run reservation, one startup continuation owner, claim lease/recovery, and
  atomic activation;
- immutable Run config identity and exact app-owned Kubernetes resources;
- structured Pod readiness, real Pod UID/IP, UID-fenced deletion, and final
  identity reread;
- Release convergence, cleanup claim release, usage settlement, and product
  audit;
- public stale-action fences such as `expectedRunId`;
- the internal LLM broker, provider selection, provider credentials, quota
  reservation, usage settlement, and LLM audit;
- the AgentSmith Terminal sidecar and exact-Run WebSocket admission.

### Botified ownership

Botified owns:

- session open/replay and all journal/checkpoint formats;
- ordinary message admission;
- current runtime state and no-body session-wide Abort;
- timeline and file APIs published by `v0.4.44`;
- its local model Bash implementation.

AgentSmith is a thin authenticated client of those published APIs. It does not
own Botified delivery authority, durable downstream control receipts,
background Stop, session compatibility, or internal process state.

## 3. Fixed Botified v0.4.44 contract

### Runtime config

AgentSmith renders one OpenAI-compatible provider:

```yaml
version: 1

providers:
  - name: agentsmith
    api_compat: standard
    base_url: http://agentsmith-lite-api.${KUBE_NAMESPACE}.svc.cluster.local/api/internal/tasks/${TASK_ID}/runs/${RUN_ID}/v1
    use_env_proxy: false
    model: ${ENDPOINT_MODEL}
    api_key_env: AGENTSMITH_LLM_BROKER_KEY
    request_timeout_secs: 120
    priority: 100
    capabilities: [text, tool_calls]

tools:
  enabled: [bash]

service:
  host: 0.0.0.0
  port: 17777
  service_key_env: BOTIFIED_SERVICE_KEY
  max_queue_messages: 32
  max_queue_bytes: 33554432

runtime:
  cwd: /workspace/task/home
  data_dir: /workspace/task/.botified
  session: ${TASK_ID}

subagents:
  enabled: false

registry:
  enabled: false

task_presets:
  presets: {}
  start_on_boot: []

skills:
  default_discovery: true

context_files:
  enabled: true
```

The server generates `base_url`; neither the Web nor the user supplies it.
`TASK_ID` and `RUN_ID` are individually percent-encoded when inserted into the
URL. The current real broker route is:

```text
POST /api/internal/tasks/:taskId/runs/:runId/v1/chat/completions
```

Botified appends `chat/completions` to the configured `/v1` base. The exact
generated base is therefore:

```text
http://agentsmith-lite-api.${KUBE_NAMESPACE}.svc.cluster.local/api/internal/tasks/<encoded-taskId>/runs/<encoded-runId>/v1
```

`v0.4.44` accepts an absolute HTTP or HTTPS provider URL. HTTP is selected
explicitly by the `http://` scheme; there is no `allow_insecure_http` field.
`use_env_proxy` is always `false`, so Botified ignores ambient proxy variables.
Redirects remain disabled by Botified.

Do not render any of these withdrawn fields:

- `allow_insecure_http`;
- `resume_unfinished`;
- `bash_executor_addr`;
- delivery receipt or legacy-journal settings;
- exact Abort or background Stop settings.

### Messages

`POST /v1/messages` ordinary success is HTTP `200`. AgentSmith accepts exactly
these normal admission kinds:

- `input_accepted`;
- `input_queued`;
- `input_duplicate`.

The response also contains `input_id`, `message_id`, `timeline_cursor`, content
summary, `queue_length`, and `state`. Slash-command responses have a distinct
shape and are not AgentSmith control receipts.

Remove AgentSmith delivery keys, request hashes, `CanonicalLegacy`,
payload-digest checks, receipt replay/query, and local delivery authority.
After an ambiguous transport result, return a retryable product error and
converge from Botified timeline/state. Do not claim cross-service exactly-once
admission.

### Abort

The AgentSmith public contract remains:

```http
POST /api/v1/tasks/:taskId/turn/abort
Content-Type: application/json

{"expectedRunId":"<run-id>"}
```

- `expectedRunId` is only an AgentSmith stale-UI fence.
- A missing or different current Run returns
  `409 task_run_target_conflict`.
- A matching Run that is not active returns `409 task_run_not_active`.
- A matching active Run receives one authenticated, no-body
  `POST /v1/abort`.
- Downstream success is HTTP `200` `{ok,queue_length,state}`. AgentSmith maps it
  to its small product response.
- An unreachable or ambiguous downstream result returns retryable
  `503 botified_abort_unavailable`.
- AgentSmith stores no downstream command key, target, pending receipt, result,
  replay instruction, or exact-turn identity.
- The Web refreshes state and timeline after the call. A later user click is
  the only retry.

Botified has no `/v1/tasks/stop`. Remove AgentSmith's Stop route, capability,
client method, UI action, persistence, and tests. Do not emulate Stop through
Abort, Bash, or timeline inference.

### Bash and sessions

- Model Bash is Botified's local `bash -lc` implementation.
- The AgentSmith Terminal remains a separate sidecar and is not a Botified
  Terminal route.
- Configured credential environment variables must be filtered from Bash child
  processes.
- The corrected runtime starts with fresh test sessions. There is no migration
  or dual-read of sessions written by withdrawn AgentSmith-specific records.

## 4. LLM broker and credential boundary

### One direct transport path

The only provider path is:

```text
Botified in the Run Pod
  -> HTTP ClusterIP Service default port 80
  -> AgentSmith internal exact-Task/exact-Run broker route
  -> selected OpenAI-compatible provider
```

There is no provider-forwarder, loopback provider port, private CA, dedicated
broker listener, or second transport path.

The existing AgentSmith API server continues to own:

- `POST /api/internal/tasks/:taskId/runs/:runId/v1/chat/completions`;
- exact Task/Run authorization and active-Run validation;
- endpoint resolution and model enforcement;
- provider credential retrieval;
- quota reservation before upstream work;
- usage settlement from the provider response;
- reservation release or failure settlement when upstream work fails;
- user/project usage aggregation and administrator audit.

The broker is the only authority for provider credentials, quota, usage, and
LLM audit. Botified does not select a provider credential and the Run Pod never
receives an upstream provider key.

### Two independent bearer credentials

The Run has two separate credentials:

| Credential | Direction | Visible to |
| --- | --- | --- |
| `AGENTSMITH_LLM_BROKER_KEY` | Botified to AgentSmith internal broker | Botified provider client and AgentSmith broker verifier |
| `BOTIFIED_SERVICE_KEY` | AgentSmith to Botified service API | Botified service and AgentSmith Botified client |

They must be distinct for the same Run. Reuse the existing AgentSmith
per-Run secret handling and avoid a new token service or capability framework.
Do not add `APP_RUN_TOKEN_SECRET` or a three-capability HMAC design.

The Run Secret injects both values only into the Botified container:

- provider `api_key_env` references `AGENTSMITH_LLM_BROKER_KEY`;
- service `service_key_env` references `BOTIFIED_SERVICE_KEY`;
- the Terminal container receives neither;
- Botified's Bash child environment receives neither;
- the values are never written to ConfigMap, Task output, timeline, logs,
  audit detail, or browser responses.

The broker authenticates `AGENTSMITH_LLM_BROKER_KEY` against the exact
`:taskId/:runId` path before reading or forwarding the request. A key from
another Run, a released Run, or a Task/Run mismatch fails without contacting
the provider.

### HTTP limitation

Traffic between the Run Pod and AgentSmith API pods is plaintext HTTP. This is
a known limitation accepted for the current local/private Kubernetes target.
Protection comes from:

- a high-entropy exact-Run bearer credential;
- exact Task/Run authorization at the broker;
- a Run NetworkPolicy that permits only cluster DNS and API pods on TCP 3000;
- no upstream provider credential in the Run Pod;
- no public Ingress route to `/api/internal/**`.

This does not provide transport confidentiality against a compromised cluster
network, node, CNI, or privileged workload. If a future deployment requires
mTLS, treat it as a separate product requirement and replace this path in one
coordinated change. Do not add a dormant TLS path, fallback, private-CA
contract, or dual-mode configuration now.

### Kubernetes network boundary

The Run NetworkPolicy allows egress only to:

- cluster DNS on the required UDP/TCP DNS ports;
- pods labeled as the AgentSmith API component in the Run namespace on TCP
  `3000`, the API Pod target port behind Service port `80`.

It does not allow general internet egress, arbitrary namespace egress, ambient
proxy egress, or direct provider access. `use_env_proxy:false` reinforces the
same path at the Botified client.

The public Ingress must not match or forward `/api/internal/**`. The internal
route remains reachable only through the ClusterIP Service. Manifest tests
must inspect effective Ingress paths rather than infer isolation from route
naming.

## 5. Startup and Release invariants

### Single-Pod startup

Each Run has one immutable config identity:

- derive the identity from exact serialized runtime config bytes;
- use a content-addressed immutable ConfigMap name scoped by `runId`;
- persist the expected ConfigMap name and content hash before Kubernetes apply;
- mount that ConfigMap and read only that path at startup.

One Run renders one Pod containing:

- the published Botified `v0.4.44` binary;
- the AgentSmith Terminal sidecar.

Both containers share the intended JuiceFS workspace and remain process
isolated. There is no provider-forwarder container and no false-to-true Pod
transition.

Kubernetes readiness is structured:

```ts
type PodReadiness =
  | { state: "ready" | "pending" | "failed"; podUid: string; podIp?: string }
  | "not_found"
  | "fence_mismatch";
```

Do not retain string `"ready"`, fabricated UIDs, startup generations, startup
phases, runtime generations, or Pod replacement.

The first observed real Pod UID is persisted. Every later readiness poll and
the final pre-activation reread must match it. A missing Pod or same-name Pod
with another UID is never adopted or recreated for that Run.

Activation requires:

1. the Task still points to the exact Run;
2. startup claim and fencing token still match;
3. ConfigMap name and data bytes match the persisted hash;
4. the exact recorded Pod UID is Ready with a usable real Pod IP;
5. authenticated Botified health and state calls to that Pod succeed;
6. Botified state `session_id` matches the Task ID;
7. a final Pod and ConfigMap reread still matches;
8. atomic activation succeeds after all fences remain valid.

### Startup ownership

Retain the existing generation-independent behavior:

- one durable startup reservation and one process-local continuation per Run;
- startup claim token, lease expiry, takeover after expiry, and exact fencing;
- begin/complete/recover records around Kubernetes apply and readiness calls;
- bounded deadlines and cancellation;
- unknown apply/readiness outcomes remain `starting` until reconciliation;
- stale claim release so another coordinator can continue;
- Release cancellation of process-local startup;
- no activation after Release advances the Run fence.

Remove generation-specific phase transitions, false/true config changes, Pod
deletion/replacement, and generation-only tests.

### Release convergence

Retain and finish:

- public `expectedRunId` stale fence;
- durable `accepted_in_progress` Release reservation;
- startup cancellation after the Release fence commits;
- exact app-owned resource enumeration and UID/label-fenced deletion;
- unknown deletion recovery and cleanup claim release;
- completion only after all exact Run resources are absent;
- one sandbox-duration and usage settlement;
- final `released` state and stable completed response;
- no cleanup of resources outside the exact Run.

Release is unconditional after user confirmation and does not depend on
Botified Abort or Stop success.

## 6. Implementation phases

### Phase 0: Finish the single-Pod identity and Release work

Review the current dirty tree as one unfinished implementation, preserving
unrelated hunks and completing:

- immutable ConfigMap name and exact serialized config hash;
- first real Pod UID/IP persistence and structured readiness;
- final ConfigMap/Pod identity reread before activation;
- refusal to recreate or adopt a replacement Pod for the same Run;
- one startup owner, unknown-action recovery, and stale claim release;
- one Pod containing only Botified and Terminal, with direct AgentSmith
  API-to-Terminal transport;
- exact-Pod health/state verification and atomic activation;
- Release fencing, exact owned-resource deletion, absence convergence, and one
  usage settlement;
- migration `079_sandbox_startup_identity.sql` for only the ConfigMap and Pod
  identity columns and constraints.

Remove any remaining false-to-true config transition, Pod replacement,
fabricated readiness identity, startup generation/phase, or unsupported
`resume_unfinished` behavior encountered in this work. Do not delete migration
`079`; it is part of the single-Pod identity design. If it has already been
applied locally, do not edit it.

Implement and test this lifecycle once in Phase 0. Later phases consume it and
must not introduce a second startup, identity, recovery, or Release path.

### Phase 1: Pin the published Botified runtime

- pin exactly `v0.4.44`,
  `botified-core-linux-x86_64-musl.tar.gz`, and SHA-256
  `1fdd193eeaea911951d58a15b1b42a786c6962d7af70af01f96fb13af56bf8f0`;
- install the verified published binary in
  `infra/docker/Dockerfile.botified-runner`;
- delete `third_party/botified/**`, `PINNED_SOURCE.json`, vendored Cargo build
  logic, and vendored-source bundle metadata;
- retain the runner image digest lock and offline image archive;
- package only AgentSmith-owned Terminal support beside the release binary;
- keep one runner path with no older Botified fallback.

### Phase 2: Make the internal broker the only provider path

- keep the current internal broker route on API port `3000`;
- expose the ClusterIP Service on default HTTP port `80` with
  `targetPort: 3000`; omit the port from the generated URL;
- generate the provider base URL server-side with the exact namespace, encoded
  Task ID, and encoded Run ID;
- render `api_compat: standard`, the exact HTTP base URL,
  `api_key_env: AGENTSMITH_LLM_BROKER_KEY`, and
  `use_env_proxy: false`;
- remove unsupported Botified config fields;
- split the broker bearer and Botified service bearer;
- inject both only into Botified and filter both from Bash;
- keep endpoint credentials exclusively in the AgentSmith API;
- enforce exact active Task/Run broker authorization before body forwarding;
- keep quota reservation, usage settlement, and LLM audit in the central
  broker;
- restrict Run egress to DNS and API pods on TCP `3000`;
- ensure public Ingress cannot route `/api/internal/**`;
- delete any forwarder, loopback `3120`, `3443`, broker TLS, private-CA,
  extra listener, or extra capability work if found.

No substrates change belongs to this phase.

### Phase 3: Correct the AgentSmith protocol

Using the fixed `v0.4.44` wire contract:

- simplify message types to the three ordinary response kinds;
- remove delivery and legacy receipt persistence;
- implement one no-body downstream Abort with `expectedRunId` only at the
  AgentSmith boundary;
- remove every Stop surface;
- remove Web mutation recovery that exists only for withdrawn downstream
  receipts;
- keep timeline/state convergence and stale Web response guards.

Migration `078_exact_task_controls.sql` may already be applied and must not be
edited. Use one later forward migration only if required to remove exact
Abort/Stop columns or indexes from a non-disposable database. Disposable local
data should be reset instead. Do not create a replacement command ledger.

### Phase 4: Local cutover and canonical docs

- stop local new-work admission;
- Release existing Runs and reconcile until owned resources are absent;
- stop the local AgentSmith deployment;
- apply the single-Pod identity migration, resolve withdrawn exact-control
  schema through the smallest valid forward change, and delete old Botified
  test sessions;
- deploy the coordinated API, Web, runner, runtime config, secrets, and
  NetworkPolicy;
- create a fresh Task/session and exercise the focused core path;
- update canonical runtime, architecture, API, and sandbox docs to this one
  direct broker path;
- delete superseded forwarder/TLS/exact-control planning material rather than
  retaining historical alternatives.

There is no production session migration or dual-read requirement.

## 7. Change matrix

| Area | Remove or change | Preserve |
| --- | --- | --- |
| Uncommitted startup diff and `079` | Any remaining generation, phase, false/true transition, Pod replacement, fabricated ID, or `resume_unfinished` behavior | Config identity migration, real UID/IP readiness, no-recreation fence, startup and Release recovery |
| Botified protocol code | `CanonicalLegacy`, delivery receipts, exact Abort targets, Stop, unsupported runtime fields | Ordinary message, state, timeline, health, no-body Abort |
| Botified dependency | Vendored source, source compilation, old pin metadata | Fixed `v0.4.44` asset and SHA |
| Provider transport | Forwarder, `127.0.0.1:3120`, port `3443`, TLS listener, private CA, TLS scripts/secrets | Existing internal broker through Service port `80` to API Pod target port `3000` |
| Credentials | Shared broker/service key, three-capability scheme, `APP_RUN_TOKEN_SECRET` | Independent broker and Botified service bearer values |
| Runtime config | `allow_insecure_http`, `resume_unfinished`, `bash_executor_addr` | Task session, direct HTTP broker URL, `use_env_proxy:false`, local Bash |
| Broker | Any provider logic in Botified or Run Pod | Credential, quota reservation, usage settlement, audit, model enforcement |
| Run Pod | Provider-forwarder and its resources/mounts | Botified plus Terminal, JuiceFS workspace, disjoint processes |
| NetworkPolicy | General egress, direct provider egress, proxy egress, `3120`/`3443` design | DNS and exact API-pod TCP `3000` egress |
| Ingress | Any route that exposes `/api/internal/**` | Public product API and Web paths |
| Release | Nothing | Exact resource deletion, absence convergence, one settlement |
| Substrates | Nothing | Existing repository and emitted contract unchanged |

Shared-hunk commits are not whole-file rollback units. Inspect the parent,
commit, current HEAD, and dirty hunk. Preserve unrelated later work.

## 8. Focused TDD acceptance

Write the smallest failing behavior test before each production change. Run
only selected checks serially. The Startup and Release checks below belong to
Phase 0 and are not repeated by later phases.

### Published dependency

- runner input is exactly `v0.4.44`,
  `botified-core-linux-x86_64-musl.tar.gz`, and
  `1fdd193eeaea911951d58a15b1b42a786c6962d7af70af01f96fb13af56bf8f0`;
- wrong asset or SHA fails before extraction;
- runner neither copies nor compiles Botified source;
- no vendored Botified source or fallback runtime remains.

### Runtime and broker

- generated `base_url` is exactly
  `http://agentsmith-lite-api.<namespace>.svc.cluster.local/api/internal/tasks/<encoded-taskId>/runs/<encoded-runId>/v1`;
- the ClusterIP Service maps `port: 80` to API Pod `targetPort: 3000`;
- Botified calls the resulting
  `/api/internal/tasks/:taskId/runs/:runId/v1/chat/completions` route;
- generated config contains `use_env_proxy: false`,
  `api_key_env: AGENTSMITH_LLM_BROKER_KEY`, and
  `service_key_env: BOTIFIED_SERVICE_KEY`;
- generated config contains no withdrawn fields;
- broker and service credentials are distinct;
- wrong key, wrong Task, wrong Run, released Run, and mismatched Task/Run fail
  before provider invocation;
- provider key never appears in the Run Secret, ConfigMap, Pod environment,
  timeline, logs, audit detail, or response;
- Terminal and Bash receive neither AgentSmith/Botified bearer;
- quota is reserved before provider work and settled once from returned usage;
- failed upstream work releases or settles its reservation once;
- LLM usage and audit remain attributable to user, project, Task, and Run.

### Network boundary

- Run NetworkPolicy egress is only cluster DNS and labeled API pods on TCP
  `3000`;
- no general TCP `443`, arbitrary namespace, direct provider, or proxy egress
  remains;
- public Ingress paths do not expose `/api/internal/**`;
- no forwarder container/package, port `3120`, port `3443`, broker TLS Secret,
  private CA mount, TLS generation script, or TLS environment contract remains.

### Startup and Release

- one Run renders one immutable ConfigMap and one `restartPolicy: Never` Pod;
- the Pod has Botified and Terminal containers only;
- readiness returns structured state with real UID and optional IP;
- the first UID is persisted and a replacement UID cannot activate;
- a missing Pod is not recreated for the same Run;
- config hash, session, or final identity mismatch cannot activate;
- unknown startup operations remain recoverable under one claim lease;
- Release fences activation and completes only after exact resources are absent;
- sandbox runtime and usage settle once;
- unrelated Kubernetes resources remain untouched.

### Messages, Abort, and Stop

- ordinary messages accept
  `input_accepted|input_queued|input_duplicate`;
- no delivery receipt authority or legacy replay is persisted;
- stale `expectedRunId` fails before a Botified call;
- valid Abort sends exactly one no-body request;
- an ambiguous Abort is not replayed automatically;
- Stop route, client, UI, persistence, and capability are absent;
- local Bash and fresh-session behavior match `v0.4.44`.

### Focused local path

One fresh Task/session can:

1. start one Run Pod;
2. send a message through Botified;
3. reach the AgentSmith broker over the exact HTTP route;
4. consume quota and settle returned usage;
5. write, list, and download an artifact;
6. open the AgentSmith Terminal;
7. Abort current agent work;
8. Release the sandbox and settle runtime once;
9. create a later fresh Run without reusing withdrawn session data.

End-to-end and visual checks remain manually selected checks, not release
gates.

## 9. Cutover and rollback

AgentSmith Lite is unreleased and current sessions are test data. Perform one
local coordinated cutover:

1. stop new Run admission;
2. Release existing Runs and wait for exact owned-resource absence;
3. stop the app;
4. apply `079` single-Pod identity state and remove withdrawn `078`
   exact-control state through the smallest valid local schema change;
5. delete old Botified test session data;
6. deploy the API, Web, fixed runner, runtime config, credentials, and
   NetworkPolicy together;
7. create a fresh Task/session and run the focused local path.

Before activation, keep the old local set stopped rather than mixing versions.
After activation, roll back API, Web, runner, config, credentials, and policy
together. Never:

- mix the corrected client with `v0.4.41`;
- restore vendored Botified;
- restore the forwarder/TLS path;
- change image, config, Pod, or UID under an existing Run;
- reuse withdrawn test sessions.

Release ownership labels, UID fences, and cleanup convergence remain invariant
under rollback.

## 10. Handoff

The correction is complete when:

- AgentSmith pins the exact `v0.4.44` asset and SHA above;
- Botified is consumed only as a published release binary;
- one server-generated direct HTTP path connects Botified to the existing
  internal broker through Service port `80` to API Pod target port `3000`;
- `use_env_proxy:false` and NetworkPolicy prevent alternate provider paths;
- public Ingress does not expose the internal broker route;
- the central broker remains the only credential, quota, usage, and LLM audit
  authority;
- upstream provider credentials never enter the Run Pod;
- `AGENTSMITH_LLM_BROKER_KEY` and `BOTIFIED_SERVICE_KEY` are independent and
  confined to the Botified container and their AgentSmith verifiers;
- Terminal and Bash receive neither credential;
- no provider-forwarder, `3120`, `3443`, broker TLS/private CA,
  `APP_RUN_TOKEN_SECRET`, or three-capability design remains;
- no vendored Botified source, two-Pod generation, Pod replacement,
  `CanonicalLegacy`, delivery authority, exact-turn Abort, Stop,
  `resume_unfinished`, `bash_executor_addr`, or `allow_insecure_http` remains;
- one Run owns one immutable ConfigMap and one Pod with Botified and Terminal;
- Release convergence, Kubernetes ownership, stale Web guards, usage
  settlement, and Terminal behavior remain intact;
- a fresh local Task completes the focused path using the fixed release.

No governance report, compatibility ledger, evidence bundle, proof wrapper,
generated handoff record, or default release gate is part of this work.
