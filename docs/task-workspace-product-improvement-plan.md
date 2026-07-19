# AgentSmith Lite Task Workspace Product Improvement Plan

Status: handoff-ready

Date: 2026-07-19

Applies to: `agentsmith-lite`

This is the authoritative implementation plan for Task conversation, File
Libraries, Botified sessions, Sandbox lifecycle, Sandbox usage, and the related
Web experience. Where older documents describe a fixed project `files/` tree,
successor Tasks for follow-up messages, terminal Task completion after one
agent turn, idle TTL, automatic Sandbox reclamation, or deletion of Task HOME
and Botified state during Sandbox release, this plan supersedes them.

## 1. Product Decision

AgentSmith Lite keeps four different product objects instead of treating one
agent response or one Pod as the whole Task:

```text
Project
  -> many File Libraries

Task
  -> exactly one Botified session
  -> exactly one exclusively bound File Library
  -> many conversation turns
  -> many sequential Sandbox Runs

Sandbox Run
  -> zero or one current Kubernetes Pod
  -> explicit start and release timestamps
  -> one usage settlement
```

The durable user object is the Task. A Botified turn can finish, fail, or be
stopped without finishing the Task. A Sandbox can be released and recreated
without changing the Task, Botified session identity, conversation history, or
File Library binding.

There is no automatic idle or maximum-lifetime reclamation policy. A healthy
Sandbox remains allocated until an authorized user explicitly releases it or
deletes the owning Task or Project. The release confirmation is unconditional:
AgentSmith does not inspect the agent, terminal, or process list before acting.

## 2. Outcomes

### 2.1 User outcomes

- A Task is one continuous conversation. Sending a follow-up never creates a
  hidden or linked successor Task.
- Every Task has an isolated persistent workspace represented by one File
  Library. The Library can be created with the Task or selected from an
  authorized, currently unbound Library.
- The Files page lists the current user's accessible Libraries in the current
  Project and browses the selected Library instead of exposing one shared
  project directory.
- A completed agent reply leaves the Task ready for another message.
- A user can release the current Sandbox after one generic warning. Release
  immediately stops the agent, terminals, tools, and all processes; unsaved
  work may be lost.
- Sending the next message or opening Terminal recreates a Sandbox for the same
  Task, mounts the same Library, and resumes the same Botified session.
- Users can see their Sandbox launches, active allocation, runtime, and
  request-based CPU and memory usage. Project administrators can inspect the
  same facts by user and Task through Usage and light Audit.

### 2.2 Engineering outcomes

- One Task identity, one Botified session identity, one File Library binding,
  one message path, and one Sandbox release path.
- Server-owned authorization, lifecycle, idempotency, usage settlement, and
  Botified/Kubernetes calls. Web remains an AgentSmith API client.
- JuiceFS stores durable Library and Task session data. Kubernetes resources
  are replaceable compute, not Task identity.
- Existing app-owned labels, UID checks, run fencing, Botified delivery keys,
  typed interactions, and targeted resource deletion are reused where they
  serve these product paths.
- Obsolete successor, fixed-tree snapshot, automatic TTL, and Task-finalization
  branches are deleted rather than hidden behind compatibility code.

## 3. Scope Boundaries

### 3.1 Included

- Project-scoped File Library CRUD and authorized Library selection.
- File list, directory browsing, upload, safe preview, download, and delete.
- Atomic Task creation with `create_new` or `use_existing` Library mode.
- Exclusive Task-to-Library binding and release on Task deletion.
- Durable multi-turn Task conversation through the Botified service API.
- On-demand Sandbox start and explicit unconditional Sandbox release.
- Persistent Task HOME, Botified session, files, and published artifacts.
- Interactive browser Terminal through AgentSmith and the AgentSmith-owned
  `bash-executor` sidecar.
- Sandbox Run usage settlement and minimal Usage/Audit presentation.
- Existing project membership, resource policy, alert, endpoint, and OIDC
  boundaries where they authorize or account for this path.

### 3.2 Excluded

- Library templates, task file templates, versions, savepoints, restore, and
  history browsers.
- JVS, AFSCP, ASBCP, WebDAV, local mount, remote mount, sync daemon, storage
  provider setup UI, and storage credential exposure.
