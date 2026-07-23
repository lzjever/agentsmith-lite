# AgentSmith Lite Reliable Task Runtime Milestone Plan

Status: handoff-ready next-milestone execution plan
Date: 2026-07-22
Applies to: `agentsmith-lite` and its deployment to the local single-node K8s
substrate

## 1. Authority And Document Relationship

This document is the execution authority for the next milestone only: make the
real Task runtime reliable, understandable, and recoverable on the local
single-node K8s environment. It is a development and refactoring plan, not a
roadmap, release plan, or verification report.

- `task-workspace-product-improvement-plan.md` remains the product-semantic
  source for File Libraries, persistent Tasks and Botified sessions, turns and
  Runs, explicit Sandbox release, Usage, and light Audit.
- This plan narrows those documents to the broken real runtime path and sets
  implementation order. Its sequencing takes precedence within this milestone.
- For this milestone, the final public names and compact enums in Section 6
  supersede old maintained-document uses of `taskLifecycle`, `turnState`, or
  their old values. Those documents must be updated in the same cutover; stale
  names are neither authority nor compatibility requirements.
- `architecture.md`, `api-contract.md`, `botified-runtime.md`,
  `sandbox-controller.md`, and `storage-and-files.md` describe the implemented
  system and must change with it. Stale text is not a compatibility contract.

The current-state statements below distinguish code that exists from behavior
accepted in the real local environment. This plan itself proves no completion.

## 2. Milestone Outcome

At completion, one authorized user can use this only supported local path:

```text
OIDC login
  -> Project + credential + endpoint
  -> exclusive File Library
  -> persistent Task and Botified session
  -> real DeepSeek-backed turns in a Sandbox Run
  -> Terminal, Files, and Artifact
  -> explicit Sandbox release
  -> cold-started next Run on the same Task/session/Library
  -> Usage and safe lifecycle Audit
```

The path remains usable after a comprehensible Sandbox failure and confirmed
cleanup. Each operation has one domain model and one implementation path. The
browser does not compensate for ambiguous server state.

First repair the real runtime behind the recent `Sandbox unavailable`; only
then remove the old dual state model so its branches do not obscure the first
failing boundary.

## 3. Current-State Assessment

Mainline already has the Web product surface, File Libraries and exclusive Task
binding, persistent Botified session intent, multiple messages, explicit
release/cold-start intent, Terminal, Usage, Audit, three public projections,
Task-derived session checks, and Run-fenced exact deletion. Botified is the
runtime and owns access to AgentSmith's loopback `bash-executor`.

This is inventory, not acceptance. The latest real Task reached
`Sandbox unavailable`; no current claim covers a complete DeepSeek turn,
multi-turn use, Terminal, files, artifacts, release, or cold restart. Trace the
first failed invariant across rendered config, Pod readiness,
Service/NetworkPolicy, Botified auth/state, broker routing, persisted identity,
and orchestration.

Active debt includes `AgentTaskStatus` work/terminal values; terminal,
finalization, Task-cleanup, successor, fixed-files, and TTL branches; and
maintained fixed Project `files/` documentation. Run failures can still look
like permanent Task failure. Large service files alone do not justify
extraction.

## 4. Product Invariants

1. One Task is one durable conversation/workspace: one persistent Botified
   session, one immutable exclusive File Library, multiple turns, and serial
   Sandbox Runs.
2. Session identity is derived from `taskId` and validated against Botified.
   Task title is never an identity or uniqueness key.
3. A Task has at most one active or unreleased Run. Every new Run gets a new
   Run ID and fence before resource creation.
4. Completing, failing, or stopping a turn does not complete, fail, release, or
   delete the Task. A completed turn returns an active Task to ready.
5. Explicit release stops current-Run work and deletes only that Run's
   app-owned resources. Task, completed history, session data, Library files,
   and artifacts remain.
