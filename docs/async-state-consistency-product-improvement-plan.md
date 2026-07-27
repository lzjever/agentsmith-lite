# AgentSmith Lite Task Runtime Consistency Plan

Status: Development in progress. Official Botified `v0.4.41` is published and
pinned; non-activating preparation and the atomic cutover remain incomplete.

## 1. Purpose

This plan fixes the consistency defects found while manually exercising Task,
Terminal, Sandbox release, and Files:

- a command can be accepted while the Web reports that it failed;
- late responses can replace newer Task or directory state;
- Terminal startup and connection state can oscillate;
- Release can race a Sandbox startup already in progress;
- Abort or Stop can target work imprecisely;
- retrying a file command can repeat an effect or touch a recreated path.

The objective is a predictable Agent Task workspace, not a new orchestration
platform. The work stays in the existing AgentSmith Lite repository and uses
the existing ProductStore, idempotency records, runtime reconciliation, and
Botified service boundary.

## 2. Product Result

After this milestone:

1. One user action has one command identity and at most one business effect.
2. An unknown response is shown as unresolved, never as definite failure.
3. Task state only moves forward on screen.
4. Terminal connection state has one owner and never alternates between shell
   and Connect because two effects disagree.
5. Release always targets the Run the user confirmed, prevents that Run from
   becoming active again, and eventually removes its app-owned resources.
6. Abort and Stop affect only the exact work the user selected.
7. File retries resolve the original operation and never reapply it to a path
   recreated after the operation began.

The target runtime boundary is:

`Web -> AgentSmith API -> {Botified official service API | AgentSmith-owned bash-executor}`

The Web remains an AgentSmith API client. AgentSmith server-side code uses the
official Botified service API for Agent work and connects directly to the
AgentSmith-owned `bash-executor` for Terminal. Botified and `bash-executor` run
as two process-isolated containers with the same Run PVC mounted; Terminal does
not traverse Botified. Authorization, command admission, idempotency, Run
fencing, runtime control, and file operation identity remain server-side.

## 3. Authority And Supersession

The broader product boundary remains in:

- `agentsmith-lite-product-development-plan.md`;
- `task-workspace-product-improvement-plan.md`;
- `core-workflow-product-improvement-plan.md`;
- `api-contract.md`;
- `architecture.md`.

This plan supersedes only these older implementation decisions:

- a Terminal-start request waiting for Sandbox readiness after its durable Run
  reservation;
- Release being expressed without the exact Run the user confirmed;
- Abort or Stop implicitly targeting whatever work is current when the server
  handles the request;
- Terminal transport traversing a Botified Terminal route rather than the
  AgentSmith-owned executor;
- compiling or retaining a vendored Botified source path after the required
  official release is available;
- Web mutation keys being cleared based on HTTP status or `ApiError` class;
- multiple components independently replacing evolving Task presentation.

The existing safety rule for uncertain Kubernetes apply remains authoritative:
local cancellation does not prove that the remote apply did not commit. Release
must retain a persistent drain barrier, wait for the external call to settle or
reach its existing hard deadline, re-enumerate exact app-owned resources, and
delete them before recording `released`.

The existing recursive-delete linearization also remains authoritative:
deletion takes ownership of the object at the path when the quarantine rename
occurs. The plan does not claim atomic compare-and-delete against an earlier
directory listing, because arbitrary Sandbox processes can write the same
JuiceFS mount.

## 4. Scope

### 4.1 Included

- Task creation and Task-message command convergence.
- Typed command outcomes and mutation-key lifecycle.
- Task presentation source ownership and stale-response rejection.
- The focused interaction cursor race check.
- Terminal-start admission and background continuation.
- Terminal local transport state, including close code `1009`.
- Release during startup and exact Run fencing.
- Exact-target Abort and background-work Stop.
- Official Botified artifact cutover and direct AgentSmith API-to-executor
  Terminal transport.
- File upload, overwrite, recursive delete, and File Library rename retries.
- Stale Task and Files list/detail responses directly involved in these paths.
- The smallest API, store, Botified port, and documentation changes required.

### 4.2 Excluded

- Automatic Sandbox TTL or process-idle inspection.
- Independent Chat product routes. Task conversation remains the primary Agent
  work surface and is not Chat.
- Artifact storage redesign.
- Credential, Endpoint, Policy, Audit, Usage, or Alert architecture changes.
- Generic event sourcing, workflow, saga, command bus, or retry service.
- A new repository, service, operator, queue, proxy sidecar, or compatibility
  adapter.
- An AgentSmith compatibility facade, shim, Botified vendor fork, or
  AgentSmith-built Botified artifact after official cutover.
- A Botified Terminal route or provider credential inside the Sandbox.
- Multi-replica Terminal occupancy.
- Broad visual redesign.
- Governance artifacts, evidence, generated reports, rehearsals, release gates,
  or tests of test infrastructure.

If implementation discovers a defect outside this boundary, fix it in place
only when it directly blocks these paths. Otherwise leave it out of this
milestone rather than expanding the plan.

## 5. Product Semantics

### 5.1 Command outcomes

Every replay-protected command listed in the command contract matrix carries:

- an idempotency key;
- an operation name;
- an authorization scope;
- a stable request fingerprint.

The server binds the key to that tuple. Reusing a key with a different
fingerprint returns `idempotency_payload_mismatch` and never changes the
original operation. This contract applies only to the commands in the matrix;
it does not extend replay protection to unrelated mutations such as Profile or
Notification updates.

Every definitive server response exposes exactly one of three typed acceptance
outcomes plus the orthogonal `keyDisposition: retain | retire` field:

