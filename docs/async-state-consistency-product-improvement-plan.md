# AgentSmith Lite Task Runtime Consistency Plan

Status: Ready for development handoff

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

The Web remains an API client. Authorization, command admission, idempotency,
Run fencing, runtime control, and file operation identity remain server-side.

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
- A new repository, service, operator, queue, or compatibility adapter.
- Multi-replica Terminal occupancy.
- Broad visual redesign.
- Governance artifacts, evidence, generated reports, rehearsals, release gates,
  or tests of test infrastructure.

If implementation discovers a defect outside this boundary, fix it in place
only when it directly blocks these paths. Otherwise leave it out of this
milestone rather than expanding the plan.

## 5. Product Semantics

### 5.1 Command outcomes

Every mutating request carries:

- an idempotency key;
- an operation name;
- an authorization scope;
- a stable request fingerprint.

The server binds the key to that tuple. Reusing a key with a different
fingerprint returns `idempotency_payload_mismatch` and never changes the
original operation.

The API exposes a typed acceptance outcome. The Web must not infer acceptance
from an HTTP status, `retryable`, a JSON body, or an exception class.

| Outcome | Meaning | Web key state |
|---|---|---|
| `accepted_in_progress` | durably admitted, result still converging | retain and reconcile |
| `completed` | durable final result is available | clear after canonical state absorbs it |
| `rejected_before_acceptance` | no business operation was admitted | clear and allow a new action |
| `outcome_unknown` | transport cannot establish the result | retain and query/replay the same command |

Timeouts, response parsing failures, dropped connections, `408`, and
unclassified `5xx` are `outcome_unknown`. A structured `409` is not
automatically a rejection; it may represent an admitted command still
converging.

The existing idempotency store is the only command-result store. The only
resolution path is replaying the original mutation route with the same key,
fingerprint, and payload. The route returns the stored or converging typed
result. Do not add a command-result query API, second command table, or
client-side command system.

### 5.2 Mutation-key lifetime

`useMutationKeys` is the one Web helper for command identity. It exposes
explicit transitions for the four outcomes above.

- A key is never rotated merely because time passed.
- A retry of an unresolved action uses the same key and fingerprint.
- While an unresolved action remains mounted, a changed payload cannot reuse
  its key. It is a new user action after the current action is resolved.
- Only non-secret identity metadata may survive a component remount.

Task drafts may retain a Task-message key, scope, fingerprint, and creation
time. They must not persist a full prompt solely for idempotency.

An upload key may be replayed only while the current page still holds the
original `File` object. Upload recovery does not cross a component remount.
After navigation or remount, the Web refreshes canonical directory state; a
later file selection is a new explicit upload with a new key. Atomic
no-replace, explicit overwrite, and server-side same-key convergence keep that
new action safe without a command-result query API or persisted file bytes.

Secrets, API keys, file bytes, and raw request payloads are never added to
browser storage.

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
| current initial GET/reset | full canonical Task state |
| interaction SSE | interaction item with matching Task and newer item revision |
| state SSE | canonical Run, queue, lifecycle, and capability for the current Run |
| command receipt | command outcome and stable result identities only |
| Terminal socket | local transport state only |

Every Task read carries `(taskId, readEpoch)`. Run-related updates also carry
the exact public `runId`. A stream update, accepted mutation, or newer read
invalidates older reads. A command rejection may update command feedback, but
cannot replace canonical Task state after its starting epoch has advanced.

Do not add a database-wide presentation revision unless a focused failing test
proves that Task ID, read epoch, Run fence, and interaction revision are
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
| Task create | one `AtomicTaskCreate` transaction commits Library create/bind, Task, Run reservation, initial message, initial interaction, and fixed receipt | request fingerprint | replay returns same complete Task |
| Task message | interaction/queue admission and receipt commit | Task + interaction identity | stream/GET shows one accepted message |
| Terminal start | Run reservation and in-progress receipt commit | `expectedRunId + expectedSandboxState` | Run activation and completed receipt commit atomically |
| Release | `release_requested` fence and receipt commit | `expectedRunId` | drain barrier confirms exact resources absent |
| Abort turn | control intent commit | `expectedRunId + turnId` | Botified stable compare-and-abort result |
| Stop background work | control intent commit | `expectedRunId + interactionId` | Botified stable exact-work result |
| Upload/overwrite | ordered file operation receipt and staged identity commit | Library + normalized path + fingerprint | earlier durable path operations converge first, then one filesystem commit or precise conflict |
| Recursive delete | ordered receipt plus quarantine identity commit | Library + normalized path | earlier durable path operations converge first; replay resumes same quarantine only |
| Library rename | renamed row and receipt commit | Library + `expectedUpdatedAt` | replay returns durable name |

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

The Botified service API must support exact compare-and-abort and exact
background-work stop identities with a stable command result. AgentSmith uses
that service API directly. It must not emulate exact control with a blind
session-wide abort, and it must not invoke Botified TUI behavior.

If the installed Botified release lacks this service contract, update the
Botified release dependency before implementing exact Abort/Stop. Do not add an
AgentSmith-side adapter that pretends a blind abort is exact.

## 7. Runtime Lifecycle

### 7.1 Terminal start

Terminal start owns admission, not Kubernetes readiness:

1. validate authorization and new-work eligibility;
2. atomically reserve the exact Run and `accepted_in_progress` receipt;
3. return `202` with the Run identity;
4. let `syncActiveTasksOnce` be the only startup continuation owner;
5. atomically activate the Run and complete the original receipt.

The request handler does not also prepare the Sandbox. If Kubernetes apply or
Botified readiness is blocked, the HTTP response still returns after step 2.
A process restart resumes the admitted startup through the same reconciler.