- Cross-Project Library binding or a global personal file store.
- Multiple Libraries bound to one Task or one Library concurrently bound to
  multiple Tasks.
- Automatic idle detection, process inspection, terminal-aware TTL, maximum
  Sandbox lifetime, scheduled reclamation, or user-configurable auto-release.
- Successor Tasks, execution-boundary interactions, follow-up Task chains, and
  automatic Task duplication.
- Browser access to Botified, Kubernetes, JuiceFS internals, provider secrets,
  or raw timeline NDJSON.
- A new repository, deployable file service, sandbox control plane, event bus,
  compatibility adapter, report, evidence bundle, rehearsal, or release gate.

Project Chat remains a direct OpenAI-compatible conversation without Sandbox,
tools, File Library binding, or Task lifecycle.

## 4. Domain Model and Invariants

### 4.1 File Library

`FileLibrary` is a first-class persistent Project resource:

```text
id
workspaceId
projectId
name
rootSubPath
createdByUserId
createdAt
updatedAt
```

Lite creates Library directories synchronously on the existing Project JuiceFS
PVC. Do not introduce an asynchronous provisioning state machine. A failed
filesystem operation fails the current request and is repaired in place.

Required invariants:

- Library IDs and names are unique within a Project; names are user-facing and
  may be renamed, while IDs and `rootSubPath` are immutable.
- A Task and its Library belong to the same Workspace and Project.
- `Task.fileLibraryId` is the only binding truth. Library responses derive
  bound status and the optional visible Task link from Tasks; do not duplicate
  `boundTaskId` in the Library row.
- A partial unique database constraint on non-deleted Tasks, not a Web filter,
  prevents concurrent binding of one Library to two Tasks.
- Project membership authorizes Library access. The Files API returns only
  Libraries the current user can access in the current Project.
- Task creation with an existing Library requires both Task-create and
  File-write capability because the agent will modify that Library.
- Archive keeps the binding. Task deletion releases it and keeps Library
  contents. A bound or non-empty Library cannot be deleted.

### 4.2 Task

The Task is a durable conversation/workspace, not a single agent cycle.

Required Task fields include immutable `fileLibraryId`. Botified session ID is
always derived from `taskId`; do not persist or return a duplicate `sessionId`
field. A user-editable title is never an identity or uniqueness key. Runtime
startup still verifies Botified reports the expected Task ID.

Task product lifecycle:

```text
active <-> archived
active|archived -> deleted
```

Agent turn and Sandbox states are separate projections. Do not overload Task
status with `starting`, `completed`, `expired`, `cleaned`, or Pod cleanup state.
The Task detail may summarize current activity, but business decisions use the
separate records below.

### 4.3 Turn and message

A user message creates one durable message/delivery record under the same Task.
Botified decides whether it starts immediately or enters its queue.

Turn projection:

```text
queued -> running -> completed
                  -> failed
                  -> stopped
```

Rules:

- `cycle.completed` completes a turn and returns the Task to ready; it never
  completes the Task.
- Follow-up messages always target the Task's stable Botified session.
- Messages submitted while a turn runs use Botified's normal queue and remain
  in the same conversation.
- `Stop current turn` aborts only current work and keeps the Sandbox allocated.
- Message delivery keeps existing idempotency key, request hash, receipt query,
  and cursor reconciliation behavior.
- Retry resubmits a failed/stopped message in the same Task only when exposed by
  a server capability. Duplicate Task is not part of this plan.

### 4.4 Sandbox Run

A Task has at most one non-released Sandbox Run. Every cold start creates a new
Run ID and fencing generation while preserving Task, session, and Library IDs.
The existing active-Task resource reservation becomes an active-Sandbox
reservation: reserve it before creating a Run and release it only after that
Run's resources are confirmed absent. Persistent Tasks with released Sandboxes
do not consume Sandbox concurrency.

```text
starting -> active -> release_requested -> released
        -> failed -> release_requested -> released
```

`failed` records the failure fact but is not a durable resource terminal state.
AgentSmith immediately drives the failed Run through the same exact-resource
release implementation. Only confirmed `released` frees the active-Sandbox
reservation, settles Usage, and permits another Run. `sandbox.failed` remains a
light Audit fact; it does not terminalize the Task.