| Server outcome | Meaning | Allowed `keyDisposition` |
|---|---|---|
| `accepted_in_progress` | durably admitted, result still converging | `retain` |
| `completed` | durable final result is available | `retire` |
| `rejected_before_acceptance` | this attempt admitted no business operation | `retain` or `retire`, explicitly selected by the server |

`outcome_unknown` is a Web transport/client state and is never serialized as a
server outcome. The Web enters it when a timeout, response parsing failure,
dropped connection, `408`, or unclassified `5xx` prevents it from reading a
typed server outcome and disposition. It conservatively retains the key and
replays the same command.

The Web changes key state only from `keyDisposition`; it does not derive
disposition from the error code, HTTP status, `retryable`, an untyped JSON body,
or an exception class. A structured `409` is not automatically a rejection or
a reason to retire a key.

`idempotency_payload_mismatch` means the changed-payload attempt was not
admitted, while the original key remains bound to the original command. It must
return `rejected_before_acceptance + retain` and preserve the original key,
fingerprint, and payload binding. Ordinary rejections proven to occur before
admission return `rejected_before_acceptance + retire`. When the server cannot
prove that retiring the key is safe, it returns `retain`.

The existing idempotency store is the only command-result store. The only
resolution path is replaying the original mutation route with the same key,
fingerprint, and payload. The route returns the stored or converging typed
result. Do not add a command-result query API, second command table, or
client-side command system.

Commands that call Botified have two durable replay layers. The AgentSmith
receipt is the product command record and is durably bound to one fixed
downstream Botified command key before dispatch. The official Botified service
stores and replays its own receipt for that downstream key. After Slice 0B
activation, if AgentSmith does not know the downstream result, it may only
replay the same operation with that same downstream key against the original
exact Run target. Until activation, the selected old runner's legacy delivery
GET recovery is the sole temporary live exception described in Slice 0A; it is
never used with the official binary and is deleted at activation. AgentSmith
never allocates a replacement downstream key, infers acceptance from timeline
state, or converts an unknown result into success or failure.

### 5.2 Mutation-key lifetime

`useMutationKeys` is the one Web helper for command identity. It exposes
explicit transitions for the three server outcomes plus the client-only
`outcome_unknown` state.

- A key is never rotated merely because time passed.
- A retry of an unresolved action uses the same key and fingerprint.
- While an action is unresolved, its form payload is locked and cannot change
  under the retained key. A changed payload is a new user action only after the
  current action is resolved.
- In addition to the normal Task create/message form drafts, only non-secret
  identity metadata may survive a component remount.

Task create and Task message use `sessionStorage` for the normal form draft plus
non-sensitive `{userId, projectId/taskId, key, fingerprint, createdAt}`
metadata. Storage keys follow the existing authenticated-user isolation: Task
create is scoped by `userId + projectId`, Task message by
`userId + projectId + taskId`, and both are removed by the existing logout
cleanup. On remount, an unresolved action reconstructs the same payload from
that locked draft and replays the original mutation route with the same key and
fingerprint. The prompt remains only in the normal form draft; do not save a
second prompt or serialized request payload for idempotency.

Terminal start, Release, Abort, and Stop retain their unresolved non-secret
command identity across component remounts in the same authenticated-user
`sessionStorage` scope. The retained record contains the operation, key,
fingerprint, Task identity, exact public request target, and creation time:
Terminal start retains `expectedRunId + expectedSandboxState`, Release retains
`expectedRunId`, Abort retains `expectedRunId + turnId`, and Stop retains
`expectedRunId + interactionId`. Remount replays the original route and locked
target until the server disposition resolves the key. It does not retarget the
command from newer canonical state or persist Botified internal IDs.

An upload key may be replayed only while the current page still holds the
original `File` object. Upload recovery does not cross a component remount.
After navigation or remount, the Web refreshes canonical directory state; a
later file selection is a new explicit upload with a new key. Atomic
no-replace, explicit overwrite, and server-side same-key convergence keep that
new action safe without a command-result query API or persisted file bytes.

Secrets, API keys, file bytes, and idempotency-only request payload copies are
never added to browser storage.

### 5.3 Task state ownership

Server canonical Task state and local Terminal transport state have separate,
non-overlapping owners.

The Task presentation reducer owns:

- Task and exact public Run identity;
- Sandbox lifecycle and capabilities;
- queue and current Agent work;
- interactions by stable `id` and monotonic `revision`;
- whether Terminal is available for the current Run.

The Terminal reducer owns only:

- `disconnected`, `connecting`, `connected`, `retrying`, or `closed`;
- socket intent and reconnect attempt;
- local close reason;
- the current socket instance.

The Terminal reducer cannot invent or restore server capability. A Task action
that changes public Run identity or removes Terminal capability explicitly
terminates the old transport intent. Internal Run fencing tokens remain
server-side and are never exposed as Web state.

Task sources may write only these fields:

| Source | Permitted update |
|---|---|
| authoritative full GET/reset | full canonical Task state when its read fence is current |
| ordered state SSE | same-Run monotonic lifecycle plus queue, turn, and capabilities, or an admissible new Run |
| interaction SSE/history | matching-Task interaction item with newer item revision |
| accepted mutation | a new canonical acceptance epoch, read invalidation, stable result identities, and one serialized refresh |
| rejected mutation | command feedback and canonical refresh only; no stale presentation replacement |
| Terminal socket | local transport state only |

Task ordering uses separate fences instead of one arrival epoch:

- `canonicalEpoch` advances only when canonical presentation is accepted;
- `latestCanonicalReadId` identifies the newest full GET started for the Task;
- `CommandFence` captures `taskId`, `startedAtCanonicalEpoch`,
  `expectedRunId`, and `expectedSandboxState`;