6. After confirmed release, the next message or Terminal open starts a new Run
   on the same Task/session/Library. Interrupted and queued work does not resume.
7. Sandbox failure belongs to a Run, records a safe cause, persists release
   intent, and drives exact cleanup through the existing runtime tick. Confirmed
   cleanup alone permits normal same-Task cold start.
8. Provider plaintext enters only the AgentSmith credential write path. It
   never enters browser responses, Botified config, Task state, Audit, or
   application responses. Botified uses only the server broker.
9. Browser and AgentSmith server never call `bash-executor` directly. The
   browser calls only AgentSmith APIs; AgentSmith server calls only the Botified
   service API, including for proxied Terminal traffic; same-Pod Botified calls
   the AgentSmith-owned `bash-executor` over loopback.
10. Every confirmed released Run has exactly one Usage settlement from Pod
    Ready to confirmed release. A Run never reaching Pod Ready settles with
    `startedAt = null` and duration zero. An unreleased Run has live Usage only.
11. Release and deletion require complete app-owned workspace/project/task/run
    identity and the expected UID when known.
12. One feature has one implementation path. No parallel contracts, long-lived
    adapters, dual reads/writes, or speculative state-machine framework.

## 5. Scope And Non-Goals

### 5.1 In Scope

- Fix local Sandbox reachability across broker, Botified,
  Pod/Service/NetworkPolicy, JuiceFS, persisted identity, credentials, and
  readiness.
- Complete turns, Terminal, Library writes, artifacts, release, cleanup,
  cold restart, safe failure ownership, Usage, and Audit on one product path.
- Cut contracts, schema, stores, services, routes, UI, tests, and maintained
  docs to the final Task/Turn/Run model; delete conflicting active paths.
- Add focused checks for changed high-risk boundaries. Extract a responsibility
  only if converged code demonstrates a cohesive need.

### 5.2 Explicit Non-Goals

- Unrelated UI redesign, navigation, dashboard, or general polish.
- Cloud, hosted, multi-node, or non-local deployment support.
- Chat, successor Tasks, duplication, or a second conversation model.
- Automatic idle/max TTL, process-aware release, background scavenging, or
  configurable auto-release.
- Provider matrices/adapters, direct Botified provider credentials, file
  versions/templates/snapshots/restore, mounts, WebDAV, AFSCP, ASBCP, JVS, or
  project-wide fixed files.
- A new repo, service, controller, event bus, workflow engine, domain/state
  framework, or generic storage abstraction.
- Reports, evidence bundles, gates, rehearsals, committed screenshots, visual
  baselines, default Playwright suites, or process layers.
- Broad tests, test infrastructure, unrelated refactors, or full service,
  persistence, UI, Botified, or controller rewrites.

## 6. Final State Model

The final public state contract uses the actual field names `lifecycle`,
`currentTurn`, and `sandboxState`. This milestone removes old maintained
contract names such as `taskLifecycle` and `turnState`; no alias is retained.

### 6.1 Task Lifecycle

The Task is the durable user-owned object:

```text
active -> archived
active | archived -> deleted
```

- `lifecycle` is exactly `active | archived`; deletion is an operation or
  tombstone, not a live Task state. There is no unarchive operation.
- Ready, turning, released, and recovering are not lifecycle values.
- Active and archived Tasks may be deleted. Archive is rejected while a Run is
  active or owns any unreleased reservation.
- Archived Tasks are read-only: message, Terminal, or any other compute-start
  operation is rejected and cannot create a Run.
- Deletion releases the Library binding but not the Library. It must complete
  or persist exact Run-release intent before durable session removal.
- The Task row keeps identity, ownership, endpoint, immutable `fileLibraryId`,
  user fields, archive/delete timestamps, and only indispensable current-Run
  reservation data. It has no second work-status lifecycle.

### 6.2 Turn

A message stays on the same Task and Botified session. Current Turn derives
from durable delivery plus authoritative Botified state:

```text
ready
queued -> starting -> running -> completed
                            -> failed
                            -> stopped
                    -> aborting -> stopped
```

- `ready` means no active turn, not Task completion.
- Completed, failed, and stopped outcomes remain in typed conversation history;
  `currentTurn` then returns to `ready`.
- `currentTurn` is exactly
  `ready | starting | queued | running | aborting`. Completed, failed, and
  stopped are historical interaction results, not compact current values.
- Message idempotency, queue order, and Botified timeline cursors remain truth.
  The browser does not infer queue state and no second scheduler is added.
- Abort affects only the current turn, not the Run or unrelated typed work.

### 6.3 Sandbox Run

A Sandbox Run is replaceable compute for one Task:

```text
starting -> active -> release_requested -> released
        \-> failed -> release_requested -> released
active  \-> failed -> release_requested -> released
```

- A Task has zero or one unreleased Run and any number of released Runs.
- `starting` covers resource apply, Pod and Botified readiness, authenticated
  reachability, identity validation, and broker readiness.
- `active` enables turn and Terminal operations.
- `release_requested` is persisted and idempotent. Reservation remains held
  until exact resources are observed absent.
- `released` means confirmed absence. Only it settles Usage, frees capacity,
  and permits another Run.
- `sandboxState` is exactly
  `starting | active | release_requested | released | failed`.
- `failed` records a safe Run-owned cause, atomically persists release intent,
  and enters the same fenced release path. The existing runtime tick retries
  pending or failed cleanup attempts; no separate recovery worker or API exists.
- Same-Run recovery may resume unfinished work only before confirmed release.
  A new Run after release or failed-Run cleanup discards interrupted work.

The Run owns resource identity, readiness, safe failure, release intent,
cleanup lease/attempt/error, fencing, resource sizing, and timestamps.
Task-level cleanup and finalization fields do not survive.

### 6.4 Library And Session Identity

- Every non-deleted Task has one non-null immutable `fileLibraryId`, exclusive
  among non-deleted Tasks and in the same Workspace and Project.
- Files, artifacts, runtime mounts, and authorization resolve from that binding.
- Session identity is derived from `taskId`; no duplicate mutable name exists.
- Startup rejects a Botified session mismatch before message or Terminal use.
- HOME, Botified data, Library files, and artifacts live on JuiceFS outside
  replaceable Run resources. Run IDs and K8s names are not durable identity.

### 6.5 Failure Ownership

| Failure | Owner and result |
| --- | --- |
| Message, provider, or abort | Typed Turn outcome; Task returns to ready when idle. |
| Apply, readiness, network, Botified, identity, or runtime loss | Run failure; persist safe cause and request exact release. |
| Release/delete observation failure | Keep Run release intent and reservation; retry fenced cleanup. |
| File or Artifact operation | Return authorized path-scoped error; preserve Task and Run lifecycle. |
| OIDC, membership, credential, endpoint, or policy | Deny before runtime mutation with a safe product error. |

The UI renders server state and capabilities. It never converts a transport
timeout into Task failure or invents cleanup completion.

## 7. Change Boundaries

### 7.1 Server And API

- The server owns auth, Library binding, Run reservation/transitions,
  idempotency, capabilities, provider brokerage, Botified calls, Terminal,
  artifacts, release, Usage, and Audit.
- Keep one same-origin `/api/v1` path; add no compatibility API.
- Responses expose only `lifecycle`, `currentTurn`, `sandboxState`, safe errors,
  and server-calculated capabilities. Remove public Task status, terminal,
  finalization, and cleanup fields.
- Task creation requires an initial prompt and submits it through the same
  message path used by follow-ups. That path creates the first Run; there is no
  independent Start Task command or endpoint.
- Message send and Terminal open use one database transaction to create or
  reuse the unique `starting` Run reservation and fence. K8s/Botified startup
  occurs after commit and is not part of that transaction. Racing callers
  observe or wait for that same starting Run and never create a second Run.