There is no `idleExpiresAt`, automatic `expiresAt`, or TTL-driven transition.
Operational reconciliation may finish a persisted release/delete intent or
remove a fenced resource already known to be orphaned; it must never decide to
release a healthy active Sandbox on its own.

### 4.5 Usage settlement

Each Run produces at most one immutable Sandbox usage settlement:

```text
runId
workspaceId
projectId
taskId
fileLibraryId
startedByUserId
podReadyAt
resourceReleasedAt
durationSeconds
cpuRequestMilli
memoryRequestBytes
cpuLimitMilli
memoryLimitBytes
releaseReason
createdAt
```

`durationSeconds` runs from the first observed Pod Ready time to confirmed
resource deletion. Pending scheduling time is not runtime. Idle time is counted
because the user chose to keep the Sandbox allocated. Settlement is idempotent
by `runId` and is computed by the server, never the browser.

Usage queries combine immutable settlements for released Runs with a live value
for the current active Run calculated as `now - podReadyAt`. CPU and memory
request-time use the same live interval. Do not add periodic usage writes,
snapshots, or a statistics job. Once release settlement exists, aggregation
uses it instead of the live Run so the interval is counted exactly once.

## 5. Durable Storage Layout

Use the existing JuiceFS PVC and keep storage ownership visible in paths:

```text
projects/<projectId>/
  libraries/<libraryId>/home/
    workspace/
      .artifacts/
  tasks/<taskId>/
    botified/
```

Sandbox mounts:

```text
/workspace/task/home      -> libraries/<libraryId>/home
/workspace/task/botified  -> tasks/<taskId>/botified
```

Botified uses:

```text
runtime.cwd      = /workspace/task/home/workspace
runtime.data_dir = /workspace/task/botified
runtime.session  = <taskId>
```

The Files page browses the selected Library HOME. Botified session state is not
inside the Library and is not visible through Files. Published artifacts live
under `workspace/.artifacts/`, are indexed by AgentSmith, and are accessible
through the authorized Task artifact API.

Sandbox release deletes no path above. Task deletion removes Task-owned
Botified state and releases the Library binding but leaves the Library. Library
deletion removes only its own unbound, empty directory.

## 6. Server-owned Product Flows

### 6.1 Create a File Library

1. Authorize Project File-write capability.
2. Normalize and validate the name.
3. Reserve the Library row and immutable root path.
4. Create its JuiceFS directory with path containment and no symlink traversal.
5. Return the authorized Library projection.

If persistence or directory creation fails, remove only the unused directory or
row created by this request. Do not add recovery reports or a provisioning job.

### 6.2 Create a Task

The final request accepts exactly one workspace mode:

```json
{
  "title": "Investigate the issue",
  "prompt": "...",
  "endpointId": "endpoint_...",
  "fileLibrary": {
    "mode": "create_new",
    "name": "Investigate the issue workspace"
  }
}
```

or:

```json
{
  "title": "Continue the analysis",
  "prompt": "...",
  "endpointId": "endpoint_...",
  "fileLibrary": {
    "mode": "use_existing",
    "id": "flib_..."
  }
}
```

The server atomically creates or claims the Library binding with Task
persistence. It then creates the first Sandbox Run, starts Botified with
`session=<taskId>`, and sends the initial prompt through the same message path
used by all later turns.

Do not retain `inputPaths`, project-file snapshots, manifests, or an alternate
initial-input flow. The bound Library is the Task workspace.

### 6.3 Continue a Task

1. Persist the user message under the existing Task.
2. If the Sandbox is active, deliver to the current Botified service.
3. If no Sandbox is active, atomically create a new Run and start it with the
   same Library mount, Botified data directory, and `session=<taskId>`.
4. Verify `/v1/state.session_id` equals the expected Task ID before delivery.
5. Query or resend by delivery key using the existing durable receipt contract.
6. Stream and persist typed interactions into the same conversation.

Concurrent follow-ups serialize through the Task message and Run fences. They
must not create another Task or another active Sandbox.

### 6.4 Release a Sandbox

Public API:

```text
POST /api/v1/tasks/{taskId}/sandbox/release
```

The operation is idempotent and server-owned:

1. Authorize Task interaction capability.
2. Persist `release_requested` with actor, Run ID, and a new fence. Stop new
   delivery to that Run.
3. Best-effort ask Botified through its service API to stop active work. Failure
   or timeout never blocks resource deletion.
4. Close AgentSmith Terminal connections for the Run.
5. Delete all app-owned resources carrying the exact Task/Run labels and
   expected UIDs. This terminates Botified, bash-executor, terminals, tools,
   background jobs, and child process groups unconditionally.
6. Confirm resource absence, mark the Run released, and settle usage once.
7. Return the Task as ready with `sandboxState=released`.

Release persists the released Run ID as a Botified termination boundary. The
next Run starts Botified with a direct `resume unfinished work` decision:
ordinary recovery of the same Run resumes unfinished work, while the first Run
after an explicit release marks prior active/queued work stopped and starts
idle before AgentSmith sends new input. If the pinned Botified release lacks
this startup contract, add the smallest compatible runtime option to Botified
and pin the resulting release. Do not rewrite session JSONL from AgentSmith and
do not add a compatibility adapter.

The Web never asks whether work is running. It displays one confirmation:

> Release this sandbox? This immediately stops the agent, terminal sessions,
> and all running programs. Unsaved work may be lost. Conversation history and
> files already written to the task library will be kept.

### 6.5 Delete a Task

Task deletion uses the same exact-Run resource deletion implementation when a
Sandbox exists, then removes Task messages, interactions, artifact metadata,
and Botified state and releases the Library binding. It does not delete Library
files. Delete is an explicit user action and is not an automatic reclamation
path. Its confirmation includes the same warning that agent, Terminal, and
running programs will stop and unsaved work may be lost.

Archive is intentionally different: reject Archive while a Sandbox is active
and direct the user to `Release sandbox` first. Archive keeps the Library
binding and Task/session data. An archived Task cannot send messages, cold-start
a Sandbox, or open Terminal until it is restored to active.

Project deletion uses the same release implementation for each exact active
Run, with the same destructive-work warning in its confirmation. Do not create
a second cleanup path for Task or Project deletion.

## 7. Final API Surface

Keep names idiomatic to the existing `/api/v1` contract; do not add an adapter
or parallel version.

### File Libraries

```text
GET    /api/v1/projects/{projectId}/file-libraries
POST   /api/v1/projects/{projectId}/file-libraries
PATCH  /api/v1/projects/{projectId}/file-libraries/{libraryId}
DELETE /api/v1/projects/{projectId}/file-libraries/{libraryId}

GET    /api/v1/projects/{projectId}/file-libraries/{libraryId}/files
PUT    /api/v1/projects/{projectId}/file-libraries/{libraryId}/files
GET    /api/v1/projects/{projectId}/file-libraries/{libraryId}/files/download
DELETE /api/v1/projects/{projectId}/file-libraries/{libraryId}/files
```

Library list projections include only safe fields plus server-computed
capabilities and, when authorized, a compact bound Task link.

### Tasks and Sandbox

```text
POST /api/v1/projects/{projectId}/tasks
POST /api/v1/tasks/{taskId}/messages
POST /api/v1/tasks/{taskId}/turn/abort
POST /api/v1/tasks/{taskId}/sandbox/release
GET  /api/v1/tasks/{taskId}/interactions
GET  /api/v1/tasks/{taskId}/terminal
```

Task detail exposes separate server projections:

- `taskLifecycle`: `active | archived`
- `turnState`: `idle | queued | running | stopping | failed`
- `sandboxState`: `starting | active | releasing | released | failed`
- capabilities such as `sendMessage`, `abortTurn`, `openTerminal`,
  `releaseSandbox`, `archiveTask`, and `deleteTask`

`archiveTask` is false while a Sandbox exists. Sending messages and opening
Terminal are false while the Task is archived.

Remove `successor_pending`, `successor_created`, `targetTaskId`, and
`execution_boundary` from message and interaction contracts.

### Usage and Audit

Extend the existing Project Usage endpoint rather than creating a second
dashboard API. Default scope is the current user's usage; Project admins may
select an authorized member.

Usage fields:

- active Sandboxes
- Sandbox launches
- Sandbox runtime seconds
- CPU request-seconds
- memory request-byte-seconds
- per-Task/per-Run rows for the selected period