- `RunFence` holds `currentRunId`, lifecycle, and `retiredRunIds`.

A full GET allocates `readId` and captures its base `canonicalEpoch` without
advancing the epoch. It applies only when it is still the latest read and its
base epoch is unchanged, then advances `canonicalEpoch`. Interaction history
prepend is not a full read and merges only by stable `id` and monotonic
`revision`.

Ordered state SSE is accepted only in the current stream generation. For one
Run, lifecycle may stay equal or advance through `starting < active < failed <
release_requested < released`; same-stage queue, turn, and capability changes
remain valid. A different non-retired Run may be established only from
`released` state, including a released presentation with `runId = null`.
Establishing it retires the prior non-null Run. Rejected Run transitions request
one serialized canonical refresh and never revive a retired Run.

Command start only captures its fence. An accepted outcome allocates a fresh
canonical acceptance epoch, invalidates in-flight reads, and schedules the
shared serialized refresh tail. A receipt does not unconditionally replace
queue, lifecycle, or capability; message admission may merge its stable
interaction identity. Rejections retain user feedback but do not apply stale
payload presentation.

Do not add a database-wide presentation revision unless a focused failing test
proves that Task ID, canonical/read/command/Run fences, and interaction revision are
insufficient.

### 5.4 Files state ownership

Each File Library and directory scope has one active mutation sequence. The Web
either serializes mutations for that scope or assigns monotonically increasing
mutation intents. An older list response or older mutation result cannot
replace a newer scope state.

The product distinguishes two guarantees:

1. Same-command replay resolves the original file operation and never applies
   it again.
2. AgentSmith API commands for the same Library and normalized path commit in
   their server admission order.

The second guarantee uses one existing-process lock per
`Library + normalizedPath` in the single-node application target. Every upload,
overwrite, or delete acquires that lock before durable admission and holds it
through filesystem commit and receipt terminalization. Staging may happen
before the lock, but cannot change the destination. Lock acquisition therefore
defines AgentSmith admission order within one process.

Before admitting a new key under that lock, the service loads earlier durable
nonterminal file operations for the same Library/path in admission order. It
recovers each operation from its persisted staging or quarantine identity. If
an earlier operation cannot yet converge, the new command returns typed
`file_operation_in_progress` and is not admitted. This restart rule uses and,
if needed, minimally indexes the existing file idempotency operation records;
it does not add a file workflow store.

A later explicit overwrite therefore cannot be replaced by an older
AgentSmith command that finishes late, including across application restart.
Do not add a distributed lock or a new store for this deployment target.

This ordering is intentionally not a CAS promise against a stale Web listing.
Sandbox shell and Agent processes can mutate the same JuiceFS path without
passing through AgentSmith. A `stat` followed by `rename` cannot close that
race.

File behavior is therefore:

- non-overwrite upload uses a JuiceFS-supported atomic no-replace primitive;
- overwrite stages bytes and performs one atomic replace at commit;
- recursive delete atomically renames the current path into a unique
  command-owned quarantine;
- once quarantine rename succeeds, retries and cleanup touch only that
  quarantine identity, never the recreated source path;
- Library rename remains a database command bound to its original
  `expectedUpdatedAt`.

The local single-node JuiceFS environment must first demonstrate the chosen
no-replace primitive. If the current Node primitive cannot provide it, use the
smallest local helper in the existing service. Do not introduce a filesystem
transaction framework.

## 6. Command Contract Matrix

| Command | Durable acceptance point | Exact target | Final convergence |
|---|---|---|---|
| Task create | one Postgres transaction commits the complete business identity (Library create/bind, Task, Run reservation, initial message, and initial interaction) plus a durable in-progress operation | request fingerprint | JuiceFS preparation resumes from that operation; terminalize the receipt afterward and replay returns the same Task |
| Task message | interaction/queue admission and receipt commit | Task + interaction identity | stream/GET shows one accepted message |
| Terminal start | Run reservation and in-progress receipt commit | `expectedRunId + expectedSandboxState` | Run activation and completed receipt commit atomically |
| Release | `release_requested` fence and receipt commit | `expectedRunId` | drain barrier confirms exact resources absent |
| Abort turn | control intent and fixed downstream command key commit | `expectedRunId + canonical Botified turnId` | Botified stable compare-and-abort receipt |
| Stop background work | control intent, resolved target, and fixed downstream command key commit | `expectedRunId + interactionId + resolved Botified backgroundTaskId` | Botified stable exact-background-work receipt |
| Upload/overwrite | ordered file operation receipt and staged identity commit | Library + normalized path + fingerprint | earlier durable path operations converge first, then one filesystem commit or precise conflict |
| Recursive delete | ordered receipt plus quarantine identity commit | Library + normalized path | earlier durable path operations converge first; replay resumes same quarantine only |
| Library rename | renamed row and receipt commit | Library + `expectedUpdatedAt` | replay returns durable name |

Task create has one Postgres atomic boundary, not a cross-database/filesystem
transaction. Any required JuiceFS preparation begins only after the Postgres
commit. Replay or the existing continuation resumes that durable in-progress
operation, and the receipt becomes terminal only after JuiceFS preparation
reaches its stable result.

Task message does not use `accepted_in_progress`: atomic interaction and queue
admission succeeds as `completed`. If the Web cannot determine whether that
commit occurred, it uses `outcome_unknown + retain` and replays the same
command. Botified delivery and Agent execution then converge through canonical
Task state; they are not part of the Task-message command outcome.

Release, Abort, and Stop never silently retarget to the newest Run or work item.
If the expected target changed, the API returns a typed target conflict and the
Web refreshes before the user chooses another action.