- Pending or failed cleanup exposes only state plus `Retry release`, which
  calls the same idempotent `POST .../sandbox/release` endpoint. Normal message
  and Terminal cold start remain disabled until `sandboxState == released`.
- Distinguish starting, temporary unreachability, failed/cleanup-pending,
  released, and unauthorized states when the server knows the cause.

### 7.2 Storage And Migration

- Keep the existing PostgreSQL migration chain immutable, including old names
  and historical transitions. Never rewrite history to resemble the final
  schema.
- The only supported upgrade origins are a fresh database or the latest schema
  on `main` at milestone start, currently through migration `065`. This is a
  local-development cutover, not a production migration promise.
- Stop the app and runtime tick, then append and execute one transactional
  forward migration. A failed transaction leaves the database at its original
  schema and data state. After success, deploy or repair forward only; the old
  app is not a supported rollback target.
- The migration may discard incompatible local-development Task, message,
  interaction, artifact metadata, Run, runtime document, Usage settlement, and
  Task-owned Botified state. Preserve identity, Workspace, Project, membership,
  credential, endpoint, context, policy, alert, audit, and File Library rows,
  plus Library user files.
- Removing active `task_failure` and Task terminal lifecycle semantics does not
  delete existing alert, rule, or audit rows. Normalize `task_failure` alerts
  and rules to read-only `historical_task_failure`, resolve any active historical
  alert, and disable every historical rule while retaining its prior enabled
  state for display. Normalize terminal audit actions to
  `task.historical_terminal` and retain the prior action for display. These
  historical classifications are excluded from runtime evaluation and mutation
  and do not describe a current Sandbox failure.
- While the app remains stopped, pending migration `066` preflights every
  cleanup path, removes canonically labeled Sandbox resources with observed UID
  fences in live mode, confirms them absent, and then deletes only Project
  `tasks/` and each File Library `workspace/.artifacts`. Keep Library
  home/workspace user files and all other Project files. SQL, path, Kubernetes,
  or filesystem failure rolls the ledger transaction back; retries are
  idempotent, and an already-applied `066` never repeats the cutover.
- Remove obsolete Task status, terminal, finalization, and cleanup columns and
  constraints in that cutover. Do not add dual read/write, adapters, or
  compatibility transforms.
- Switch active logic, contracts, schema, stores, routes, UI, tests, and
  maintained docs together. Do not introduce a dual-read, dual-write, or
  long-lived adapter period.
- Keep release/cleanup state on Run, delivery state on message records, and
  artifact projection state with artifacts, never on Task lifecycle.
- Preserve Library foreign key, same-scope validation, and exclusive active
  binding.

### 7.3 Runtime And Sandbox

- Trace the first broken boundary from rendered inputs through Pod readiness,
  Service/NetworkPolicy, Botified health/auth, session state, and broker.
- The broker uses encrypted project credentials server-side. Botified receives
  only scoped service credentials, never the DeepSeek key.
- Use the real local DeepSeek configuration from `~/.zshrc`; do not commit
  secrets or add providers.
- Before active, validate `runtime.session == taskId`, Run fence, Library mount,
  broker reachability, and `resume_unfinished`.
- Cleanup uses exact labels, UID preconditions, Run fencing, and persisted
  explicit/deletion/failed-Run intent, never elapsed time.
- The existing runtime tick retries every persisted failed-Run or release
  intent until exact absence is confirmed; `Retry release` merely makes the
  same idempotent release request immediately eligible again.
- Keep `bash-executor` loopback-only. Browser and AgentSmith server never call
  it; only same-Pod Botified does. AgentSmith proxies Terminal through the
  Botified service API and browser code never calls Botified or K8s directly.

### 7.4 Web UI

- Keep current Files, Task, Terminal, Artifact, Usage, and Audit composition.
- Render server projections and capabilities; do not derive lifecycle or
  recovery permissions locally.
