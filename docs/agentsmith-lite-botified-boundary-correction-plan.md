# AgentSmith Lite / Botified Boundary Baseline

This document defines the current product boundary between AgentSmith Lite and
the published Botified runtime. It is an implementation baseline for ongoing
development, not a migration plan.

## Product Boundary

AgentSmith owns:

- durable Task identity, authorization, membership, policy, quota, Usage, and
  Audit;
- Run admission, startup, exact Kubernetes ownership, explicit Release, and
  one-time settlement;
- the OpenAI-compatible LLM broker and all upstream provider credentials;
- the Web application, interaction projection, artifacts, and File Libraries;
- the interactive Terminal transport and Terminal executor.

Botified owns:

- the Task's agent session, journal, checkpoint, timeline, and runtime state;
- ordinary message admission and the current-turn Abort operation;
- its built-in model Bash tool and published file APIs.

The Web calls only AgentSmith APIs. AgentSmith calls only Botified's published
service API. Botified has no AgentSmith-specific protocol, Terminal transport,
provider credential, quota authority, or Kubernetes lifecycle responsibility.

A Task is the durable user object and the stable Botified session identity. A
Run is one allocation of compute for that Task. A Run never replaces or adopts
a different Pod under the same identity. A later allocation creates a new Run
while retaining the Task, session data, interaction history, and bound File
Library.

## Published Botified Runtime

AgentSmith consumes exactly the published Botified `v0.4.44` release:

```text
asset:  botified-core-linux-x86_64-musl.tar.gz
sha256: 1fdd193eeaea911951d58a15b1b42a786c6962d7af70af01f96fb13af56bf8f0
```

The image build downloads that asset and verifies the digest before installing
the binary. AgentSmith does not vendor, compile, fork, patch, or wrap Botified
source, and it has no fallback runtime or compatibility protocol.

## Runtime Configuration

Each Run receives one immutable generated Botified configuration. The Task ID
is the `runtime.session`; the Run ID is allocation identity and is not a second
session.

The single provider is derived from the selected AgentSmith endpoint:

- `name` is the endpoint name and `api_compat` is `standard`;
- `base_url` is
  `http://agentsmith-lite-api.${namespace}.svc.cluster.local/api/internal/tasks/${encodedTaskId}/runs/${encodedRunId}/v1`;
- `model`, `request_timeout_secs`, and provider capabilities come from the
  endpoint;
- `api_key_env` is `AGENTSMITH_LLM_BROKER_KEY`;
- `use_env_proxy` is `false` and priority is `10`.

Botified listens on `0.0.0.0:3099` and reads its service credential from
`BOTIFIED_SERVICE_KEY`. Runtime paths are:

```text
cwd:      /workspace/task/home/workspace
data_dir: /workspace/task/botified
artifacts:/workspace/task/home/workspace/.artifacts/${taskId}
```

The generated configuration explicitly provides:

- Bash for every endpoint, plus `view_image` only when the endpoint supports
  both text and image capabilities;
- 14-day timeline retention and bounded file upload, message-file, artifact,
  storage, and retention limits;
- `llm_text_preview.enabled: true`;
- `context_files.enabled: true` with a 32 KiB total limit;
- `skills.default_discovery: false` with an empty explicit skill list;
- disabled subagents, registry, and profiling.

There is no `allow_insecure_http`, `resume_unfinished`,
`tools.execution.bash_executor_addr`, delivery-receipt setting, private broker
TLS, provider forwarder, or legacy journal compatibility field.

## Message And Abort Protocol

AgentSmith sends an ordinary Task message with exactly one authenticated
`POST /v1/messages` containing:

```json
{"client_message_id":"<message-id>","text":"<content>"}
```

Ordinary success accepts `input_accepted`, `input_queued`, or
`input_duplicate` with matching message identity, timeline cursor, queue
length, and Botified state. Slash-prefixed text remains a Botified message and
its command-shaped response is not an AgentSmith control receipt.

AgentSmith claims a message before dispatch. If delivery fails before dispatch,
the product can report that rejection. If the transport outcome becomes
ambiguous after dispatch, the message is marked failed with a safe
outcome-unknown error and is never posted again. Botified timeline and state
provide later convergence; AgentSmith does not implement downstream delivery
ledgers, receipt queries, or cross-service exactly-once claims.

The public Abort route is:

```http
POST /api/v1/tasks/:taskId/turn/abort

{"expectedRunId":"<run-id>"}
```

`expectedRunId` fences stale UI actions. A missing, different, non-active, or
identity-mismatched Run returns `409 task_run_target_conflict`. An exact active
Run receives one authenticated, bodyless `POST /v1/abort`. An unreachable or
ambiguous Botified result returns `503 botified_abort_outcome_unknown`.
AgentSmith stores no Abort command ledger, replay instruction, optimistic
state, or turn identifier. There is no AgentSmith Stop route or capability.