The public Task projection returns opaque `runId` for all active/releasing Run
controls and opaque `turnId` whenever Abort is available. The public request
contracts are exact:

- Terminal start carries `expectedRunId + expectedSandboxState`;
- Release carries `expectedRunId`;
- Abort carries `expectedRunId + turnId`;
- Stop carries `expectedRunId + interactionId`.

These are public object identities, not the server's internal fencing token.
For Stop, AgentSmith authorizes the interaction and resolves its canonical
Botified `backgroundTaskId` before committing the exact control target; the Web
does not send or persist that internal ID.

The Botified service API must support exact compare-and-abort and exact
background-work stop identities with a stable command-key result. AgentSmith
uses that official service API directly. It must not emulate exact control with
a blind session-wide abort, infer a turn identity from a cycle, timeline cursor,
or Run ID, or invoke Botified TUI behavior. If canonical Botified `turnId` is
absent, the Abort capability is false and the API rejects Abort rather than
pretending another identity is exact.

## 7. Runtime Lifecycle

### 7.1 Terminal start

Terminal start owns admission, not Kubernetes readiness:

1. validate authorization and new-work eligibility;
2. atomically reserve the exact replacement Run as `starting` with
   `runtime.resume_unfinished=false` and its `accepted_in_progress` receipt;
3. return `202` with the Run identity;
4. let `syncActiveTasksOnce` be the only startup continuation owner;
5. under the startup/drain fence, apply the false ConfigMap, make the Pod ready,
   record its Pod UID and config hash, and complete the first cold process open
   while the Run remains `starting`;
6. while the Run remains `starting` under that same fence, durably prepare the
   ConfigMap with `runtime.resume_unfinished=true` and change the exact Run Pod
   config hash/spec to create a new generation deterministically;
7. verify that a different Pod UID with the expected true-config hash is ready,
   and that its Botified process open actually read
   `runtime.resume_unfinished=true`;
8. in one Postgres transaction, mark the Run `active`, persist
   `runtime.resume_unfinished=true`, and complete the original receipt;
9. allow message dispatch only after that transaction commits.

The request handler does not also prepare the Sandbox. If Kubernetes apply or
Botified readiness is blocked, the HTTP response still returns after step 2.
A process restart resumes the admitted startup through the same reconciler.
An unknown ConfigMap apply or Pod-generation rebuild result never permits Run
activation; the startup owner keeps the Run `starting` and resolves it through
the same startup/drain fence. ConfigMap API success alone is not readiness and
does not permit activation.

### 7.2 Release during startup

After user confirmation, Release is unconditional for the exact confirmed Run:

1. atomically commit `release_requested`, advance that Run fence, and persist
   the Release receipt as `accepted_in_progress + retain`;
2. reject new work and late activation for the fenced Run;
3. best-effort abort the matching process-local startup owner;
4. retain the persistent startup/drain barrier while an external apply result
   is unknown;
5. after the external call settles or its existing hard deadline expires,
   re-enumerate resources by exact app-owned Run labels and delete again;
6. only after the post-drain observation confirms absence, atomically record
   `released` and complete the Release receipt as `completed + retire`.

This preserves both product rules: the user does not need to inspect running
processes, and a late Kubernetes apply cannot recreate a Run already recorded
as released.

The initial Release response is the admitted in-progress result; cleanup
proceeds in canonical Task state. The UI shows one stable releasing state and
does not declare completion or failure while cleanup is still converging.

### 7.3 Abort and Stop

Separate:

- `canStartNewWork`, which requires current endpoint, credential, policy,
  membership, and capacity eligibility;
- `canControlCurrentWork`, which requires authorization and the exact live
  target but not current provider admission health.

Changing endpoint or credential health cannot remove control over already
running work.

AgentSmith commits the exact control intent, fixed downstream command key, and
exact Run-derived Botified service target before calling Botified. Botified
compares the target identity at execution time and durably returns a stable
receipt for that command key. A lost response or AgentSmith restart replays only
that key against that target. Replaying the same command against an
already-stopped exact target returns the original successful outcome. A
different Run, turn, or background task returns target conflict and is never
selected as a replacement target.

Abort uses only the canonical Botified `turnId` projected for the exact Run.
Stop uses the authorized product `interactionId` to resolve and commit the
matching canonical Botified `backgroundTaskId`; both identities remain bound in
the receipt.

### 7.4 Terminal transport

Public `openTerminal` means canonical authorization plus Run/runtime
eligibility. It deliberately excludes process-local
`occupiedTerminalTaskIds`; `openTaskTerminal` keeps that admission mutex and
rejects a second concurrent transport.

The browser WebSocket terminates at AgentSmith API. AgentSmith resolves the
executor endpoint on the existing exact Run-derived Service target and
performs an authenticated `taskId + runId` handshake with a Run-scoped executor
service key before relaying the socket directly to `bash-executor`. It does not
use a Botified Terminal route. Botified reaches the external bash executor
through its official loopback contract inside the two-container Sandbox Pod;
both containers mount the same PVC but do not share a process namespace.

The Sandbox NetworkPolicy allows only the required AgentSmith API ingress to
the executor Service and the existing broker egress. The executor service key
is non-provider, exact-Run scoped, and supplied only through the live Sandbox
secret/configuration path. Real provider credentials remain in AgentSmith and
never enter either Sandbox container.

The Web observes `taskId`, exact public `runId`, Sandbox lifecycle, and
`openTerminal`. Task change, Run change, non-active lifecycle, or
`openTerminal = false` terminates old transport intent. Terminal Start records
only its target Run intent and waits for canonical observation of that exact Run
as active and capable before connecting; a third Run cannot inherit the intent.