- Preserve loading, forbidden, retryable error, release-pending, released, and
  cold-starting states where affected.
- Show a safe server-owned cause and valid action instead of permanent-looking
  `Sandbox unavailable`; hide cleanup internals and K8s details.
- During pending or failed cleanup, show only the safe state and one
  `Retry release` action. Do not expose message, Terminal, or alternative
  recovery actions before confirmed release.
- Never expose provider/service secrets, raw runtime state, mount paths, or raw
  timeline data.

## 8. Old-Path Deletion Matrix

Delete only after real vertical behavior works and each final owner exists.

| Old active path | Delete | Final owner |
| --- | --- | --- |
| `AgentTaskStatus` work/terminal values | Public/store/service/UI status branches and tied tests | Task lifecycle, Turn projection, Run state |
| Terminal Task fields | `terminalReason`, `terminalizedAt`, guards and mappings | Turn outcome or safe Run failure |
| Finalization | Intent, claims, loop, timeline and cleanup branches | Turn completion to ready; separate Task delete |
| Task cleanup | Task cleanup fields, workers, selectors, capabilities | Run release intent and delete orchestration |
| Finalization artifact drain | Terminal drain ordering and compensation | Incremental artifact projection |
| Successor Task | Inputs, transactions, links, statuses, UI, tests | Same Task and derived session |
| Fixed Project `files/` | Routes, client/store selectors, snapshots, mounts, docs | Immutable Task File Library root |
| Runtime file transition | Fixed/Library fallback and dual reads | Historical migration only where required |
| Idle/max TTL | Fields, env, keepalive, selectors, reap, UI, tests | Explicit release/delete or failed-Run cleanup |
| Chat remnants | Changed-path imports, routes, and contracts | Task Conversation only |
| Compatibility path | Translators, aliases, fallback stores, legacy writes | One final concrete contract |
| Obsolete tests | Assertions protecting deleted behavior | Narrow final-state boundary tests |

Historical migrations remain untouched; the new migration removes only active
dependencies.

## 9. Vertical Phases

### Phase 1: Locate And Repair Real Runtime Reachability

Follow one OIDC-authenticated Task through Task ID, Run ID, labels, Pod,
Service/NetworkPolicy, Botified health/auth/state, and broker request. Fix the
first violated invariant in its owning layer. Do not delete the old state model
while the root cause remains unknown.

Exit when an identity-validated Run completes a real DeepSeek turn and startup
failure has a safe Run-owned category. Check generated identity, readiness
order, broker reachability, `session_id == taskId`, and secret exclusion.

### Phase 2: Stabilize The Existing Vertical Runtime

On the same domain path, fix multiple turns, abort, Terminal, Library files,
Artifact publish/download, release, failed cleanup, and cold start before state
refactoring.

Exit with serial turns, Library-confined Terminal/files, persistent artifacts,
exact release, settle-once Usage, failed cleanup retry, and same-Task cold start
that retains durable data but not interrupted work.

### Phase 3: Converge Contract, Logic, And Schema

Use the working behavior as reference. Move decisions and responses to Task,
Turn, and Run semantics, append the forward migration, then remove old active
fields and branches in the same coordinated cutover.

Exit with final contracts and capabilities, one new migration, final Web
projections, focused tests, and no terminal Task, finalization, Task cleanup,
successor, dual-read/write, adapter, or old public fields.

### Phase 4: Delete Conflicting Paths; Extract Only If Earned

Apply Section 8 across active code, tests, routes, clients, and maintained docs.
Exit with no active successor, fixed-files, terminal/finalization, Task cleanup,
TTL, Chat, compatibility, or dual-state path. Maintained docs describe File
Libraries and final runtime semantics. Extract only a cohesive boundary proved
necessary after deletion; historical migrations remain untouched.

### Phase 5: Accept The Final Local Product Path