Rename active-Task capacity to active-Sandbox capacity throughout policy,
alerts, errors, and UI. Enforce it when a Run starts, including cold start after
release, rather than when a persistent Task merely exists.

Light Audit adds only `sandbox.started`, `sandbox.released`, and
`sandbox.failed`. Safe details may include Task, Library, Run, actor, timestamps,
duration, release reason, and resource requests/limits. Never include prompt,
conversation, file contents, environment values, credentials, service keys, or
Kubernetes Secret data.

## 8. Web Experience

### 8.1 Files

Restore and adapt the original AgentSmith Library-and-browser composition:

- Library list/selector and create action on the left or in the responsive
  mobile selector.
- Selected Library contents in the main browser.
- Create, rename, and delete actions based on server capabilities.
- Bound status and a Task link when the current user may see that Task.
- Normal, loading, empty, forbidden, request-error, upload-conflict, preview,
  and delete-confirmation states.
- `?libraryId=` may retain selection; no locale path or localization runtime.

Copy and simplify these reference sources instead of redesigning them:

- `.reference/agentsmith/src/components/files/FilesPage.tsx`
- `.reference/agentsmith/src/components/files/files-page/FilesLibrariesPane.tsx`
- `.reference/agentsmith/src/components/files/files-page/FilesBrowserPane.tsx`
- `.reference/agentsmith/src/components/files/FileObjectDetailsPanel.tsx`
- `.reference/agentsmith/src/lib/api/endpoints/file-libraries.ts`
- `.reference/agentsmith/src/lib/api/endpoints/files.ts`

Do not copy version, template, savepoint, restore, recovery, mount, i18n, mock,
or old control-plane dependencies.

### 8.2 Task creation

Adapt the original Task workspace selector with two choices only:

- `Create new library` (default), with an editable generated name.
- `Use existing library`, listing authorized unbound Libraries.

Remove template and developer-runner modes. Preserve the Task title, prompt,
endpoint selection, field errors, loading, conflict refresh, and submit state.
The Web submits the selected mode; the server makes every authorization and
binding decision.

Reference:

- `.reference/agentsmith/src/components/agent-tasks/TaskCreateDialog.tsx`
- `.reference/agentsmith/packages/contracts/src/index.ts` workspace-mode matrix

### 8.3 Task detail

The primary experience is one continuous Conversation with Terminal and
Artifacts as supporting views. Do not display cleanup internals or multiple
contradictory status banners.

- Header shows Task title and one concise activity summary.
- Completed turns leave the composer enabled and status `Ready`.
- Follow-up messages and replies appear in place in the same timeline.
- Remove `Continued in new execution`, linked successor actions, terminal Task
  finalization after a reply, and expected-cleanup connectivity warnings.
- `Release sandbox` appears only when server capability permits it.
- Released state says that files and conversation are retained and that the
  next message or Terminal open will start a Sandbox.
- Archive with an active Sandbox is rejected with a direct instruction to
  release it first; archived Tasks expose restore but no message/Terminal start.
- Release confirmation uses the generic warning in section 6.4 and never runs
  a process inspection request.
- Terminal open cold-starts the Sandbox if needed, then connects through
  AgentSmith. Web never connects directly to bash-executor or Botified.

### 8.4 Usage and Audit

Extend the retained pages in place:

- Usage adds Sandbox summary metrics and Task/Run rows alongside provider and
  file usage.
- Current users see their own usage. Admins can select a Project member.
- Audit uses the existing filter/table/detail drawer for Sandbox lifecycle
  events. Do not add an operations dashboard, report export, or evidence page.

## 9. Code Change Map

### 9.1 Reuse and adapt

- `packages/application/src/fileService.ts`: make every path resolve from an
  authorized Library root instead of Project `files/`.
- `packages/application/src/taskService.ts`: keep Botified delivery,
  interaction projection, artifact authorization, Terminal proxy, and exact
  Run fencing; replace Task terminalization, successor, snapshots, and cleanup
  semantics.
- `packages/application/src/sandboxLifecycleService.ts`: retain exact
  app-owned resource deletion and cleanup fencing as an implementation helper
  for explicit intents; remove time-based release decisions and durable data
  deletion.