### 7.2 Release during startup

After user confirmation, Release is unconditional for the exact confirmed Run:

1. commit `release_requested` and advance that Run fence;
2. reject new work and late activation for the fenced Run;
3. best-effort abort the matching process-local startup owner;
4. retain the persistent startup/drain barrier while an external apply result
   is unknown;
5. after the external call settles or its existing hard deadline expires,
   re-enumerate resources by exact app-owned Run labels and delete again;
6. record `released` only after the post-drain observation confirms absence.

This preserves both product rules: the user does not need to inspect running
processes, and a late Kubernetes apply cannot recreate a Run already recorded
as released.

The Release API returns an admitted result; cleanup proceeds in canonical Task
state. The UI shows one stable releasing state and does not declare failure
because cleanup is still converging.

### 7.3 Abort and Stop

Separate:

- `canStartNewWork`, which requires current endpoint, credential, policy,
  membership, and capacity eligibility;
- `canControlCurrentWork`, which requires authorization and the exact live
  target but not current provider admission health.

Changing endpoint or credential health cannot remove control over already
running work.

AgentSmith commits the exact control intent before calling Botified. Botified
compares the target identity at execution time and returns a stable result for
the command key. Replaying the same command against an already-stopped exact
target returns the original successful outcome. A different Run, turn, or work
item returns target conflict.

### 7.4 Terminal transport

Close code `1009` means the current transport attempt is over:

- disable socket intent for that attempt;
- retain a safe user-facing reason;
- dispose the socket and reconnect timer once;
- show Connect again only when canonical Task capability permits it.

Do not add heartbeat, distributed occupancy, or a general connection manager in
this milestone. Those are separate problems unless a focused reproduction
shows they are required to fix the confirmed oscillation.

## 8. Implementation Slices

Execute these slices in order. Each slice deletes the obsolete competing path
as part of the same change.

### Slice 1: Typed command convergence

Implement:

- the four typed acceptance outcomes in contracts and Web API client;
- key/fingerprint mismatch handling;
- explicit `useMutationKeys` transitions;
- result lookup/replay through the existing idempotency store;
- correct key retention for Task create/message and file commands.

Focused behavior checks:

- a Task message accepted before a simulated lost response produces one
  interaction after replay;
- a Task create committed before response loss returns the same Task;
- the same key with a changed fingerprint is rejected without changing the
  original operation.

User result: no false definitive failure and no duplicate action after Retry.

### Slice 2: Monotonic Task and Files presentation

Implement:

- the field ownership table in the Task and Terminal reducers;
- Task read epochs and exact Run fencing;
- one serialized canonical refresh after message admission;
- per-scope Files mutation intent ordering;
- stale list/detail response rejection.

Add one deterministic interaction interleaving check: a pending user message
becomes accepted between suppression capture and change-page read. If current
code already preserves the accepted revision, make no store change. If it
skips the revision, add the smallest snapshot-bound ProductStore read.

Focused behavior checks:

- an older Task GET cannot restore an active Run after Release state arrived;
- reverse-order post-message reads cannot remove the newer queue/interaction;
- Terminal local state cannot restore Connect or shell against canonical
  capability;
- an older directory response cannot undo a completed file mutation.

User result: visible Task, Terminal, and Files state does not jump backward.

### Slice 3: Exact runtime lifecycle

Implement:

- `202 accepted_in_progress` after durable Terminal-start reservation;
- one reconciler startup owner;
- atomic Run activation plus final Terminal-start receipt;
- `expectedRunId` on Release;
- persistent drain barrier plus process-local startup cancellation;
- exact Botified target identities for Abort and Stop;
- separate start-new-work and control-existing-work predicates;
- Terminal `1009` transport-intent termination.

Focused behavior checks:

- block Kubernetes apply and verify Terminal-start returns after reservation;
- restart the process and verify the same Run startup resumes once;
- Release during an unknown apply cannot activate the old fence and cannot
  record released until post-deadline enumeration is empty;
- a stale Release confirmation cannot release a newer Run;
- credential or endpoint drift does not prevent exact Abort/Stop;
- close `1009` disposes one transport and leaves one usable Connect action.

User result: startup, control, Release, and Terminal connection behavior match
the Task the user can see.

### Slice 4: File operation convergence

Implement:

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
| Botified boundary | `packages/ports/src/botified.ts` and its current adapter |
| Files | `fileService.ts`, `fileLibraryService.ts`, `recursiveDeletionService.ts`, Files pages |
| contracts/docs | `api-contract.md`, `sandbox-controller.md`, `botified-runtime.md` where behavior changes |

Do not move behavior into new packages merely to match this table. Follow the
current ownership boundary and add only exact store methods needed for atomic
commits.

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

## 11. Handoff Completion

The milestone is complete when:

- all commands in the matrix have one durable acceptance point, one typed
  outcome path, and one replay path;
- the Web retains unresolved command identity while the action is mounted,
  preserves Task-message identity with its existing draft, and never changes a
  retained command's payload;
- Task canonical state and Terminal local state have non-overlapping owners;
- focused out-of-order checks prove stale responses cannot regress the UI;
- Terminal start returns after reservation while external startup is blocked;
- Release targets `expectedRunId`, fences late activation, and keeps the drain
  barrier until a post-settlement/deadline observation confirms absence;
- Abort and Stop carry exact target identities through the Botified service
  API;
- Terminal close `1009` cannot produce shell/Connect oscillation;
- file replay never re-enters a recreated source path;
- obsolete competing implementations are deleted;
- no new governance layer, generic workflow, repository, or service exists.

No additional planning, evidence, release, or test-governance document is
required for development to begin.