Redeploy the converged implementation and run Section 11 once, serially, using
local Keycloak, PostgreSQL, JuiceFS/K8s, and DeepSeek. Fix failures in place,
then complete one primary pass; run focused checks separately only for changed
risks.

## 10. Deliverables

Deliver repaired runtime and deployment logic, final contracts/stores/schema/UI,
focused tests, maintained docs, and deletion of conflicting paths. Reports,
evidence, generated checklists, gates, wrappers, and broad suites are not
deliverables.

## 11. Local Single-Node K8s Acceptance

### 11.1 Primary Real Product Pass

Run one serial real product path using local Keycloak, PostgreSQL,
S3-compatible storage/JuiceFS CSI, K8s, the app deployment, and the configured
DeepSeek OpenAI-compatible endpoint:

1. Sign in with Keycloak/OIDC and enter an authorized Project.
2. Create or rotate a Project credential without plaintext in read responses;
   create an endpoint bound to it.
3. Create and browse a File Library and upload a recognizable file. Create a
   Task exclusively bound to it with an initial prompt; Task creation must use
   the unified message path to reserve Run 1 and return a real DeepSeek response
   through AgentSmith broker to Botified. There is no separate Start Task step.
4. While Run 1 is active, confirm archive is rejected. Send a follow-up and
   confirm the same Task, Botified session, Library, Run, and completed history.
5. Use Terminal through AgentSmith, write/read a Library file, list it in Files,
   and publish then download an Artifact.
6. Start a turn, long Terminal command, or background work and leave it running.
   Explicitly release Run 1. Confirm only that Run's exact app-owned resources
   are absent while Task, history, files, and Artifact remain.
7. Send another message or open Terminal. Confirm cold-started Run 2 uses the
   same Task/session/Library and history, while the interrupted Run 1 work does
   not resume.
8. Before releasing Run 2, inspect its live Usage and confirm no settlement
   exists for it. Release Run 2, then confirm each released Run has exactly one
   settlement from Pod Ready to confirmed release.
9. Archive the released Task. Confirm the transition is one-way, the archived
   Task is read-only, and message, Terminal, and all compute-start operations
   cannot create another Run.
10. With another Task and Library containing a recognizable user file, delete
    that Task. Confirm delete reuses the exact fenced release path, clears the
    Task-to-Library binding, and preserves the Library row and user file.
11. Confirm Audit contains only allowlisted safe lifecycle metadata and no
    content, tokens, credentials, or runtime internals.

For any Run that never reached Pod Ready, its one settlement after confirmed
release must have `startedAt = null` and duration zero. Active Runs expose only
the live value and never have a settlement.

### 11.2 Focused Boundary Checks

Select the smallest direct checks for high-risk behavior changed by this
milestone. They are separate from the primary pass and need not all use real K8s
failure injection:

- Concurrent message and Terminal calls observe or wait for one transactionally
  reserved `starting` Run and one fence; they never create a second Run.
- Unauthorized users cannot access Task, Library, Terminal, Artifact, release,
  member Usage, or Audit; cross-Project and already-bound Libraries are rejected.
- Two Tasks cannot share session, Library root, Run ID, service credential, or
  K8s identity.
- Incomplete or mismatched identity/UID never deletes a resource, and one Run's
  release never mutates another.
- Provider plaintext is absent from browser payloads, product logs/Audit,
  Botified environment/config, and persisted runtime/Run JSON.
- Startup failure is Run-owned, persists release intent, and is not a terminal
  Task state. The runtime tick retries cleanup, while repeated
  `POST .../sandbox/release` calls are idempotent.
- Pending or failed cleanup retains its reservation and exposes only state plus
  `Retry release`; message and Terminal cold start wait for confirmed absence.
- Provider or turn failure records a historical interaction outcome and leaves
  a healthy Run usable with `currentTurn == ready`.