AgentSmith API owns browser-socket admission and periodic exact-Run
authorization recheck. It closes the browser socket with `1008` when that
authorization, capability, Run identity, or executor handshake no longer
matches, and with `1009` when its bounded input/output relay buffer is exceeded.
The Web owns terminal-intent disposal for both codes and never restores
capability locally. These controls remain Slice 3. Do not add distributed
occupancy or a general connection manager in this milestone.

## 8. Implementation Slices

Slice 1 and Slice 2 are complete against the existing dependency. Official
Botified `v0.4.41` is available. Slice 0 non-activating preparation and Slice 3
exact lifecycle work may proceed while the old runner remains live, including
direct validation against the official binary, but no official-only contract is
sent on the live path until the one atomic activation. That activation deletes
every obsolete competing path in the same coordinated change.

### Slice 0: Official Botified prerequisite and cutover

Status: official prerequisite satisfied; preparation may proceed, while live
activation waits for the exact lifecycle and drain conditions below.

The official Botified release consumed by AgentSmith is fixed to:

- version: `v0.4.41`;
- asset: `botified-core-linux-x86_64-gnu.tar.gz`;
- SHA-256:
  `8a69eabad03e983f3a3c4779754a149ef6a6d94655142a906cd38d78bb354933`.

This version, asset name, and checksum are one immutable packaging input. The
official release provides all of:

- the external bash executor loopback contract;
- durable message delivery receipt replay;
- cold discard for `runtime.resume_unfinished=false`;
- compatible reading of the real AgentSmith Lite legacy journal profile:
  `accepted_input` has `source=user`, normal urgency, no metadata, one Text
  content part, `message_id=delivery_key`, and a two-field
  `delivery={delivery_key,request_hash}`; any raw legacy delivery outside this
  profile stops open with a typed compatibility error without truncating or
  rewriting the journal, and is not a promise of general old-Botified
  migration;
- one delivery authority map whose value is either a complete modern Current
  admission or a CanonicalLegacy admission with an explicit
  `schema=canonical_legacy_v1` discriminator and the authority fields
  `delivery_key`, `request_hash`, `message_id`, and `payload_sha256`; replay
  normalizes matching raw legacy input in memory, and checkpoint writes only
  this versioned CanonicalLegacy form rather than restoring or inventing
  `accepted_kind`, `timeline_cursor`, or `turn_id`;
- legacy `unfinished_work_discarded` replay with its original selective
  `message_ids` and `projection_ids` semantics: preserve the completed
  replay-visible canonical transcript prefix, remove the selected unfinished
  transcript tail and listed messages from pending/known state, remove their
  message cursors and the listed projection intents, and clear restart-boundary
  state; it is not an alias for the new global runtime discard, does
  not delete delivery authority, and checkpoint plus reopen cannot revive a
  discarded input;
- exact compare-and-Abort;
- exact background Stop with a stable downstream command-key result;
- explicit per-provider `allow_insecure_http` support so Botified can call the
  AgentSmith built-in broker over in-cluster HTTP;
- an official x86_64 binary built on a Debian Bookworm-compatible baseline and
  checked to require no GLIBC newer than 2.36.

AgentSmith does not supply pseudo-exact behavior, a compatibility facade or
shim, or a vendor fork for any missing contract. Because a new Run for the same
Task reuses the PVC and Botified session, draining the old runner cannot remove
its durable delivery authority. Legacy compatibility therefore belongs in
upstream Botified replay and checkpoint handling, never in an AgentSmith shim.
The modern Current journal and HTTP receipt remain strict and complete; their
fields do not become optional.

For an exact POST replay of a CanonicalLegacy delivery with the same key, hash,
and canonical payload digest, Botified returns `200` with
`outcome=completed`, `receipt_kind=canonical_legacy`, `delivery_key`,
`request_hash`, `message_id`, and `payload_sha256`. This replay performs no
enqueue, provider call, file bind, journal append, or timeline write. Reusing
the key with a different hash or digest returns the stable typed `409`
`delivery_key_payload_mismatch` and leaves the original authority unchanged.

Slice 0B activation removes AgentSmith's legacy GET delivery-receipt query.
Lost-response and lease recovery replay the original POST with its original
downstream key, hash, and payload. The AgentSmith parser strictly accepts either
the complete modern Current receipt or the CanonicalLegacy receipt; absence of
cursor, accepted kind, and turn ID is valid only for CanonicalLegacy. Abort
continues to use only the canonical `state.turn_id` observed for that same Run
and never derives a turn from a legacy receipt, timeline, cursor, or Run ID.

Focused compatibility checks use a representative journal fixture derived from
the old production writer contract described above. The plan does not claim
that a real legacy journal sample exists on the developer's machine. The
fixture proves the old marker's selective transcript, pending/known message,
cursor, projection-intent, and restart-boundary result, preservation of delivery
authority, and no input revival after checkpoint and reopen. A syntactically
valid raw legacy delivery outside the Lite profile is checked both as a middle
line and as the physical tail: each open returns the same typed compatibility
error, leaves the journal byte-identical, and performs no truncate, rewrite, or
checkpoint.

#### Slice 0A: Non-activating contract and artifact preparation

While the old runner remains live, prepare:

- a strict discriminated receipt union: complete modern Current receipts retain
  every required field, while CanonicalLegacy requires only its explicit
  variant and authority fields;
- POST replay recovery using the persisted original delivery key, request hash,
  and payload, ready to replace GET recovery at activation;
- Botified provider config rendering with explicit `allow_insecure_http=true`
  for the in-cluster AgentSmith broker;