## LLM Broker And Credentials

The only provider path is:

```text
Botified -> AgentSmith internal HTTP broker -> selected OpenAI-compatible provider
```

The internal broker route is:

```text
POST /api/internal/tasks/:taskId/runs/:runId/v1/chat/completions
```

The Kubernetes Service exposes the API on port `80` and targets API container
port `3000`. The public Ingress does not expose `/api/internal/**`.

Each Run has two independently derived HMAC bearer credentials:

| Credential | Direction |
| --- | --- |
| `lbk_...` / `AGENTSMITH_LLM_BROKER_KEY` | Botified to the exact Task/Run broker route |
| `bsk_...` / `BOTIFIED_SERVICE_KEY` | AgentSmith to the Botified service |

The credentials use different domains and are unequal for the same Run. Both
are injected only into the Botified container through the Run Secret. The
Terminal container receives neither. ConfigMaps, Run records, Bash child
environments, interactions, Kubernetes errors, logs, Audit details, and Web
responses must not propagate either value.

The broker accepts only the exact Run's `lbk_` credential and verifies that the
Task still points to that active Run before resolving the endpoint. The API
alone decrypts the upstream provider key, reserves quota before dispatch,
forwards the request, and settles Usage and Audit from the result. The Run Pod
never receives the upstream provider key and cannot contact the provider
directly.

Plain HTTP inside the local cluster is an accepted limitation. Protection
comes from exact-Run credentials, active-Run authorization, NetworkPolicy, and
the absence of a public internal route. There is no dormant TLS or dual
transport path.

## Sandbox And Terminal

One Run owns one immutable ConfigMap and one `restartPolicy: Never` Pod. The Pod
contains two regular containers:

1. the published Botified runtime;
2. the AgentSmith-owned Terminal executor.

Both mount the Task's JuiceFS-backed File Library paths. They remain process
isolated with `shareProcessNamespace: false`; the Terminal executor receives no
Botified or broker credential. Botified's model Bash remains internal to
Botified and does not use the Terminal executor.

The browser Terminal path is:

```text
Browser WebSocket
  -> AgentSmith API exact-Run admission
  -> same Run Service TCP 3110
  -> AgentSmith Terminal executor
```

The API checks session, write permission, Origin, exact active Run, and
single-terminal occupancy. It relays bounded UTF-8 JSON frames over bounded
NDJSON TCP framing and periodically rechecks access. Botified is not part of
this transport.

The Run NetworkPolicy permits only:

- DNS to the `kube-system` CoreDNS pods over UDP and TCP port `53`;
- ingress from AgentSmith API pods to Botified port `3099` and Terminal port
  `3110`;
- egress to AgentSmith API pods on TCP port `3000`.

It permits no general internet, ambient proxy, arbitrary namespace, or direct
provider egress.

## Resources, Startup, And Release

The persisted `resourceSnapshot` is the authoritative request and limit for
the whole Run Pod. Capacity, display, Usage, and Audit count it once. For each
CPU request, memory request, CPU limit, and memory limit, Botified receives
`floor(total * 4 / 5)` and the Terminal receives the exact remainder.
Quantities are integer millicores and bytes, so regular-container sums equal
the snapshot exactly. The sequential init container may use the whole
allocation. A Run is rejected if either regular container receives a zero
share or a container request exceeds its matching limit.

Startup persists immutable resource identity before applying the six owned
resources: Secret, ConfigMap, ServiceAccount, NetworkPolicy, Service, and Pod.
Activation requires the same Task/Run relationship, startup claim and fence,
ConfigMap bytes, real Pod UID, readiness, authenticated Botified state, and
Botified session ID. Missing or replacement Pods are not recreated or adopted
for that Run.

There is no idle, TTL, or automatic release policy. Release begins only from a
user-confirmed request or a failed/deleted Run cleanup intent. It is
unconditional and does not depend on Abort or process inspection.

The maintenance loop automatically converges a persisted Release intent. It
uses full identity labels, the persisted Pod UID, exact-name inspection, and
UID-preconditioned deletion for the six Run resources. Missing resources count
as absent; identity mismatch and Kubernetes uncertainty fail closed and remain
recoverable on the next tick. The Run becomes `released` only after exact
owned-resource absence, then records one duration/resource settlement, one
final Audit event, and one stable receipt. Cleanup never deletes File Library,
Task HOME, Botified session data, artifacts, or another Run's resources.

## Deployment Target And Validation

The supported delivery target is the self-hosted local single-node Kubernetes
environment. Cloud-provider deployment is not required for this baseline.
Validation exercises the real local OIDC, API, Botified, broker, JuiceFS,
Terminal, and Release paths with focused checks chosen for the changed
business behavior. End-to-end and visual checks are run deliberately when
needed; they are not release gates and do not produce evidence or report
systems.