- API restart during starting, active, release-pending, or cleanup retry
  reconstructs one projection without a duplicate Run or Usage settlement.
- A fresh database and a stopped-app upgrade from schema `065` reach the same
  final schema; a forced migration transaction failure leaves the original
  schema and preserved data unchanged.

Acceptance requires neither mechanical repetition nor a visual baseline,
cloud run, report, evidence directory, generated record, or broad fault suite.

## 12. Test Discipline

- Source TSX/JSDOM tests are absolutely prohibited for this milestone.
- Add the smallest unit, contract, store, or behavior test for each changed
  dangerous rule; prefer pure projection and fake-port tests.
- Use PostgreSQL integration only where migration, exclusive binding,
  one-active-Run transition, or settle-once behavior cannot be proven in memory.
- Every pure TypeScript test command must run serially from its explicit working
  directory in exactly one `systemd-run --user --scope` with
  `MemoryMax=512M`, `MemorySwapMax=0`, `TasksMax=24`,
  `NODE_OPTIONS=--max-old-space-size=256`, and test concurrency `1`.
- Do not add a default Playwright suite or visual baseline. Any browser use for
  the real product path is transient and scheduled serially.
- Delete tests whose only purpose is removed status, successor, fixed-files,
  TTL, or compatibility behavior.
- Checks print to stdout/stderr and fail non-zero. Do not test wrappers, plans,
  prose, artifacts, or test infrastructure.

## 13. Resource Discipline

- A team coordinator may delegate static inspection or mutually non-conflicting
  implementation work in parallel.
- Worker agents must not spawn subagents.
- All tests, builds, browser work, PostgreSQL work, image work, containers, and
  K8s operations are strictly serial and never overlap with one another.
- Start with lightweight source/config/state inspection and use real K8s only
  for boundaries unavailable below it.
- Run the smallest selected check after a changed risk, then one serial primary
  product pass after deployment.
- Never retry an OOM-killed command unchanged; reduce scope or memory first.
- Do not create diagnostic services, temporary repos, command wrappers,
  reports, or evidence artifacts.

## 14. Handoff

1. Runtime owner follows the failing Task to the first broken boundary and
   hands off repaired code/config plus the exact safe server state.
2. Product-path owner completes turns, Terminal, Files, Artifact, release,
   failed cleanup, and cold restart on that implementation.
3. Contract/store owner converges Task/Turn/Run semantics, appends the migration,
   and deletes old active fields and branches without dual behavior.
4. UI/docs owner removes stale consumers and wording using only final server
   projections and capabilities.
5. Local deployment owner redeploys, runs the serial primary acceptance path
   and selected focused boundary checks, and fixes failures in their owning
   layer.

Every handoff preserves unrelated concurrent changes and identifies changed
files. Handoff state is working code, not a new report or repository artifact.

## 15. Completion

The milestone is complete only when:

- one real local OIDC user completes the Section 11 primary product pass with
  DeepSeek;
- one Task reliably spans turns and serial Runs with one derived, validated
  Botified session and immutable exclusive Library;
- Terminal, Library files, and Artifacts work through AgentSmith and survive
  explicit release;
- release and failed-Run cleanup delete only exact app-owned resources, settle
  Usage once, and permit cold restart without interrupted work;
- Task lifecycle, Turn, and Run are the only active business state semantics;
  terminal/finalization/Task-cleanup/successor fields and branches are gone;
- provider plaintext remains server-only, Botified uses only the broker, and
  `bash-executor` is called only by same-Pod Botified over loopback;
- permission, isolation, restart, and recovery behavior is correct;
- active code and maintained docs contain no fixed Project files, successor
  Tasks, automatic TTL, Chat, or compatibility path, while historical
  migrations remain intact; and
- only milestone product code, schema, APIs, UI, focused tests, and maintained
  docs changed, with no unrelated redesign, framework, provider/cloud path,
  report, evidence artifact, gate, or rehearsal.