- runner packaging that downloads only the pinned official asset above and
  fails fast unless its SHA-256 matches.

These changes may be exercised directly against the official binary without
selecting it for live Runs. Until atomic activation, the selected live path keeps
the old delivery GET recovery, old config contract, vendored source build, and
old runner parser behavior. It must not send the new receipt, replay, config, or
exact-control contracts to the old runner, and preparing the official image must
not deploy it. This is temporary source staging for one cutover, not an adapter
or a supported dual runtime path.

#### Slice 0B: Atomic activation

Activation requires every Slice 3 condition to be implemented first, including
its common outcome/key contracts, persistent drain barrier and process-local
startup cancellation, and separate start-new-work and control-existing-work
predicates. In particular:

- exact Abort and Stop persist the exact Run, exact turn or resolved background
  target, and one fixed downstream command key before dispatch, replay only that
  binding, and have no blind, session-wide, inferred-target, or new-key
  fallback;
- Terminal connects directly from AgentSmith API to the exact Run's
  AgentSmith-owned bash executor with the Run handshake and service key; its
  WebSocket periodically rechecks the exact Run and closes mismatch with `1008`,
  and the Web disposes transport intent on `1009`;
- cold startup performs the false then true process-open sequence, verifies the
  true generation by a new Pod UID and expected config hash, and cannot activate
  until that second process has actually opened with true;
- Terminal start has one durable reservation, one startup continuation owner,
  and one transaction that commits Run activation together with its completed
  receipt;
- Release first persists `accepted_in_progress + retain`; only confirmed absence
  of all exact app-owned Run resources permits `completed + retire`.

All of these implementations can be completed while the old runner is live.
Slice 0A completes non-activating binary and contract validation directly
against the official binary. No live official-runner validation occurs while
admission is fenced; the live path begins with the first admitted Run after the
coordinated deployment is fully selected.

Perform the activation in this order:

The admission fence is a narrow persistent switch in the existing product or
deployment configuration. It remains effective across process restarts and
overlapping rollouts and is not a general maintenance system.

1. enable the fence for every new Run and Terminal start while allowing admitted
   work and exact controls to converge;
2. drain and release every old Run, and wait for every nonterminal product or
   downstream receipt associated with those Runs to reach a durable terminal
   result;
3. confirm that no app-owned Run resource remains;
4. deploy the coordinated AgentSmith app and official runner change once,
   selecting the strict union/POST/config contracts and simultaneously deleting
   `third_party/botified`, `PINNED_SOURCE.json`, every source PIN or vendor
   input, the Botified source build stage, legacy delivery GET recovery and its
   old receipt/config contracts, and every vendored or binary fallback;
5. confirm that the old app no longer receives traffic and every serving new app
   instance has selected the official artifact and new contracts;
6. clear the fence, then let the first new Run exercise the formal exact
   lifecycle and official runner path.

After activation, only the pinned official artifact path and new contracts
remain. Do not retain an adapter, compatibility facade, or long-lived dual path.
This changes neither the two active repositories `agentsmith-lite` and
`agentsmith-lite-substrates` nor the existing deployed service set.

### Slice 1: Typed command convergence

Status: complete against the existing dependency; official contract and
artifact validation belongs to Slice 0A, with live acceptance in Slice 0B.

Implement:

- the three server wire outcomes and client-only `outcome_unknown` state in
  contracts and the Web API client;
- explicit server `keyDisposition` and key/fingerprint mismatch handling;
- explicit `useMutationKeys` transitions;
- same-route replay through the existing idempotency store;
- `sessionStorage` draft and identity retention for Task create and Task
  message;
- payload locking while either command is unresolved;
- Task create Postgres admission followed by resumable JuiceFS preparation and
  receipt terminalization.

This first slice applies the common outcome/key contract only to Task create
and Task message. It does not implement or claim exactly-once file behavior.
Terminal start, Release, Abort, and Stop adopt the contract in Slice 3; file
commands adopt it with their durable safety work in Slice 4. No slice adds a
command-result query endpoint.

Focused behavior checks:

- a Task message accepted before a simulated lost response produces one
  interaction after same-route replay, including after a remount;
- a Task create admitted before response loss resumes JuiceFS preparation and
  returns the same Task after same-route replay, including after a remount;
- after official cutover, an accepted Botified delivery receipt survives
  Botified and AgentSmith restart and replays by the same fixed downstream key;
- after official cutover, lost-response recovery for a CanonicalLegacy delivery
  replays the original POST and receives the same completed legacy receipt
  without a GET receipt query or a second execution;
- the same key with a changed fingerprint is rejected without changing the
  original operation.

User result: no false definitive failure and no duplicate action after Retry.

### Slice 2: Monotonic Task and Files presentation

Status: complete against the existing dependency.

Implement:

- the field ownership table in the Task and Terminal reducers;
- separate canonical epoch, latest full-read identity, command fence, and
  monotonic exact-Run lifecycle fence;
- current-generation ordered state SSE and revision-only interaction merging;
- one serialized canonical refresh after message admission;
- public Terminal capability without process-local occupancy, while retaining
  the admission mutex;
- exact target-Run Terminal intent gated by canonical active capability;
- per-scope Files mutation intent ordering;
- stale list/detail response rejection.

Add one deterministic interaction interleaving check: a pending user message
becomes accepted between suppression capture and change-page read. If current
code already preserves the accepted revision, make no store change. If it
skips the revision, add the smallest snapshot-bound ProductStore read.

Focused behavior checks:

- an older Task GET or later-arriving same-Run active SSE cannot undo accepted
  Release;
- Run-B retirement prevents late Run-A revival, while released/null admits one
  legal new Run;