- `packages/sandbox-controller`: retain manifest rendering, resource identity,
  UID-safe deletion, and single active Run reconciliation.
- `packages/botified-runtime`: retain OpenAI-compatible config and
  `session=taskId`; update cwd/data paths and direct stop-and-discard support.
- `packages/bash-executor`: retain loopback-only execution; ensure every child
  process group is terminated when its owning execution or Pod ends.
- Existing project membership, policy, usage, alert, and audit services remain
  the only authorization/accounting path.

### 9.2 Delete

- `prepareSuccessorCreate`, terminal-message successor creation, linked Task
  finalization, successor store transactions, and cleanup compensation.
- `execution_boundary` interaction and Web renderer.
- `successor_pending`/`successor_created` statuses and audit details.
- Task completion triggered by Botified `cycle.completed`.
- `inputPaths`, project input selection UI, snapshot manifests, retained-input
  copying, and project-wide fixed `files/` assumptions.
- `removeTransientTaskRuntime` behavior that removes HOME or Botified state
  during Sandbox release.
- idle-expiry refresh, terminal keepalive, `idleExpiresAt`, max-lifetime expiry,
  TTL Task expiration, automatic active-Run cleanup selection, and related env
  variables.
- UI text such as `Cleaning sandbox`, `Finalizing task run`, and expected
  `runtime temporarily unreachable` warnings during normal release.
- Tests whose only purpose is enforcing any deleted behavior. Do not rewrite
  them as compatibility or migration tests.

### 9.3 Add narrowly

- File Library contracts, table/store methods, service methods, routes, and UI.
- `fileLibraryId` as the sole Task binding truth and its partial uniqueness
  constraint.
- explicit Sandbox release command and current-Run capability.
- durable Run termination boundary for Botified restart.
- one Sandbox usage settlement row per Run and aggregate queries in existing
  Usage.
- three allowlisted Sandbox Audit actions.

Do not add generic repositories, workflow engines, event sourcing, state
machine frameworks, background job platforms, or policy DSLs for this work.

## 10. Data Migration

This product has no production cloud deployment or customer data. Use one
direct local schema/data transition instead of carrying legacy runtime behavior:

1. Add File Library and Sandbox usage settlement tables and Task binding fields.
2. For each existing Project, create one `Project files` Library and move the
   current `files/` contents into its HOME workspace.
3. Remove existing development Task, Sandbox Run, interaction, artifact, and
   Task idempotency data because their successor/snapshot/terminal semantics are
   incompatible with the new model.
4. Delete obsolete columns and statuses after the application uses the final
   contract. Do not keep dual reads, dual writes, backfill workers, or legacy
   API fields.

The migration preserves identity, Workspace, Project, membership, endpoint,
credential, context, chat, policy, and Project file content. It may discard only
local development Task runtime data whose semantics are being replaced.

## 11. Implementation Order

Each phase is a complete server-plus-Web product slice. Keep one database
migration sequence and one final contract; do not stage adapters.

### Phase 1: File Library foundation and Files experience

- Add Library persistence, uniqueness, authorization, synchronous JuiceFS
  directory ownership, CRUD, and Library-scoped file APIs.
- Copy and adapt the original Library selector and Files browser.
- Move existing Project files into the generated default Library.
- Delete fixed Project `files/` APIs and UI once all callers use Library IDs.

Focused checks: create/list/rename/delete authorization; bound/non-empty delete
rejection; binary upload/download; traversal/symlink rejection; two Libraries
do not see each other's files; Files desktop/mobile selection behavior.

### Phase 2: Task binding and persistent workspace

- Add atomic `create_new` and `use_existing` Task creation.
- Mount the selected Library HOME and separate Task Botified data path.
- Replace `inputPaths` and snapshots with the Library workspace.
- Adapt Task creation UI and Task detail Library link.

Focused checks: concurrent binding conflict; unauthorized Library rejection;
new/existing Library creation; Task deletion releases but preserves Library;
Archive retains binding; Sandbox reads and writes the selected Library only.

### Phase 3: One Task, one Botified session, many turns

- Separate Task, Turn, and Sandbox projections.
- Keep `session=taskId` across Runs and validate Botified state identity.
- Deliver every follow-up to the same Task/session.
- Remove successor contracts, persistence, interactions, UI, and old tests.
- Keep current-turn abort as a separate non-releasing operation.