- only the latest full GET with an unchanged base epoch applies; interaction
  history merge does not invalidate it;
- command acceptance remains valid across intervening SSE/interaction events,
  while stale rejection cannot replace canonical state;
- reverse-order post-message reads cannot remove the newer queue/interaction;
- the refresh tail stays single-flight and continues after one failed refresh;
- Terminal target intent waits for canonical exact-Run active capability, and
  capability loss, non-active state, Run change, or Task change terminates it;
- occupancy leaves public `openTerminal` true while the admission mutex rejects
  a second connection;
- an older directory response cannot undo a completed file mutation.

User result: visible Task, Terminal, and Files state does not jump backward.

### Slice 3: Exact runtime lifecycle

Status: required before Slice 0B activation; implementation and official-binary
validation may complete while the old runner remains selected.

Implement:

- the common outcome/key contract for Terminal start, Release, Abort, and Stop;
- `202 accepted_in_progress` after durable Terminal-start reservation;
- one reconciler startup owner;
- atomic Run activation plus final Terminal-start receipt;
- `expectedRunId` on Release, with `accepted_in_progress + retain` until exact
  resources are confirmed absent and only then `completed + retire`;
- persistent drain barrier plus process-local startup cancellation;
- persisted exact Run, target, and fixed downstream command-key identities for
  Abort and Stop, with no fallback;
- official cold discard on the replacement Run's first process open with
  `runtime.resume_unfinished=false`, followed while still `starting` by durable
  true configuration, a config-hash/spec-triggered exact Run Pod generation,
  verification of a new Pod UID and expected config hash, and a second ready
  process open that actually reads true before activation and message dispatch;
- separate start-new-work and control-existing-work predicates;
- direct AgentSmith API-to-executor Terminal transport with exact Run-derived
  endpoint on the existing Service target, handshake, service key, and
  NetworkPolicy;
- WebSocket admission capture of exact public `runId` plus periodic canonical
  recheck that closes exact-Run mismatch with `1008`;
- Terminal `1009` transport-intent termination.

Slice 3, not Slice 2, owns public `expectedRunId`, durable lifecycle/startup
recovery, Release drain, WebSocket Run-bound recheck, and `1009` handling.

Focused behavior checks:

- block Kubernetes apply and verify Terminal-start returns after reservation;
- restart the process and verify the same Run startup resumes once;
- Release during an unknown apply cannot activate the old fence and cannot
  record released until post-deadline enumeration is empty;
- a stale Release confirmation cannot release a newer Run;
- credential or endpoint drift does not prevent exact Abort/Stop;
- unresolved Terminal start, Release, Abort, and Stop survive a Web remount and
  replay the same locked product key and target;
- a lost Abort/Stop response followed by AgentSmith restart replays the same
  downstream command key to the same exact Run target and returns its stable
  receipt;
- the replacement Run's first process open uses
  `runtime.resume_unfinished=false`, discards unfinished work, preserves
  completed history, then the deterministic true-config Pod generation becomes
  ready and opens with true before dispatch; an immediate later process restart
  of that same Run also reads true and does not discard newly accepted work;
- Terminal connects from Web through AgentSmith API directly to the exact
  Run's executor, with no Botified Terminal route;
- close `1009` disposes one transport and leaves one usable Connect action.

User result: startup, control, Release, and Terminal connection behavior match
the Task the user can see.

### Slice 4: File operation convergence

Implement:

- the common outcome/key contract and durable replay safety for file commands;
- atomic no-replace for normal upload;
- one staged atomic replace for explicit overwrite;
- single-node per-Library/path ordering for different command keys;
- command-owned quarantine identity for recursive delete;
- same-key recovery that never returns to a recreated source path;
- durable Library rename response convergence;
- per-scope stale read invalidation from Slice 2.

Focused behavior checks:

- ambiguous upload response replays to one file;
- non-overwrite upload loses atomically when the destination already exists;
- overwrite commits, the path later changes, and old recovery does not rewrite
  it;
- an older unresolved overwrite and a newer explicit overwrite commit in
  admission order, leaving the newer bytes at the path;
- after process restart, a newer key cannot overtake an older durable
  nonterminal operation for the same Library/path;
- recursive delete quarantines an object, the source path is recreated, and
  replay touches only the original quarantine;
- Library rename commits before response loss and replay returns the new name.

User result: retries do not duplicate, overwrite, or delete unrelated newer
filesystem objects.

## 9. Module Impact

Likely existing modules:

| Area | Modules |
|---|---|
| command outcomes | `packages/contracts/src/api.ts`, Web API client, `use-mutation-keys.ts` |
| Task state | `TaskDetailPage.tsx`, `TaskConversationWorkspace.tsx`, Task reducer |
| Terminal state | `TaskTerminalPanel.tsx`, terminal reducer/start helper |
| Task/runtime commands | `packages/application/src/taskService.ts`, `runtimeService.ts` |
| lifecycle | `sandboxLifecycleService.ts`, sandbox reconciler and existing stores |
| official Botified boundary | `packages/ports/src/botified.ts`, `packages/botified-runtime`, runtime image/version/digest packaging, and removal of `third_party/botified` at cutover |
| executor Terminal | `packages/bash-executor`, `packages/api-entry-node`, existing exact Run Service/Secret and Sandbox NetworkPolicy rendering |
| Files | `fileService.ts`, `fileLibraryService.ts`, `recursiveDeletionService.ts`, Files pages |
| contracts/docs | `api-contract.md`, `sandbox-controller.md`, `botified-runtime.md` where behavior changes |

Do not move behavior into new packages merely to match this table. Follow the
current ownership boundary and add only exact store methods needed for atomic
commits. Keep the two active repositories; do not add a repository, deployed
service, proxy sidecar, Botified Terminal route, or Sandbox provider key.