Focused checks: two Tasks never share conversation context; multiple turns stay
on one Task; active-turn queue ordering and duplicate delivery; refresh/API
restart recovery; turn completion leaves Task ready.

### Phase 4: Explicit Sandbox release and cold restart

- Remove idle/max-lifetime configuration and automatic release decisions.
- Add the explicit idempotent release endpoint, capability, confirmation, exact
  resource deletion, and released state.
- Add the Botified startup contract that prevents interrupted/queued work from
  restarting after a confirmed release while retaining normal same-Run crash
  recovery.
- Cold-start on next message or Terminal open with the same Library/session.

Focused checks: release while idle, during agent work, with an open Terminal,
and with a long command; repeated release; release K8s failure/retry; no other
Task resources touched; persisted files and completed conversation survive;
old unfinished work does not resume; failed Runs settle and release capacity;
Archive is blocked while active and disabled while archived.

### Phase 5: Sandbox Usage and light Audit

- Capture Pod Ready and confirmed release timestamps and settle each Run once.
- Move active capacity reservation/enforcement from persistent Tasks to active
  Sandbox Runs.
- Aggregate current-user and admin-selected-member metrics in existing Usage.
- Add the minimal lifecycle Audit actions and safe details.
- Attribute a cold-start Run to the user who triggered it.

Focused checks: runtime excludes scheduling time, includes idle allocation,
includes the live active interval without a periodic writer, settles once
across retry/restart, attributes Runs correctly, admin/member authorization,
and never exposes secret or content fields.

### Phase 6: local single-node K8s product pass

Use the existing local deployment and a real OpenAI-compatible DeepSeek
endpoint. Serially exercise:

1. OIDC login and Project membership.
2. Create two Libraries and upload distinct files.
3. Create one Task with a new Library and another with an existing Library.
4. Complete multiple turns in each Task and confirm isolated context.
5. Write files and publish/download an artifact from the bound Library.
6. Open Terminal, run a command, confirm release, and observe unconditional
   termination.
7. Send another message and verify the same conversation and files resume in a
   new Sandbox Run.
8. Inspect the user's Sandbox usage and the administrator's Audit entries.

Fix failures in place. Do not generate a run report, evidence directory,
screenshots repository, rehearsal, or release gate.

## 12. Testing Discipline

- Add the smallest unit/contract/behavior tests that protect changed product
  logic and destructive resource boundaries.
- Use PostgreSQL integration tests only for atomic Library binding, Run usage
  settlement, and migration behavior that cannot be proven in memory.
- Use local K8s only for the Sandbox/PVC paths listed in Phase 6.
- Use Playwright manually for the retained Files, Task creation/detail,
  release-confirmation, Usage, and Audit paths. Do not commit a Playwright suite
  or visual baseline for this work.
- Run tests serially. Do not run image builds, Postgres, browser tests, or K8s
  work concurrently.
- Delete obsolete tests with obsolete behavior. Do not test tests, wrappers,
  prose, generated artifacts, or release process.

## 13. Handoff Completion Criteria

The work is complete when all of the following are true in the local
single-node K8s environment:

- Files shows multiple authorized Libraries and every file operation is scoped
  to the selected Library.
- Task creation atomically creates or exclusively binds one Library.
- One Task ID maps to one Botified session and supports repeated turns without
  successor Tasks.
- A completed turn leaves the same composer ready for another message.
- Sandbox release happens only after explicit user confirmation and is
  unconditional; no idle or process-aware automatic release remains.
- Releasing a Sandbox preserves the Task conversation, Botified completed
  history, File Library files, and artifacts, while stopping all current work.
- The next message or Terminal open creates a new Run and resumes the same Task
  and Library without resuming terminated work.
- Usage shows accurate per-user Sandbox runtime and resource-time totals, and
  Project admins can inspect safe Sandbox lifecycle Audit facts.
- Failed Runs cannot strand resources or capacity; Archive cannot hide an
  active Sandbox, and archived Tasks cannot start compute.
- No fixed Project file tree, input snapshot path, successor path, TTL path,
  compatibility adapter, governance report, evidence output, or default gate
  remains in the changed product path.