## 10. Verification And Acceptance

Verification belongs beside the changed business behavior. Run focused tests
serially, then only the narrow compile/type check needed by that slice. Do not
create a runner, report, evidence directory, gate, or wrapper.

The deterministic checks named in each slice are implementation guidance, not
a permanent release process. Do not test fixtures, wrappers, plan prose, or the
testing mechanism.

After all slices are integrated, the developer actively runs these local
single-node K8s paths one at a time:

1. send a Task message through the configured real OpenAI-compatible DeepSeek
   endpoint while the Sandbox starts, and observe one message and one response;
2. Release during startup and observe the old Run remain fenced until exact
   resources are absent;
3. connect Terminal, force the confirmed close path, and observe one stable
   Connect state instead of oscillation;
4. retry one deliberately ambiguous message or file response and observe one
   business effect;
5. recreate a deleted file path and confirm old delete recovery leaves the new
   path intact.

Browser and visual checks are manually initiated validation. They are never
automatic release gates.

Slice 0A completes non-activating official-binary and contract validation. For
Slice 0B, keep admission fenced through the coordinated deployment, confirm
that only the new app receives traffic and that it has fully selected the
official artifact, then clear the fence. The first new Run follows the formal
exact lifecycle and naturally validates the live official-runner path. Do not
add a canary, second deployment path, or default gate.

## 11. Handoff Completion

The milestone is complete when:

- AgentSmith consumes official Botified version `v0.4.41`, asset
  `botified-core-linux-x86_64-gnu.tar.gz`, and SHA-256
  `8a69eabad03e983f3a3c4779754a149ef6a6d94655142a906cd38d78bb354933`,
  retains this immutable artifact pin, no longer compiles vendored source, and
  has no `third_party/botified`, source PIN/build stage, fallback, facade, shim,
  or fork;
- a representative legacy Lite journal derived from the old production writer
  contract opens successfully and, after checkpoint, retains state, history,
  and a versioned CanonicalLegacy delivery authority; the canonical form does
  not imply recovery of a legacy `accepted_kind`, timeline cursor, turn ID, or
  complete modern HTTP receipt;
- an exact CanonicalLegacy POST replay returns its stable completed legacy
  receipt without enqueue, provider, file, journal, or timeline effects, while
  changed hash or payload returns typed conflict;
- legacy `unfinished_work_discarded` selectively removes its recorded messages
  from the unfinished canonical transcript tail, pending/known state, and
  message cursors, removes its recorded projection intents, clears the
  restart-boundary state, preserves the completed transcript prefix and delivery
  authority, and checkpoint plus reopen does not revive those inputs;
- syntactically valid out-of-profile raw legacy delivery in either a middle line
  or the physical tail returns the stable typed compatibility error with a
  byte-identical journal and no truncate, rewrite, or checkpoint;
- the official x86_64 Botified binary executes on Debian Bookworm and requires
  no GLIBC newer than 2.36;
- official Botified delivery and exact-control receipts survive restart and
  replay only by their original downstream command keys;
- all commands in the matrix have one durable acceptance point, one typed
  outcome path, and one replay path;
- the Web retains unresolved Task create/message identity and normal form draft
  in `sessionStorage` across remounts, replays the original mutation route with
  the same key and fingerprint, and never changes a retained command's payload;
- Task canonical state and Terminal local state have non-overlapping owners;
- focused out-of-order checks prove stale responses cannot regress the UI;
- Terminal start returns `accepted_in_progress + retain` after its durable
  reservation while external startup is blocked, has one continuation owner,
  and commits Run activation plus `completed + retire` atomically;
- Release targets `expectedRunId`, initially returns
  `accepted_in_progress + retain`, fences late activation, and keeps the drain
  barrier until a post-settlement/deadline observation confirms absence before
  committing `completed + retire`;
- Abort and Stop persist the exact Run, fixed downstream command key, and exact
  target identities before dispatch, replay without fallback through the
  Botified service API, Stop binds the resolved background task, and Abort is
  unavailable without a canonical Botified turn ID;
- the replacement Run opens once with `runtime.resume_unfinished=false`, then
  a new Pod UID with the expected deterministic true-config hash becomes ready
  and opens with true before activation; an immediate same-Run process restart
  still reads true and does not discard new work;
- cutover uses the narrow persistent admission fence across process restarts and
  overlapping rollout, drains and releases every old Run, waits for every
  nonterminal product/downstream receipt to converge, and confirms all app-owned
  Run resources absent; one coordinated app and official-runner deployment then
  deletes vendor, legacy GET/receipt/config contracts, and fallbacks;
- the fence is cleared only after the old app receives no traffic and every
  serving new app has selected the official artifact; the first admitted Run
  follows the formal exact lifecycle and naturally validates the live runner,
  with no canary, second deployment path, general maintenance system, or default
  gate, while legacy journal schema compatibility remains required for durable
  state on reused PVCs;
- Terminal runs Web-to-AgentSmith-to-executor with an exact Run handshake and
  service key, while `1008`/`1009` cannot produce shell/Connect oscillation;
- file replay never re-enters a recreated source path;
- obsolete competing implementations are deleted;
- no new governance layer, generic workflow, repository, service, proxy
  sidecar, Botified Terminal route, or Sandbox provider key exists.

Slice 1 and Slice 2 require no additional handoff. The official `v0.4.41`
prerequisite is satisfied: Slice 0A and Slice 3 may proceed without selecting
the official runner, and official live behavior begins only with Slice 0B atomic
activation. No additional planning, evidence, release, or test-governance
document is required.
