# AgentSmith Lite Core Workflow Product Improvement Plan

Status: handoff-ready

Date: 2026-07-24

Applies to: `agentsmith-lite`

## 1. Authority and Purpose

This is the implementation handoff for the next AgentSmith Lite product
milestone. It corrects product behavior discovered after the Task workspace and
Astryx migration became usable:

1. a released Task does not explain Sandbox capacity before a message or
   Terminal cold-start;
2. Files conflates folder selection with navigation and cannot delete folders;
3. an unbound File Library cannot be deleted when it contains files;
4. the shell, page header, dialogs, and work surfaces are visually consistent
   but still feel fragmented and under-designed;
5. adjacent Usage, Alert, and Audit language describes Sandbox allocation as
   persistent Task capacity;
6. Task workbench drafts and selected peer views do not survive ordinary
   navigation away from and back to the Task;
7. Files can currently reach the Task-owned `workspace/.artifacts` namespace,
   and a missing folder is incorrectly presented as an empty folder.

This plan is authoritative for these corrections and their directly related
API, application, storage, and Web behavior. It supersedes the following
details in older plans:

- the rule in `docs/task-workspace-product-improvement-plan.md` that every
  non-empty File Library is undeletable;
- Files behavior that does not explicitly separate selection, navigation, and
  deletion;
- user-facing `active task` terminology for capacity that is actually held by
  an unreleased Sandbox Run;
- any capacity implementation that treats a denormalized Project usage counter
  as admission truth, creates an unreleased Run outside the shared admission
  primitive, or lets substrate rejection win when Project and namespace are
  simultaneously saturated;
- any Terminal path in which selecting the peer view or opening its WebSocket
  starts compute, or in which a database transaction stays open during the
  Kubernetes/Botified start;
- any Task-create path in which a pending initial message, runtime tick, or
  Kubernetes/Botified `create_resource`/`adopt_resource` startup path can claim
  startup before the admitted workspace has been descriptor-safely promoted
  and durably marked ready;
- any deployment that can overlap two AgentSmith API control-plane processes,
  or any external startup action without a persisted hard deadline that a
  recovering process must honor and drain through cleanup before
  release/takeover;
- any route-specific capacity envelope, public `activeTasks`/`activeTasksLimit`
  alias, or public `task_capacity`/`active_tasks` Alert vocabulary;
- any claim that Sandbox terminology requires no Slice 1 migration, or that
  the Slice 1 startup-readiness/action-deadline/generated-copy migration and
  Slice 3 Library lifecycle migration are one combined migration;
- any claim that the first Astryx migration completed the shell, dialog, or
  visual-composition work.

The following decisions remain unchanged:

- one durable Task has one Botified session, one exclusively bound File
  Library, many turns, and sequential Sandbox Runs;
- release is explicit and unconditional, with no idle TTL, process inspection,
  or automatic reclamation;
- the Web is an AgentSmith API client, and all authorization, resource,
  deletion, accounting, and Botified behavior is server-owned;
- this milestone's AgentSmith API control plane is exactly one replica and is
  replaced without old/new process overlap;
- Astryx is the only visual system, English is the only locale, and removed
  Chat, Codex, LLMUP, JVS, WebDAV, mount, template, savepoint, and governance
  paths stay removed.

This document is a product and development plan, not a process framework.
Implementation fixes defects in place and uses only focused checks chosen for
the current change. It must not create reports, evidence bundles, visual
baselines, rehearsals, release gates, or tests of test infrastructure.

## 2. Product Decision

The milestone establishes three product-wide mental models.

### 2.1 A Task is durable; a Sandbox slot is replaceable capacity

A released Task still exists and remains usable. Its next message or explicit
Terminal start needs a new Sandbox Run. The product explains that consequence
before the action; the server then decides capacity atomically. If admission
fails, the product preserves the user's draft or location and shows the direct
recovery path.

Capacity never creates a successor Task, a second Botified session, a queue
waiting for compute, or an automatic release decision.

### 2.2 Files separates selection, navigation, and destruction

The Files hierarchy is:

```text
Project
  -> selected File Library
     -> current folder
        -> selected file or folder
```

Single click selects an entry. Opening a folder is a separate explicit action.
Deleting a file, folder, or unbound File Library is one deliberate destructive
path with object-specific confirmation.

### 2.3 One Astryx work environment, not a collection of panels

The shell, page identity, work surface, floating layers, and status feedback
must read as one continuous environment. Static layers use spacing and one
necessary boundary; shadows are reserved for floating layers. Visual
character comes from hierarchy, typography, purposeful surfaces, state,
real content, the existing mark, and real previews, not extra cards or
decoration.

## 3. Milestone Outcomes

### 3.1 User outcomes

- A released Task says that the next message or explicit
  `Start sandbox and open Terminal` command starts a new Sandbox for the same
  Task, session, and File Library. Entering or restoring the Terminal view
  alone never starts compute.
- A released Task explains before submission that Send or the explicit
  Terminal start command will start compute. If atomic admission rejects that
  attempt, the Task keeps the draft and context, explains the capacity scope,
  and links to the direct recovery.
- A capacity race reports that the Sandbox could not be started; it never
  claims that an accepted message failed after the fact.
- Once released-message admission succeeds, the message remains accepted.
  Any later startup failure appears through the durable Run and interaction
  state while failed cleanup continues to hold capacity.
- An admitted Task never starts from a partially prepared workspace. Runtime
  pickup remains in progress until its operation-owned staging root is
  promoted and that exact fenced Run is durably startup-ready.
- Project policy capacity and substrate namespace capacity are distinct:
  Project capacity offers release/policy recovery, while substrate capacity
  offers release/retry and operator guidance without a misleading policy link.
- Task creation, released-Task messaging, released-Task explicit Terminal
  start,
  Usage, Resource Policy, Alerts, and Audit use one visible term: `Sandbox
  capacity`.
- In Files, a user can select either a file or folder with one click, open a
  folder through an explicit open affordance or desktop double click, and see
  the selected object's actions.
- A user with write access can delete a folder recursively after one clear
  confirmation. The Library root cannot be deleted as a folder.
- A user can delete any unbound File Library, including all of its contents,
  after one clear confirmation. A bound Library remains protected and links
  to its owning Task.
- Page headers and work surfaces feel connected; dialogs have one predictable
  anatomy, correct focus and overflow behavior, and usable actions at narrow
  widths and low heights.
- Returning to a Task as the same user in the same browser session restores
  its unsent draft. The selected peer view is restored only by browser history
  or a validated Files `returnTo`; every other Task navigation opens
  Conversation.
- Task, Files, Usage, Alerts, Audit, directories, and settings feel like parts
  of one long-lived Astryx work environment without obscuring operational
  content.

### 3.2 Engineering outcomes

- One atomic server admission path is the only capacity truth for every
  Sandbox start. The Web does not infer or cache whether a future start will
  succeed.
- One persistent Run readiness field is the only startup-claim gate. No
  dispatcher, runtime tick, or Kubernetes/Botified
  `create_resource`/`adopt_resource` startup path infers readiness from
  Task/interaction state or filesystem observation.
- One in-process Promise per starting Run and one persisted external-action
  deadline prevent same-process duplication and bound crash recovery without a
  multi-replica coordination protocol.
- Two typed capacity scopes and one shared presentation model serve Task
  creation, message cold-start, and Terminal cold-start without conflating
  user-managed Project policy with substrate saturation.
- One entry-delete API handles regular files and directories without a
  `recursive` UI mode or a second endpoint.
- One File Library delete path removes an unbound Library whether empty or
  non-empty; there is no safe-delete/force-delete fork.
- File and Library deletion preserve path containment, do not follow symlinks,
  update Project file-byte usage, and emit one content-free Audit event for
  the user operation.
- Task creation, Task deletion, Library mutation, and Library deletion share
  one narrow database-backed Library lifecycle; database constraints remain
  the final binding guard across retry and concurrent API requests.
- One AgentSmith Astryx Theme remains the only visual source. Shared shell and
  dialog corrections replace their current implementation rather than adding
  wrappers, compatibility styles, or parallel components.

## 4. Scope Boundaries

### 4.1 Included

- One atomic Sandbox admission result for released Tasks and initial Task
  creation.
- Run-row capacity truth, absolute same-transaction Project usage projection,
  Project-first simultaneous-saturation precedence, and the explicit
  namespace/admission versus Project/policy lock disciplines.
- Message and Terminal cold-start capacity presentation and typed race errors.
- Idempotency-key replay for capacity rejection and fenced, transaction-free
  Terminal startup after a committed reservation.
- Failed Terminal startup state that remains capacity-holding until the
  Kubernetes resource is confirmed absent, with exact same-key failure replay.
- Operation-owned Task-create staging under the Project, outside every Library
  root and Sandbox mount, guarded by descriptor-safe FD walk plus exact
  operation marker, followed by same-volume promotion and one fenced
  persistent startup-ready transition.
- Initial Task-create null readiness versus ready reservation for
  released-Task message/Terminal restart on an already promoted workspace.
- Store-transaction readiness checks for every Kubernetes/Botified
  `create_resource`/`adopt_resource` startup claim and message dispatch, while
  cleanup/release reconciliation remains able to process not-ready Runs.
- One persisted startup claim spans the complete Kubernetes apply/adopt and
  Botified readiness sequence. Kubernetes resource creation is not an
  intermediate confirmation point; only final `active` confirmation or an
  atomic startup-failure transition terminates the claim.
- One `AtomicTaskCreate` admission transaction writes the Task, Library
  creation/binding, reserved Run, initial message, and initial interaction, so
  no dispatcher can observe a ready message without its interaction.
- One `AtomicTaskMessage` transaction for ready Run, message, initial
  interaction, and fixed accepted receipt.
- One Terminal Store transaction that binds each idempotency operation to one
  Run and converges on that Run's state: only `starting` returns in-progress,
  `active` fixes success, `failed`/`release_requested` fix failure, and
  `released` replays or fixes failure without restarting the same operation.
  Every in-progress response identifies its persisted Run; only a genuinely
  new operation may admit and reserve from a released Task.
- One in-process shared Promise per Run; database lease recovery only after
  process crash, action-deadline drain, and local-operation absence.
- AgentSmith API deployment at exactly one replica with `Recreate` strategy,
  plus manifests/configuration that cannot overlap control-plane instances.
- One independent persisted `startupActionDeadlineAt` around each Kubernetes
  apply/adopt action and the bounded Botified readiness action, with normal
  completion clearing that action's deadline, unknown completion retaining it
  through deadline drain and cleanup, and empty-resource confirmation before
  recovery or release.
- Consistent Sandbox capacity terminology in Task creation, Task detail,
  Usage, Resource Policy, Alerts, and relevant Audit details.
- Correct Audit action attribution for capacity rejection.
- A shared atomic Project/namespace Sandbox admission path for initial Task,
  released-message, and released-Terminal cold-start.
- User-and-Task-scoped draft plus history/validated-return URL peer-view
  continuity without a global client state framework.
- A 32,768 UTF-8-byte `sessionStorage` draft-snapshot ceiling that never limits
  message editing or submission, plus validated same-origin Task-to-Files
  return navigation.
- Focused Slice 1 migration `074` for the Run startup-readiness and
  external-action-deadline columns, database-fact active-Run readiness
  backfill, and exact generated Alert/notification copy, separate from the
  Slice 3 Library lifecycle migration.
- File/folder row selection, folder navigation, keyboard behavior, selected
  details, and destructive actions.
- Recursive folder deletion with complete point-in-time Project file-byte
  reconciliation.
- Recursive deletion of unbound File Libraries and all their content.
- A minimal `active | deleting` File Library lifecycle needed to prevent
  binding during recursive deletion and to retry an interrupted deletion.
- File Library binding protection and direct owning-Task guidance.
- Protection of the Task-owned `workspace/.artifacts` namespace from ordinary
  Files list, upload, overwrite, and entry deletion.
- Typed missing-folder recovery to the selected Library root.
- One File Library delete Audit action needed to make the destructive member
  operation visible to authorized administrators.
- Shared Topbar, page header, page layout, and dialog composition correction.
- Astryx theme and domain-composition refinement for the retained Web App.
- Focused service, store, API contract, and behavior tests for changed logic.
- Temporary, serial manual browser and local single-node K8s checks.

### 4.2 Explicit non-goals

- Automatic Sandbox release, idle detection, TTL, process inspection,
  capacity queues, priority scheduling, or automatic selection of a Sandbox
  to release.
- Successor Tasks, duplicate Botified sessions, message migration, or a new
  Task execution model.
- Multiple Libraries per Task, shared Library binding, rebinding a live Task,
  or deleting a Library while it is bound.
- File move, copy, rename, multi-select, bulk actions, folder upload, recursive
  search, indexing, versions, templates, savepoints, restore, or sync.
- A separate `force` endpoint, destructive-mode toggle, deletion job,
  cleanup controller, or storage metadata index. A deterministic same-volume
  deletion quarantine used by the synchronous delete operation is part of the
  delete primitive, not a background service.
- A new state framework, data grid, file manager library, modal framework,
  design-system wrapper layer, frontend BFF, event bus, or analytics service.
- Decorative dashboards, page-specific illustration collections, gradients,
  background effects, stock imagery, or a second icon set.
- Restoring legacy AgentSmith CSS, tokens, primitives, locale routes, or
  pixel-copying the old visual design.
- Cloud validation, multi-replica control-plane design, rolling overlap of old
  and new AgentSmith API instances, automated visual approval, permanent
  Playwright suites, default end-to-end gates, reports, or evidence generation.
- Persisting Task drafts to the server, persisting follow/read mode or scroll
  anchors across routes, sharing drafts across users/devices, or introducing a
  global frontend store.
- A capacity preflight, a second admission route, an unreleased-Run creation
  escape hatch, multiple Terminal capability fields, or WebSocket-owned
  startup.
- A filesystem-ready inference, process-local readiness authority, second Run
  on retry/crash recovery, or startup claim outside a Store transaction.
- Startup generation counters, rotating startup credentials, admission
  webhooks, leader election, or another multi-controller protocol.
- Public compatibility aliases for old Task-capacity fields or Alert values.
- A server or Web Task-message byte limit tied to the browser draft-snapshot
  ceiling.

## 5. Current Product Findings

### 5.1 Capacity enforcement is correct but arrives too late

The atomic message path correctly rejects a released-Task restart when Project
capacity is full, and it does not persist the rejected message. The Task
correctly remains released, but the composer renders the typed policy failure
as a generic message error with no capacity scope or recovery.

The same omission exists when a released Task opens Terminal because Terminal
also cold-starts the Sandbox. Fixing only the composer would create two
different capacity behaviors.

The substrate namespace limit is a second capacity boundary. It is currently
checked only before initial Task creation through a non-atomic preflight.
Released-message and released-Terminal starts bypass it. Project and namespace
admission must move into the same atomic start path while retaining distinct
safe errors and recovery copy.

Task create has a second ordering defect after admission. The admitted Task,
pending initial interaction, and reserved Run become visible before workspace
promotion finishes. The five-second runtime tick can therefore claim the
pending message and start Kubernetes/Botified against an unpromoted workspace.
Process order in one request is not a correctness boundary; startup readiness
must be persisted on the Run and checked transactionally by every claim path.

### 5.2 Capacity language describes the wrong durable object

`activeTasks`, `activeTasksLimit`, `Task capacity`, and
`active_tasks_limit_reached` are used for a counter held by every Sandbox Run
not yet confirmed `released`, including failed/pending-cleanup Runs. A released
Task does not consume the resource. This language confuses Task lifecycle with
compute allocation and leaks into Usage, Resource Policy, Alerts, and Audit.

The current rejection recorder also classifies every reservation rejection as
`task.create`, including a restart triggered by an existing Task message or
Terminal. That produces a false admin history.

### 5.3 Task continuity stops at the route boundary

The workbench correctly keeps one interaction snapshot/SSE path and
distinguishes following latest from reading earlier. Its unsent draft and
selected Conversation/Terminal/Artifacts view are still component-local.
Navigating to Files and returning unmounts the Task and silently resets those
two pieces of working context.

This is not a request for server drafts, scroll restoration, or a global state
system. The durable conversation stays server-owned; the small recoverable
browser-session draft is keyed by current user plus Task ID, and the peer view
belongs to the URL.

### 5.4 Folder selection is hidden and folder deletion is absent

The folder name navigates immediately while a secondary `Folder` label selects
the entry. This makes the primary row action differ between files and folders,
depends on a subtle secondary target, and gives touch and keyboard users no
obvious object-selection model.

The details region renders destructive actions only for files. The server
delete path rejects every non-regular-file entry, so this is an API and
application gap rather than a presentation-only defect.

The file list also maps a missing directory to `{ entries: [] }`. If an agent,
Terminal, or another browser deletes the current folder, the Web tells the user
that the folder is empty instead of recovering from a missing path.

### 5.5 Artifact storage is exposed as ordinary Files content

Task Artifact metadata is durable product state, while artifact bytes live
under the bound Library's `workspace/.artifacts` namespace. The ordinary Files
API can currently list and mutate that namespace. Recursive deletion would
make it easier to leave visible Artifact metadata pointing at removed bytes.

Files must treat `workspace/.artifacts` as a reserved internal subtree. It is
not listed, uploaded into, overwritten, or deleted through entry operations.
Deleting the entire unbound Library may remove it because no retained Task can
then own those artifacts.

### 5.6 File Library deletion has the wrong safety boundary

The current boundary treats content as a reason to make a Library
undeletable. The meaningful invariant is binding: deleting a bound Library
would break a durable Task, while deleting an unbound Library and its files is
a normal explicit destructive action.

The current implementation removes an empty filesystem root before checking
the database binding and recreates the root on a binding conflict. That
compensation cannot safely extend to non-empty content. The implementation
order must check and serialize binding before recursively removing data.

A process-local lifecycle lock is not a sufficient deletion transaction. Task
creation and retry can race in another request, and the Sandbox can mutate
JuiceFS outside that lock. A narrow database `deleting` state and deterministic
same-volume quarantine are needed so binding stops before bytes move and the
same DELETE can resume after interruption.

### 5.7 Recursive path deletion has a TOCTOU boundary

The current path flow validates a string path, runs `lstat`, and later calls
`rm` on that string. A Sandbox process can replace a parent entry between
validation and deletion. Reading an entire file into memory for rollback also
does not scale to directories.

The final delete primitive must anchor traversal to an opened Library root,
refuse symlink components, atomically rename the selected entry to an
app-owned same-volume quarantine outside Sandbox mounts, and then measure and
remove that isolated entry. It never reconstructs a directory tree in memory.

### 5.8 Shared visual layers create repeated separation

The static Topbar combines a border and shadow. Every standard Page Header adds
another divider and large bottom space, and Page Layout adds another body gap.
Dialogs place a full Layout with header and footer dividers inside a floating
Dialog. Repetition makes each layer appear as a separate panel and weakens the
relationship between page identity and work.

The AgentSmith theme is correctly the single runtime theme, but broad use of
the same neutral surfaces, borders, and container treatment gives functional
consistency without enough hierarchy or product character. More cards or
illustrations would amplify the problem instead of fixing it.

Task repeats released state in the page subtitle, a success Banner, and the
workbench run-status strip. Released means retained work with compute stopped,
not successful completion; it needs one neutral paused-state presentation.

### 5.9 Directly adjacent defects included in this milestone

The following are included because they are the same product paths, not a new
feature expansion:

- Terminal cold-start needs the same admission and recovery behavior as a
  message cold-start.
- Namespace admission must be atomic for all three cold-start triggers and
  must not enter Terminal's generic reconnect loop when capacity is known to be
  unavailable.
- Task-create staging/promotion and the runtime/message startup paths need one
  persistent readiness handoff so the periodic tick cannot outrun workspace
  promotion.
- Task draft and peer view need user-scoped browser-session continuity because
  navigating to the Task's own Files page is an ordinary workflow.
- A disabled bound-Library delete control must have a visible explanation and
  owning-Task route; essential guidance cannot exist only in a hover tooltip.
- Folder deletion confirmation and feedback must say `folder`, not `file`.
- A missing current folder must return a typed error, recover to the selected
  Library root, and never masquerade as an empty directory.
- Ordinary Files operations must not expose or mutate Task Artifact internals.
- Deleting a selected folder or Library must repair URL, selection, preview,
  and pagination state without navigating into a missing path.
- Recursive deletion must reconcile byte usage once and avoid creating one
  Audit row per descendant file.
- File Library deletion needs one destructive Audit action; this milestone
  does not broaden File Library lifecycle Audit vocabulary.
- Dialog corrections must cover all retained callers because the defect is in
  the shared anatomy, not in one feature dialog.
- Task, Project, and Workspace destructive confirmations must name what stops,
  what is permanently deleted, and what is retained.

## 6. Final Product Behavior

### 6.1 One atomic Sandbox admission

There is no Task-level capacity preflight, cached availability, or disabled
action based on an observation that can become stale. When Task lifecycle and
authorization permit an action, Send and Terminal start remain operable. The
server atomically decides whether a cold-start can reserve capacity.

Every cold-start returns one of:

```ts
type SandboxAdmissionResult =
  | { kind: "admitted"; runId: string }
  | {
      kind: "project_capacity_rejected";
      activeSandboxes: number;
      sandboxLimit: number;
    }
  | { kind: "substrate_capacity_rejected" };
```

Rules:

- an existing starting or active Run does not reserve another slot;
- initial Task creation, a released-Task message, and a released-Task Terminal
  start use the same internal Store admission primitive; Terminal exposes it
  only through the dedicated atomic operation in sections 6.3 and 7.1;
- Project and substrate admission happen in the same transaction under the
  capacity-writer lock order in section 7.1;
- the authoritative Project and namespace count is the number of Run rows
  whose `state != released`, including reserved startup, active work, release
  cleanup, and failed cleanup;
- `project_resource_usage.active_tasks` is only a compatibility storage
  projection of that count. Admission and release finalization set it to the
  absolute authoritative value while holding the required locks; no path
  blindly increments or decrements it;
- no service, Store method, repair path, fixture helper used by production, or
  alternate route may create a Run with `state != released` without the shared
  admission primitive;
- Project capacity is evaluated first. If Project and namespace are both
  saturated in the same locked snapshot, the result is always
  `project_capacity_rejected`;
- Project rejection may expose current Project count and limit;
- substrate rejection never exposes another Project's allocation or
  infrastructure internals;
- authorization, Task lifecycle, Endpoint eligibility, and cleanup state are
  checked before capacity and keep their own typed errors.

The Web never joins policy and usage data to infer admission. Usage remains the
place to inspect live allocation after a rejection.

Capacity rejection is an idempotent terminal result for the supplied key. The
server stores the exact code, canonical message, details snapshot, and
presentation chosen for that request. Any replay with the same key returns the
same status and byte-equivalent JSON envelope even after capacity changes.
`Retry` is an explicit user action and always sends a new idempotency key.

Task creation does not preflight capacity. Its atomic rejection preserves the
dialog's title, prompt, Endpoint, Library mode, selected Library, and new
Library name. It shows the same scope-correct recovery as released Task start.

Every persisted Sandbox Run has these internal startup fields:

```ts
startupReadyAt: string | null;
startupActionDeadlineAt: string | null;
```

Initial Task-create reservation is inserted with `startupReadyAt: null`.
Released-Task message and Terminal restart reuse an already promoted workspace,
so their reservation transaction sets `startupReadyAt` immediately.
`startupActionDeadlineAt` is null when no external startup action is
outstanding. Neither field allocates or releases capacity; `state != released`
remains the sole capacity predicate.

Task create uses this fixed preparation handoff:

1. Before admission, allocate the stable Task ID, Run ID, operation identity,
   request hash, and fencing token. Prepare only the operation-owned Project
   path `.preparations/<taskId>`.
2. That staging root is inside the Project's owned storage boundary, on the
   same volume as the destination, and outside every File Library root and
   Sandbox mount. It is absent from Files, Library binding, Task workspace,
   Artifact, and Sandbox projections.
   Create and validate it through a descriptor-safe FD walk with no symlink
   component, and write one operation marker containing the exact Project,
   Task, Run, operation, request-hash, and fence identities.
3. A preparation failure before admission returns its own typed error. No
   capacity result exists yet and no Task, interaction, Library bind, or Run is
   admitted.
4. `AtomicTaskCreate` admission atomically persists the Task, Library
   creation/binding, reserved Run with `startupReadyAt: null`, initial message,
   and its initial pending interaction. The message and interaction are one
   indivisible write set; no dispatcher-visible message can exist without its
   interaction. Capacity rejection persists only request idempotency and one
   deduplicated rejected Audit, then removes that operation's staging root.
5. After successful admission, a descriptor-safe FD walk verifies the marker
   and same-volume source/destination, then promotes only that operation's
   staging content into the admitted canonical workspace. No string-path
   validate-then-move fallback is allowed.
6. Only after promotion succeeds may one Store transaction atomically set
   `startupReadyAt` for the exact `taskId`, `runId`, and `fencingToken`.

Failure to clean staging after capacity rejection never replaces the stored
canonical capacity envelope. A remnant stays invisible, unbindable, outside
Sandbox mounts, and claimable only by that same operation's fenced recovery.
Same-key retry resumes only the marker-matched Task ID, Run ID, staging root,
and promotion; it cannot allocate another staging root, bind another Library,
reserve another Run, or mark a different Run ready.

All Slice 1 retryable failures use exactly one envelope:

```ts
{
  error: {
    code:
      | "project_sandbox_capacity_reached"
      | "substrate_sandbox_capacity_reached"
      | "sandbox_start_failed";
    message: string;
    retryable: true;
    details: {
      activeSandboxes: number;
      sandboxLimit: number;
    } | null;
    presentation: TaskPresentation | null;
  };
}
```

`project_sandbox_capacity_reached` uses the canonical message `Project Sandbox
capacity reached`, with non-null `details`. `substrate_sandbox_capacity_reached`
uses `Local Sandbox capacity unavailable`, with `details: null`.
`sandbox_start_failed` uses `Sandbox could not be started`, with
`details: null`, and is reserved for the Terminal-start command. Task-create
capacity errors use `presentation: null`; released-message capacity errors use
the original canonical released `TaskPresentation`; Terminal capacity errors
use the same released presentation. Terminal startup failure instead carries
the canonical failed/pending-cleanup presentation for its capacity-holding
Run. There is no legacy envelope, route-local serializer, or alternate
capacity shape.

### 6.2 Released Task message behavior

- released state says once that Send starts a Sandbox for this same Task,
  Botified session, and File Library;
- the draft remains editable and Send remains available while Task capability
  permits it;
- the server and Web impose no 32 KiB Task-message business limit. Ordinary
  message validation, including trimmed non-empty validation, is independent
  of browser draft persistence;
- admitted Send atomically creates one Run and one message, then shows startup
  progress in the same workbench;
- rejected Send creates no Run, message, queued interaction, or accepted
  message Audit event and leaves the Task released;
- the sole error envelope in section 6.1 returns `retryable: true`, the same
  canonical released Task presentation, and either
  `project_sandbox_capacity_reached` with Project count/limit or
  `substrate_sandbox_capacity_reached`;
- once admission succeeds, the message is accepted and the request never later
  becomes `sandbox_start_failed`. A subsequent Sandbox startup failure is
  represented by the persisted Run/interaction failure and cleanup state; the
  Run keeps holding capacity until release finalization;
- `AtomicTaskMessage` uses one Store transaction to write the ready reserved
  Run, message, initial interaction, and fixed accepted idempotency receipt.
  The existing workspace was already promoted by Task creation, so the Run may
  commit with `startupReadyAt` set; there is no follow-up ready write;
- once that accepted receipt commits, readiness/startup/dispatch work may
  change only durable Run and interaction state. No later error changes the
  original HTTP response or same-key replay;
- the Web keeps draft, focus, timeline, and peer view, and titles the inline
  error `Sandbox could not be started`;
- Project rejection links to live Sandboxes and, for administrators, Resource
  Policy;
- substrate rejection links to live Sandboxes and says to release one the user
  controls or try again later, without a misleading Project Policy link;
- same-key replay returns the exact original rejection; after capacity changes,
  explicit `Retry` uses the same Send command with a new idempotency key;
- there is no automatic retry, compute queue, future slot, or auto-release.

### 6.3 Released Task Terminal behavior

- Terminal is an optional peer view for every readable Task. The server does
  not hide the view behind a start capability.
- The single `openTerminal` capability authorizes only the explicit
  start/connect command. Do not add `canViewTerminal`, `canStartTerminal`,
  `canConnectTerminal`, or other parallel capability fields.
- `sandboxState` and that one command authorization determine the peer surface:
  `openTerminal: false` shows static Unavailable; otherwise `released` shows
  static Start, `starting` (including a committed reservation) shows progress,
  `active` shows Connect, and `failed`/`release_requested` shows static
  Pending cleanup with no Retry command.
- Selecting Terminal, restoring it through browser history or validated Files
  `returnTo`, or refreshing that history entry never starts compute or mounts
  a WebSocket.
- Only `Start sandbox and open Terminal` calls idempotent JSON
  `POST /tasks/:taskId/terminal/start` with an idempotency key.

Terminal start uses one dedicated Store begin operation and transaction-free
runtime work:

1. `beginTerminalStart` runs one Store transaction that validates
   authorization and `requestHash`, begins or replays request idempotency, and
   binds the operation to one persisted Run before deciding the response.
2. A stored completed receipt always replays exactly. Otherwise the bound Run
   state converges in that same transaction:
   - `starting`: the only state that may return HTTP 202, always with its
     persisted `runId`; null readiness means preparing and Terminal never marks
     it ready;
   - `active`: persist and return one fixed HTTP 200 active receipt;
   - `failed` or `release_requested`: persist and return one fixed canonical
     failure receipt;
   - `released`: replay a receipt already stored for that operation, or persist
     and return an explicit non-retryable lifecycle failure. Never reserve or
     restart a Run for that same operation.
3. Only a genuinely new idempotency operation may act on a currently released
   Task. Its admission reserves one new ready `starting` Run against the
   already promoted workspace and binds that `runId` in the same transaction;
   later same-key calls follow the state matrix above.
4. After commit, the service claims a ready Run transactionally.
   Kubernetes/Botified startup occurs outside every database transaction.
5. Only the current persisted claim/fence may execute `create_resource` or
   `adopt_resource` and confirm that same Run `active`. The command reports
   success only after active confirmation and returns the canonical active
   `TaskPresentation`.
6. Startup failure atomically records the Run `failed`, requests cleanup
   through `release_requested`, and stores the canonical
   `sandbox_start_failed` envelope with the failed/pending-cleanup
   `TaskPresentation`.
7. Failure completion mutates state only when operation ID, `requestHash`,
   startup claim/fence, Project ID, Task ID, Run ID, Task `currentRunId`, and
   Kubernetes/Botified resource identity all still match. A stale or mismatched
   completion is rejected without changing Run, Task, usage, or idempotency.
8. The failed Run remains capacity-holding until cleanup confirms that no
   Kubernetes/Botified resource exists and release finalization changes it to
   `released`.

Concurrent calls with the same key never create or start a second Run. The
owner request waits for startup's canonical final result. While it is still
starting, another same-key request returns HTTP 202 with typed non-error
`in_progress` for that same Run; after completion, the same key converges on
that Run's HTTP 200 `active` result or stored canonical failure. Capacity
rejection is also replayed exactly for that key. A user choosing `Retry` after
capacity rejection sends a new key. After startup failure, Retry remains
unavailable until cleanup confirms `released`; the failed key always replays
the exact stored failed/pending-cleanup envelope and never substitutes a
released presentation. Once a fresh Task presentation confirms `released`, an
explicit Retry uses a new key.

The API process owns `startupOperationsByRunId`, a map from Run ID to the
single shared startup Promise. While that Promise is unsettled, every same-Run
caller other than the owner receives `in_progress`; no caller performs lease
takeover or starts another external action. The owner resolves the shared
Promise, and the map entry is removed in its settle/finally path.

The database startup lease exists only for process-crash recovery. A new
process may take over the same `starting` Run only after its persisted external
action deadline has been drained, no in-process Promise exists for the Run,
and the Store grants a new fenced claim. It never reserves another Run or
returns in-progress without `runId`.

```ts
type TerminalStartCommandResult =
  | {
      status: "in_progress";
      runId: string;
      presentation: TaskPresentation;
    }
  | {
      status: "active";
      runId: string;
      presentation: TaskPresentation;
    };
```

The WebSocket is mounted only after the command confirms `active`; it is a pure
authenticated transport connection and never reserves or starts a Sandbox. A
later transport disconnect may use bounded reconnect. Admission rejection,
startup progress, and startup failure never enter a generic connection retry
loop. Terminal never creates a new Task or Botified session and never queues a
shell while waiting for capacity.

### 6.4 Task workbench continuity

Keep small recoverable state scoped by Task ID:

- unsent composer draft: `sessionStorage`, partitioned by stable current-user
  ID and Task ID;
- selected Conversation/Terminal/Artifacts peer view: URL state only, restored
  only by browser history or validated Files return.

Rules:

- clear the draft only after the server accepts that exact message or the Task
  is deleted;
- clear or ignore stored state on logout, identity change, denied Task access,
  or Task deletion;
- archived/read-only Tasks may show a retained draft but cannot submit it;
- browser refresh/back/forward may restore the valid `view` already owned by
  that history entry;
- Task-to-Files navigation carries a canonical `returnTo` containing the
  current Task URL and peer-view query. The Web accepts it only after resolving
  it as an application-internal, same-origin relative URL and canonicalizing
  it; absolute, protocol-relative, cross-origin, malformed, and non-application
  values are discarded. Files returns through only that validated value;
- every other Task entry, including Task lists, alerts, search, copied/direct
  links, and cross-product navigation, constructs or normalizes a Task URL
  without `view` and opens Conversation;
- no browser state is treated as conversation truth or shared across users,
  devices, or Tasks;
- do not persist follow/read mode, scroll anchors, streamed previews,
  interaction bodies, credentials, Terminal data, or server capability
  decisions.

The storage key includes schema version, current user ID, Project ID, and Task
ID. `TASK_DRAFT_SNAPSHOT_MAX_UTF8_BYTES = 32768` applies only to the
`sessionStorage` snapshot and is measured with `TextEncoder`. A larger draft
remains editable and submittable, but the Web stops persisting it, deletes any
older snapshot for that key, and shows a non-blocking inline persistence hint.
When the draft returns within the ceiling, snapshot persistence resumes and
the hint disappears. Peer view and `returnTo` are never stored. If browser
storage is unavailable or full, the mounted composer still works and reports
the same non-blocking persistence condition rather than blocking Task work.

The Task displays one activity summary. Released state appears once with a
neutral stopped/paused treatment; it is not a green success Banner. Routine
ready state remains quiet, while failures and actionable blocks may use a
Banner.

### 6.5 Capacity terminology and Audit

Canonical user-facing language:

| Concept | Visible term |
| --- | --- |
| policy | Sandbox capacity |
| current use | Active sandboxes |
| limit | Sandbox limit |
| Project-policy block | Project Sandbox capacity reached |
| substrate block | Local Sandbox capacity unavailable |
| recovery | Release another sandbox, then try again |

Public application contracts and all visible copy use Sandbox names. Existing
public capacity fields are exactly `sandboxLimit` and `activeSandboxes`.
Public Alert values are exactly type `sandbox_capacity` and metric
`active_sandboxes`. No compatibility alias, dual public field, old route
serializer, or old visible term remains.

Slice 1 migration `074` is one focused forward schema-and-data migration. The
schema part adds nullable `sandbox_runs.startup_ready_at` and
`sandbox_runs.startup_action_deadline_at`. Existing `active` Runs are
backfilled ready only from database lifecycle fact because their resource
already started. Existing `starting` Runs remain null. Migration `074` performs
no filesystem walk, marker validation, startup recovery, or failure/cleanup
transition.

Application startup reconciliation owns old `starting` Run recovery. Its
service descriptor-safely validates the exact operation marker: a match resumes
that same staging/promotion operation, while a missing or invalid marker
atomically moves the Run to `failed`/`release_requested` and cleanup. This is
application behavior with focused service tests, not SQL migration behavior.

The data part updates only rows whose system kind and complete legacy
Alert/notification title/body exactly match the enumerated old generated
strings, replacing those strings with canonical Sandbox terminology. It
performs no substring or fuzzy replacement and never rewrites user-authored or
non-matching content.

That migration does not rename other private SQL columns or persisted enum
values. Those may retain old storage names, but only the adapter may project
them outward to canonical domain/public names. Application and Web code never
accept, emit, branch on, or map back from a public legacy alias. The focused
Slice 1 startup-readiness/action-deadline/generated-copy migration `074` and
the Slice 3 File Library lifecycle migration are two separate forward
migrations.

Audit behavior:

- a rejected initial Task creation remains `task.create / rejected`;
- a rejected released-Task message restart is
  `sandbox.started / rejected` with trigger `task_message`;
- a rejected Terminal restart is `sandbox.started / rejected` with trigger
  `terminal`;
- detail distinguishes `project_policy` from `substrate_namespace`;
- Project rejection detail contains `activeSandboxes` and `sandboxLimit`;
- substrate rejection detail contains neither count nor limit and never
  triggers a Project `sandbox_capacity` Alert;
- rejected Audit writes are deduplicated with request idempotency, including
  initial Task create rejection;
- no rejected message event is recorded when the message was never accepted;
- detail may contain IDs and trigger, but never prompt, message, credential, or
  file content.

### 6.6 Files selection and navigation

Desktop:

- render an ordinary semantic list; each row contains one full-width selection
  button plus a separate folder Open button, never nested interactive controls
  or a clickable `div`;
- single click, `Enter`, or `Space` on the selection button selects a file or
  folder and updates details;
- double click a folder opens it as a convenience;
- every folder row has a stable, labelled Open icon/action that works without
  double click;
- keyboard users Tab to the Open action and activate it with `Enter` or
  `Space`; do not invent a custom grid/arrow-key model;
- files expose safe Preview and Download from selected details rather than
  overloading selection with open;
- the selected treatment is distinct from hover and keyboard focus.

Touch and narrow layouts:

- tap the selection button to select the row and open a Details/Preview Sheet;
- a visible Open action enters a folder;
- the Sheet is the only narrow-screen details model; remove the bottom
  Collapsible path;
- closing the Sheet returns focus and scroll position to the selected row;
- no action depends on hover, double click, drag, or long press.

Files remain single-selection. The current Library and folder stay in the URL;
the selected entry remains local presentation state.

On narrow layouts, Library selector, Browser, and Details/Preview Sheet are
sequential rather than three squeezed columns.

If the current folder disappears, the API returns `file_path_not_found`. The
Web returns to the selected Library root, clears the stale entry/preview, and
explains that the previous folder was removed. It never renders a missing
folder as empty or probes each ancestor through extra API requests.

### 6.7 File and folder deletion

One existing entry-delete endpoint accepts a normalized relative `path` and
deletes the server-observed entry type:

- regular file: delete that file;
- directory: recursively delete that directory and all descendants;
- Library root: reject;
- `workspace/.artifacts`, its descendants, and the permanently reserved
  `workspace` ancestor: reject through the ordinary entry endpoint;
- statically observed symlink or path crossing a symlink: reject;
- missing entry: return the existing not-found result;
- statically observed unsupported entry type: reject without mutation.

If the final name is concurrently substituted after that static check, the
atomic rename still linearizes deletion on the object at that name. A
rename-time symlink or unsupported object is contained in quarantine, never
followed, persisted and removed as an isolated leaf, and reported only as the
actual deletion type; this does not widen ordinary listed-entry or selection
types.

Each listed entry carries server-owned destructive capability:

```ts
interface ProjectFileEntryCapabilities {
  canDelete: boolean;
  deleteUnavailableReason:
    | "artifact_namespace_protected"
    | "read_only"
    | null;
}
```

The visible `workspace` ancestor never shows an enabled Delete action and
displays the protected-Artifact reason in its selected details, even before
`.artifacts` exists. The server returns the same typed reason if a client
bypasses the Web.

There is no `recursive` switch. A directory Delete command is recursive by
definition and always uses a folder-specific confirmation:

```text
Delete folder?
This permanently deletes the folder and everything inside it.

Folder: <normalized path>
```

After success:

- the selected entry, preview, and stale descendant state are cleared;
- the current folder listing refreshes in place;
- Project file-byte usage is reconciled to the remaining authorized Library
  roots;
- one `file.delete` Audit event records the actual server-observed deletion
  `entryType` (`file`, `directory`, or the contained rename-time `symlink` or
  `unsupported` leaf), normalized path, and total bytes removed without
  descendant names or content;
- deleting a folder never emits one event per child;
- focus moves to the next entry, previous entry, or list heading in that order,
  and an accessible status message announces the deleted object.

Ordinary list/upload/overwrite/download/delete APIs apply the same reserved
namespace rule. Task Artifact APIs remain the only product path for published
Artifact bytes and metadata.

### 6.8 File Library deletion

File Library deletion has one product path:

- the server requires Project write access;
- the server rechecks that no active, archived, or not-yet-purged Task row
  binds the Library;
- a bound Library returns `file_library_bound` and its projection continues to
  expose the owning Task;
- an unbound Library is deleted recursively whether empty or non-empty;
- the root path is validated as an owned Library root and symlinks are never
  followed;
- Project file-byte usage is reconciled after deletion;
- idempotency prevents a repeated request from deleting another resource.

The Web confirmation says:

```text
Delete File Library?
This permanently deletes the library and all files inside it.

Library: <name>
```

The action label is `Delete library and files`. Do not first attempt an empty
delete and then offer a force mode.

Library lifecycle remains simple to users:

- `active`: browse, modify, bind, or delete according to capability;
- `deleting`: show Library identity and `Deletion did not finish`; allow only
  an authorized `Retry deletion` action;
- successful deletion: the Library is absent.

Refreshing or signing in again must still list a `deleting` Library so an
authorized member can resume it. Do not expose quarantine paths, phases, claim
tokens, or cleanup internals.

A bound Library shows a visible `Bound to <Task>` link and explanatory text.
The user must explicitly delete that Task before deleting the Library. Archive
does not release the binding.

Task deletion remains a separate explicit operation:

- it requires the Task Sandbox to be released first;
- it permanently removes the Task conversation, Botified session data, and
  Task Artifact metadata/bytes;
- it retains ordinary File Library files;
- only successful Task purge releases the binding and makes the Library
  `Available`;
- the user may then reuse the Library for a new Task or delete the Library and
  its files through this section's single delete action.

Add only the destructive `file_library.delete` Audit action. Its detail may
include Library ID, name, and aggregate bytes removed. It does not contain file
names, paths, or content. Create and rename do not expand Audit in this
milestone.

### 6.9 Shell and page composition

The final static layer model is:

```text
Application shell
  -> one Topbar boundary
  -> navigation and page share the body plane
  -> page identity
  -> work surface
```

- Remove the static Topbar shadow. Keep at most one quiet boundary between
  Topbar and the application body.
- At narrow widths, Topbar keeps navigation, compact identity/current-scope
  entry, notifications, and account access. Full Workspace and Project
  selectors move into the labelled navigation layer instead of competing for
  fixed width.
- Standard Page Header does not draw a second full-width divider by default.
- Header and body share gutters and a tighter vertical rhythm; page identity
  belongs to the page, not a floating header panel.
- Task does not render the standard Page Header. One compact workbench header
  replaces Page Header, separate back link, repeated status Banner, and
  detached peer-view Tabs.
- The workbench header contains back navigation, the single Task `h1`, one
  authoritative activity summary, Conversation/Terminal/Artifacts peer views,
  and the action area.
- On narrow widths, secondary and destructive Task actions move into one menu;
  the current activity and primary work command remain visible.
- Task details open on demand and do not consume permanent workbench height.
- Conversation, Terminal, or Artifacts use all remaining dynamic viewport
  height below the workbench header; page and timeline do not compete for
  scrolling.
- Full-width data/browser pages use adjacency boundaries only where regions
  need separation. Ordinary sections do not become cards.
- Responsive composition changes region placement rather than shrinking type
  or controls.
- At 320 CSS px, 400% zoom, enlarged text, and low-height landscape, the
  current object, primary work, and necessary actions remain reachable without
  overlap or page-level horizontal scrolling.
- Task Composer and focused dialog fields stay visible above the soft keyboard
  and safe-area insets.
- Frequent, mobile, and destructive targets reach 44x44 CSS px; other targets
  meet WCAG 2.2 target-size minimum or equivalent spacing.
- Forced-colors mode keeps selection, focus, disabled, and destructive states
  distinguishable.
- Streaming updates never move focus or interrupt reading mode. Live regions
  announce meaningful Turn, connection, admission, and completion changes, not
  individual tokens or repeated status refreshes.

### 6.10 Dialog system

Use Astryx directly:

- `Dialog` plus `DialogHeader` for forms and information;
- `AlertDialog` for simple two-action destructive confirmation that fits its
  installed string-description API;
- `Dialog` plus `DialogHeader`, `role="alertdialog"`, and direct Astryx
  content/actions for destructive forms that require typed-name validation,
  richer error recovery, or additional fields.

Delete the generic AgentSmith Dialog/ConfirmationDialog behavior wrapper.
AgentSmith may keep feature-specific dialog components that own business fields
and mutations, but it does not reimplement primitive overlay, focus, title,
footer, or confirmation behavior. Do not expand Astryx or create another
generic wrapper merely to make every destructive dialog use `AlertDialog`.

Required anatomy:

- one title region, optional concise subtitle, one scrollable content region,
  and one action region;
- no full page `Layout` nested inside the floating layer;
- at most one divider where scrolling content needs a boundary;
- stable width by task, `max-height` within the dynamic viewport, and content
  scrolling that never moves actions off-screen;
- Close remains available for dismissible dialogs; busy destructive mutation
  prevents accidental dismissal and duplicate submission without hiding
  operation state;
- Escape and backdrop follow the same dismissibility rule;
- initial focus goes to the first meaningful form field, or the safe action in
  a destructive confirmation;
- focus returns to the trigger;
- validation appears beside the affected field or before the affected form;
- mutation failure stays in the dialog and is announced to assistive
  technology without moving focus away from the affected action/form;
- mobile actions stack without reversing safe/destructive order or producing
  clipped labels;
- every form field keeps a visible persistent label; placeholder-only labels
  in rename, queued-message, or other dialog forms are corrected as callers
  migrate;
- destructive Task, Project, and Workspace copy states what stops, what is
  permanently deleted, and what remains. Sandbox release uses its existing
  unconditional warning and names retained conversation and files.

Canonical destructive boundaries:

- Sandbox release stops agent, Terminal, tools, and processes; it retains Task
  conversation, File Library files, and published Artifacts.
- Task delete is available only after release; it removes Task conversation,
  Botified session data, and Task Artifacts, retains ordinary Library files,
  and makes the Library available after purge.
- Project and Workspace delete remain blocked until their Sandboxes are
  released; confirmation then names the full Project/Workspace-owned data
  scope that will be permanently removed.

All retained dialog callers move to this one composition in the same phase.
Delete the replaced shared implementation; do not retain old and new modes.

### 6.11 Visual refinement

Refine the AgentSmith Astryx Theme and domain composition before adding assets:

- establish independently tuned light and dark surface relationships with
  visibly distinct canvas, raised, inset, selected, and disabled states;
- keep Agent orange for product identity and primary commands;
- keep selection/focus informational color distinct from destructive and
  status colors;
- strengthen selected, focused, active-work, muted, and read-only differences
  without using raw page colors;
- reduce repeated borders and use whitespace and alignment for grouping;
- make data rows, file rows, Task interactions, and form sections express
  their different jobs instead of sharing one generic panel treatment;
- keep technical content and paths in Berkeley Mono while ordinary product
  language stays in Cursor Gothic.

This milestone does not add a new asset family. The existing brand mark and
real safe file/Artifact previews remain. Any later first-use SVG or Usage
visualization stays governed by `docs/web-experience-improvement-plan.md` and
must not substitute for the hierarchy corrections here.

## 7. Server and Storage Design

### 7.1 Atomic Sandbox admission

Keep the existing atomic Task mutation boundaries:

- initial `AtomicTaskCreate` writes the Task, Library creation/binding, Run with
  `startupReadyAt: null`, initial message, and initial interaction in its
  admission transaction;
- released-Task `AtomicTaskMessage` writes the ready Run, message, initial
  interaction, and fixed accepted receipt in one transaction;
- released-Task Terminal start commits one ready Run reservation before fenced
  Kubernetes/Botified startup and before WebSocket transport.

Move namespace admission out of the current Task-create-only preflight. Pass
the configured namespace limit into each atomic create/restart operation. The
PostgreSQL adapter uses one internal admission implementation for every
trigger.

The namespace advisory lock is used only by admission and release
finalization. Those two writers use this relative lock order:

```text
namespace advisory lock
  -> Project
  -> policy / usage
  -> Task
  -> Run
  -> File Library
  -> writes
```

- A stage with no existing object is skipped; its relative position does not
  move. Initial create therefore locks the selected Library only after the Run
  counting/locking stage, while absent Task/Run rows are simply skipped before
  inserts occur in `writes`.
- A `sandboxLimit` policy update never takes the namespace advisory lock. It
  locks Project -> policy -> usage -> writes. Admission already locks Project
  after namespace, so both operations serialize on the Project row without
  adding a reverse namespace dependency.
- Other policy and Files/Library writers also take no unrelated namespace
  lock. Whenever writers touch shared objects, they retain the applicable
  Project -> policy/usage -> Task -> Run -> Library relative order and skip
  untouched stages.
- Active confirmation locks the applicable Project -> Task -> Run -> writes
  without namespace because it does not allocate or release capacity.
- Any startup failure moves the Run through `failed` and
  `release_requested`; neither transition changes capacity or the absolute
  usage projection, and neither takes the namespace advisory lock.
- Cleanup must obey the external-action deadline protocol below and positively
  confirm that all app-owned Kubernetes/Botified resources are absent. Only
  then does release finalization take namespace -> Project -> policy/usage ->
  Task -> Run -> Library -> writes, confirm that exact Run `released`,
  recompute both authoritative counts, and write the absolute Project usage
  projection in the same transaction. Failed or pending cleanup cannot free
  capacity by changing a counter or presentation.
- count every Run with `state != released`, not only `active` Runs;
- evaluate Project policy before namespace saturation in the locked snapshot,
  so simultaneous saturation deterministically returns Project rejection;
- apply namespace and Project policy limits before any Task, message, Run,
  Library bind, usage, or accepted Audit write;
- the in-memory store implements the same result contract;
- results distinguish `project_capacity_rejected` and
  `substrate_capacity_rejected`;
- a successful admission inserts one unreleased Run and then sets
  `project_resource_usage.active_tasks` to the absolute locked Run count;
- rejected admission writes only the idempotency record and one deduplicated
  rejected Audit record, with no admitted business state;
- remove the old non-atomic namespace preflight.

No Store or service API exposes a raw unreleased-Run insert. Tests and seed
helpers that exercise production behavior also enter through admission. The
adapter keeps unreleased-Run insertion private to the admission transaction
and rejects every call without that transaction's admission guard.

Focused Slice 1 migration `074` adds nullable
`sandbox_runs.startup_ready_at` and
`sandbox_runs.startup_action_deadline_at`, and performs the exact
generated-copy updates in section 6.5. It backfills existing `active` Runs
ready from database state and leaves existing `starting` Runs null. SQL does
not inspect the filesystem or transition starting Runs.

On application startup, the startup-recovery reconciler passes each legacy
null-ready `starting` Run to the preparation-recovery service. That service
uses the descriptor-safe marker contract: an exact marker resumes the same
staging/promotion operation; a missing or invalid marker atomically records
`failed`/`release_requested` and hands the Run to cleanup. Cleanup remains
independent of startup readiness.

Task-create filesystem work is operation-owned:

- open and validate the Project storage root, then create only
  `.preparations/<taskId>` through a descriptor-safe FD walk;
- prove the staging root is on the destination volume and outside every
  Library root and Sandbox mount before writing;
- create and later verify the operation marker through that FD walk;
- after admission, descriptor-walk both staging and the admitted Library
  destination, then promote only the marker-matched operation's content
  without following symlinks or overwriting a different operation's workspace;
- atomically mark startup ready only when `taskId`, `runId`, and
  `fencingToken` still identify the Task's current reserved Run;
- same-key retry reopens that same marker-matched staging root and resumes the
  same promote/ready sequence. It never creates a successor staging root,
  Task, interaction, Run, or Library binding.

The idempotency row owns the canonical request result for all three entry
points. Capacity rejection snapshots and serializes the section 6.1 envelope
once; same-key replay cannot recalculate its count, limit, message, or
presentation. Explicit Retry uses a new key.

One Store startup-claim operation is mandatory for every runtime path:

```ts
type SandboxStartupClaimResult =
  | { kind: "not_ready"; runId: string }
  | { kind: "in_progress"; runId: string }
  | { kind: "claimed"; runId: string; claim: string }
  | { kind: "stale" };
```

Inside one Store transaction it locks the applicable Project -> Task -> Run,
then requires the exact current Run, `state == starting`, matching operation
and fence, and non-null `startupReadyAt` before returning `claimed`. A null
readiness value returns `not_ready` for that persisted Run. `not_ready` is
ordinary in-progress state: it writes no failure, cleanup request, Audit,
Alert, interaction transition, claim lease, or resource record.

The five-second runtime tick, direct service startup, message dispatcher, and
every Kubernetes/Botified `create_resource`/`adopt_resource` startup path must
use that Store claim before external startup work. One successful claim remains
bound to the same operation/Run/fence across the complete Kubernetes
apply/create/adopt phase and the subsequent Botified readiness phase.
Kubernetes resources becoming started is not an intermediate Run confirmation:
the service must not clear, replace, or surrender the startup claim, confirm
the Run, or expose success at that boundary. Only final Botified-ready
confirmation may atomically set the Run `active` and terminate the claim; a
definitive startup error may terminate it only in the same transaction that
records canonical failure. None may check readiness in memory or call
`create_resource`/`adopt_resource` after a `not_ready` result.

The message dispatcher specifically leaves the initial or accepted interaction
pending and neither claims nor dispatches it until the associated Run is ready.
Its claim query also requires the message's persisted interaction; it can never
observe or dispatch a ready initial message without that interaction because
`AtomicTaskCreate` wrote both in the admission transaction.

Cleanup/release reconciliation is not a startup path and must not require
`startupReadyAt`. It can claim and remove residual resources, confirm resource
absence, and finalize release for a Run whose readiness is null, subject to the
action-deadline drain rule below. The readiness gate can never block cleanup of
failed, release-requested, cancelled, expired, or otherwise app-owned residual
Run resources.

#### Single-control-plane startup execution

This milestone deploys the AgentSmith API with `replicas: 1` and Kubernetes
Deployment `strategy.type: Recreate`. The checked-in manifest and every local
deployment configuration keep those values fixed; no value, patch, or rollout
path may run old and new AgentSmith API control-plane processes concurrently.
The old Pod must terminate before the new Pod starts. Multi-replica control
plane behavior remains a non-goal.

The one API process owns:

```ts
startupOperationsByRunId: Map<string, Promise<StartupResult>>;
```

The first same-Run caller installs the Promise before beginning external
startup work. Until it settles, every additional same-process same-Run caller
reports only `in_progress`. It does not acquire or take over a database lease
and cannot issue another external action. The owner resolves the Promise, and
the entry is removed only in its `finally` path.

Each external startup action has its own deadline cycle. Before a Kubernetes
`create_resource`/`adopt_resource` apply action, and separately before the
bounded Botified readiness action, a short Store transaction compare-and-sets
the exact current operation/claim/fence/resource identity and persists a fresh
future `startupActionDeadlineAt`. The CAS fails when another unexpired action
deadline exists. Each adapter call has a server/request hard deadline no later
than its persisted timestamp; Botified readiness cannot reuse the completed
Kubernetes action's deadline or wait without a bounded persisted deadline.

After a normally completed Kubernetes action, a short identity-checked
transaction clears that action's `startupActionDeadlineAt` and records the
resource/next phase while retaining the same startup claim/fence. It does not
confirm the Run `active`. The Botified readiness action then sets its own
deadline. Its successful completion atomically clears that deadline, records
the Run `active`, and terminates the claim. A definitive external failure
atomically clears the applicable deadline only while recording canonical
`failed`/`release_requested` state and terminating the claim.

A timeout, connection loss, process crash, or otherwise unknown external
result clears neither `startupActionDeadlineAt` nor the startup claim. Both
remain durable until the deadline expires and the drain/cleanup protocol below
has removed and re-listed all app-owned resources. Kubernetes/Botified I/O
never occurs inside the short Store transactions.

Process recovery and release obey one drain rule:

1. while `startupActionDeadlineAt` is non-null and unexpired, wait; do not
   cleanup, finalize release, or take over the database startup lease;
2. after the deadline, cleanup every app-owned resource associated with that
   Project/Task/Run, including any recorded or duplicate resource identity;
3. list again through Kubernetes/Botified using app ownership identity and
   require an empty result;
4. clear the drained deadline in a short identity-checked transaction;
5. only then may an identity-checked atomic failure terminate the old claim,
   release finalize, or crash recovery acquire a newly fenced database lease
   for that same Run.

The database lease is crash recovery only. Takeover requires both a drained
null action deadline and no local `startupOperationsByRunId` entry. Recreate
deployment guarantees the old API process cannot later issue a new action;
the persisted deadline and adapter hard deadline bound an already-issued
request. Do not add startup generations, rotating startup credentials,
webhooks, leader election, or another coordination mechanism.

For Terminal, `beginTerminalStart` is the sole Store entry. Its one transaction
validates the idempotency hash, binds the operation to one persisted Run, and
either exactly replays a completed receipt or converges an incomplete
operation from that bound Run's current state. Only `starting` writes/returns
HTTP 202 `in_progress`, always with the persisted `runId`; null readiness means
preparing and Terminal never marks it ready. `active` writes/returns the fixed
HTTP 200 receipt. `failed` or `release_requested` writes/returns the fixed
canonical failure receipt. `released` replays an already stored receipt or
writes/returns an explicit lifecycle failure and never restarts or reserves
for that same operation. Only a genuinely new operation against a released
Task may perform admission and atomically bind a new ready reservation.
After commit, one startup-claim transaction precedes the complete
Kubernetes-to-Botified sequence, and a separate action-deadline transaction
precedes each bounded external action. All external work remains outside the
transactions. The Terminal path retains the same claim after Kubernetes
resources start and may confirm `active` only after Botified readiness. Crash
recovery may acquire a new fenced claim for the same Run only after deadline
drain and absence of a same-process Promise.

Terminal active confirmation uses the shared object order without namespace.
Terminal failure completion is one transaction and validates operation ID,
request hash, current claim/fence, Project, Task, Run, Task current Run, and
resource identity before persisting `failed`/`release_requested` plus its
canonical idempotency result. A stale completion changes nothing. Same-key
callers observe HTTP 202 `in_progress` with the persisted `runId` only while
the bound Run remains `starting`; they then converge on the stored HTTP 200
active result or canonical failure. That failure replay remains the stored
pending-cleanup presentation even if a later GET observes completed release.
Only confirmed active returns command success; the existing Terminal WebSocket
then connects as pure authenticated transport.

### 7.2 Recursive deletion engine

Build one descriptor-anchored deletion engine with two explicit target
policies. This is code reuse below the product services, not a generic public
delete mode:

```ts
type DeletionTarget =
  | {
      kind: "entry";
      libraryRoot: string;
      relativePath: string;
      operationId: string;
    }
  | {
      kind: "library";
      libraryRoot: string;
      operationId: string;
    };
```

The `entry` policy requires a non-root relative path and rejects the Artifact
namespace itself, its descendants, and any ancestor whose recursive removal
would contain it. The `library` policy accepts exactly the canonical Library
root, including any internal Artifact content, only after Store state proves
the Library is `deleting` and no Task row references it. Neither policy is
selectable by the Web or exposed as a force/recursive flag.

Operation identity is unambiguous:

- entry deletion receives its stable operation ID from the existing request
  idempotency record; retrying the same idempotency key resumes it, while a new
  key is a new requested operation and cannot inherit the old source identity;
- Library deletion always uses the deterministic
  `file-library-delete:<libraryId>` identity stored on the Library row; every
  later authorized DELETE, regardless of request idempotency key, resumes that
  same physical operation until the row is finalized.

The owning service claims the operation identity before calling the engine.
The engine reuses the existing durable idempotency-operation storage to record
only isolated filesystem identity and phase for that operation. Entry deletion
linearizes at the descriptor-anchored atomic rename of the normalized source
name into its operation quarantine. The object at that name at the rename
instant is the operation target. Standard Node/Linux rename cannot compare an
expected pre-observed source inode, so no earlier inode observation claims the
operation target. The engine does not write Project usage, Audit, domain rows,
HTTP responses, or request completion.

The engine then:

1. validate the target policy and its operation identity;
2. open the canonical Library root as a directory without following symlinks;
3. for an entry, normalize the relative path and walk each parent relative to
   an opened directory descriptor; for a Library, anchor its canonical parent
   and the claimed root entry;
4. reject statically observed symlink or unsupported final targets, then
   enforce the selected root/Artifact policy;
5. create and durably validate one exact versioned operation marker containing
   kind, Project ID, canonical Library root, normalized relative path, and
   operation ID; entry deletion also includes its request hash, while the
   deterministic Library operation does not depend on one request receipt;
6. atomically rename the final entry through descriptor-anchored paths to
   `<projectRoot>/.deletions/<operationId>/entry`; a concurrent final-entry
   substitution is contained by quarantine, is never followed, and becomes the
   rename-time operation target;
7. descriptor-safely measure the quarantined entry and persist phase
   `isolated` with its device, inode, type, and aggregate regular-file bytes;
8. after the owning service persists its point-in-time Project accounting,
   remove the quarantine entry with an explicit descriptor walk, persist phase
   `removed`, remove the marker, and return control to the owning service.

The owning service is the sole completion owner:

- entry delete measures remaining active Library roots, persists the absolute
  Project byte value and one metadata-only entry-delete Audit event, asks the
  engine to remove quarantine, then completes the original request
  idempotency record;
- Library delete follows the lifecycle sequence in section 7.3 and is the only
  code allowed to finalize the Library row, write the Library-delete Audit
  event, and complete that DELETE request.

Those commits are idempotent by operation ID. Retrying a phase cannot create a
second usage mutation or Audit row.

The quarantine is on the same JuiceFS volume but outside every File Library
root and Sandbox mount, and storage accounting excludes it.

Linux descriptor-anchored `/proc/self/fd/<fd>` operations are required for this
contract. Measurement and physical removal explicitly walk opened directories
with `O_NOFOLLOW`; recursive string traversal and recursive `rm` are forbidden.
If descriptor anchoring is unavailable, deletion fails closed.

The database deletion phases are exactly `isolated | removed`. The exact marker
plus quarantine entry is the durable crash fact before `isolated` is persisted:

- if an exact-marker quarantine entry exists, recover its identity and bytes,
  persist `isolated`, and never touch the source path;
- if the marker exists without a quarantine entry, retry the atomic rename of
  the normalized source name; no pre-rename database source phase exists;
- once quarantine exists, every failure remains retryable under that same
  operation and cannot complete a permanent idempotency error;
- if physical deletion completed before the final response was stored,
  the owning service completes its remaining domain transaction and request
  without touching a recreated source path;
- server failures keep the same operation retryable rather than completing a
  permanent 500 result.

Do not load file contents or every descendant into memory, an API response, or
Audit detail. Accounting uses a complete point-in-time measurement; it does
not claim a cross-filesystem/database atomic snapshot while a Sandbox may
write another Library. It never attempts to reconstruct a removed directory
tree from memory.

Directory listing uses the same path boundary and returns
`file_path_not_found` when the requested folder is absent. Reserved Artifact
entries are filtered server-side, not merely hidden in the Web.

### 7.3 Library lifecycle serialization

Add the separate Slice 3 forward migration with a narrow File Library deletion
fence:

```text
active -> deleting
```

Successful removal means the row no longer exists; `removed` is not a public
Library lifecycle state. The migration adds only this public domain
lifecycle/identity state:

```text
lifecycle_status = active | deleting
deletion_operation_id = nullable stable string
```

The same Library row also carries the minimum private physical-operation state
needed for crash recovery and fencing: `isolated | removed` phase, quarantined
device/inode/entry type, aggregate bytes, and a claim token with lease expiry.
Those fields are Store-owned coordination state, are not part of
`FileLibrary`, and never appear in API projections. Request hashes remain only
on actor/key-scoped HTTP idempotency receipts; deterministic Project, Library,
and operation identity is sufficient for the one shared physical operation.

`deleting` is internal destructive-operation state, not a general workflow.
The row retains its immutable ID, Project, root path, and stable operation
identity until final removal. The operation identity is deterministic for that
immutable Library, such as `file-library-delete:<libraryId>`, so any later
authorized DELETE can resume the same physical deletion after refresh,
reauthentication, or a new idempotency key.

The existing process-local Project lifecycle lock may continue to serialize
work in one API process, but correctness comes from store operations:

- every Store mutation touching both scopes locks Project before Task before
  File Library, matching Sandbox admission after its namespace lock;
- `beginFileLibraryDeletion` locks Project then Library, verifies the Library
  is unbound, and compare-and-sets `active` to `deleting` with the stable
  operation ID;
- Task creation can bind only an `active` Library;
- rename, upload, entry delete, and other writes reject `deleting`;
- `finalizeFileLibraryDeletion` removes only the same Library ID and operation
  ID;
- an authorized DELETE against `deleting` resumes that one operation;
- a different mutation cannot reactivate or silently reuse that Library.

The process-local Project lifecycle lock may coordinate local filesystem names,
but it is not a binding or deletion correctness boundary. Do not broaden it
into a distributed lock abstraction.

Within Library deletion:

1. authorize and load the Library;
2. atomically claim `deleting` only if no Task row, including archived or
   soft-deleted tombstones, still references it;
3. descriptor-anchor and rename the canonical Library root to its deterministic
   same-volume quarantine;
4. measure the isolated root and remaining active Library roots and persist the
   point-in-time Project bytes;
5. recursively remove the isolated root;
6. finalize the claimed row, record one idempotent accepted Library delete
   event, and complete request idempotency.

If filesystem removal is interrupted, the Library remains `deleting`; the same
DELETE resumes safely and the Web offers Retry. It cannot be selected for a
new Task or modified. Do not restore an active row whose content may already
be partially removed, silently detach a Task, or add a background cleanup
controller.

Database foreign keys and the exclusive binding constraint remain intact.
Archived Tasks retain binding. Soft-deleted Task tombstones retain it until
successful purge; only purge releases the binding.

Before admission, every Task create writes only its operation-owned
`.preparations/<taskId>` staging root; it never mutates an existing Library
workspace. A create-new Library is likewise not projected or bindable from
that staging path. After the Store admits the Task and binds an `active`
Library, the service descriptor-safely promotes the same staging content into
the canonical workspace, then marks only that Run startup-ready. Promotion
failure leaves the admitted operation recoverable under the same Task/Run
identity and keeps `startupReadyAt: null`; it cannot race Library deletion,
become a second Library, or expose a partial workspace to a Sandbox.

### 7.4 One Library path boundary

Task workspace preparation, Artifact storage, Files operations, and deletion
must use the same canonical Library-root/path-validation service. Remove
parallel `path.resolve`-only Task implementations where they can create,
remove, or resolve Library content.

The Artifact namespace remains writable only through Task-owned application
methods. A Sandbox may publish through its Botified contract, but ordinary
Files routes cannot list or mutate the internal projection directory.

### 7.5 Usage and Audit integrity

- Recursive file and Library deletion updates stored Project file bytes to a
  complete post-operation point-in-time measurement.
- File and Library Audit records contain metadata only.
- Capacity rejection records the action the user actually attempted.
- No usage or Audit update is delegated to the Web.
- No report, evidence record, or cleanup log is introduced.

## 8. Web Architecture

### 8.1 State ownership

- Server presentation owns lifecycle, authorization, binding, and destructive
  capabilities; atomic mutation responses own Sandbox admission results.
- Run rows with `state != released` own capacity truth; the Project usage row is
  a server-only absolute projection and is never admission input.
- `startupReadyAt`, `startupActionDeadlineAt`, and `not_ready` are internal
  startup coordination. The Web receives the existing starting/progress
  presentation, not another public capability, lifecycle state, deadline, or
  error.
- URL owns selected Library and current folder.
- Files browser state owns selected entry, local filter/sort, and presentation
  page.
- Task URL exclusively owns the current peer view. User-and-Task-scoped
  `sessionStorage` owns only the unsent draft.
- A validated canonical same-origin application-relative `returnTo` owns the
  Task-to-Files return target; it is carried in the URL and never copied into a
  capability or browser store.
- Canonical `TaskPresentation.sandboxState` selects Terminal Start, progress,
  Connect, pending cleanup, or Unavailable. The single `openTerminal`
  capability authorizes the start/connect command only; Task readability makes
  the peer view selectable.
- Astryx owns primitive focus, overlay, input, button, and semantic styling.
- AgentSmith domain components own Task workbench, Files browser, and modal
  composition only where product semantics require composition.

### 8.2 Error treatment

All Slice 1 API clients parse only the section 6.1 envelope. Delete old
capacity envelopes and route-specific serializers rather than accepting both.
Project details are non-null; substrate and startup-failure details are null;
create capacity presentation is null; released-message and Terminal capacity
presentation is the original canonical released Task. Only Terminal may
receive `sandbox_start_failed`, whose stored presentation is canonical
failed/pending-cleanup and continues to show held capacity.

Map typed API errors at the affected action:

| Code | Product treatment |
| --- | --- |
| `project_sandbox_capacity_reached` | preserve draft/view; show Project count/limit and live Sandboxes |
| `substrate_sandbox_capacity_reached` | preserve draft/view; show local capacity guidance without a policy link |
| `sandbox_start_failed` | show failed/pending cleanup; do not offer Retry or a released surface until current Task state confirms release |
| `file_library_bound` | keep Library; show owning Task |
| `file_path_not_found` | clear stale entry and recover to selected Library root |
| `file_library_not_found` | select the nearest remaining Library or empty state |
| `file_library_deleting` | keep Library identity read-only and offer deletion retry |
| permission/lifecycle conflict | refresh server presentation and remove unavailable action |

Raw service, Kubernetes, JuiceFS, PostgreSQL, or Botified messages never appear
in ordinary Web copy.

### 8.3 Continuity

- Capacity failure preserves Task draft, focus, timeline, and Task identity.
- Ordinary navigation away from and back to a Task restores its valid
  user-scoped draft, but not an implicit peer view.
- Browser refresh/back/forward restores the valid peer view owned by that
  history entry. Peer view is never restored from `sessionStorage`.
- Task -> Files includes the validated canonical `returnTo`; Files returns to
  that exact Task peer-view URL. Invalid or external input is discarded and
  falls back to Conversation.
- Task list, Alert, search, copied/direct, and other product navigation enters
  the Task at Conversation even if an earlier local view existed.
- Same-key capacity replay preserves the original canonical error. Same-key
  Terminal startup failure preserves its failed/pending-cleanup presentation;
  it never fabricates released state. Only an explicit capacity Retry creates
  a new key and may observe changed capacity.
- Folder deletion preserves the parent folder, Library, filter, and sort.
- Library deletion selects the nearest remaining Library and resets folder and
  entry state once.
- Refresh and recoverable failure keep known-good content visible.
- Dialog validation or mutation failure keeps entered values and the dialog
  open.
- No success toast is the only source of a persistent new state.

## 9. Implementation Slices

Each slice is one server-plus-Web behavior. Complete it and delete the replaced
path before moving on.

### Slice 1: Sandbox capacity coherence

Deliver:

- canonical scoped Sandbox admission contract, Project-first precedence, and
  the sole retryable error envelope;
- one atomic Project/namespace admission path for all cold starts;
- unreleased Run-row counting, absolute same-transaction Project usage
  projection, and no bypass path for unreleased Run creation;
- operation-owned Task-create staging at Project
  `.preparations/<taskId>`, outside every Library root/Sandbox mount, with
  descriptor-safe same-volume promotion;
- nullable persisted Run `startupReadyAt`: null for initial Task-create
  reservation, exact-transitioned after promotion, and ready in released-Task
  message/Terminal restart reservation;
- one `AtomicTaskCreate` admission write set containing Task, Library
  creation/binding, reserved Run, initial message, and initial interaction;
  dispatcher-visible initial message without its interaction is impossible;
- nullable persisted `startupActionDeadlineAt`, independently set by CAS for
  each Kubernetes apply/adopt action and bounded Botified readiness action;
  normal completion clears that action's deadline, while timeout/unknown
  completion retains it through deadline drain and cleanup;
- one transactional ready-gated startup claim used by runtime tick, direct
  startup, message dispatch, and all Kubernetes/Botified
  `create_resource`/`adopt_resource` plus readiness paths; the claim spans the
  entire apply-to-readiness sequence and ends only with final `active` or
  atomic failure, while `not_ready` remains side-effect-free in-progress and
  never gates cleanup/release reconciliation;
- namespace -> Project object order only for admission/release finalization,
  plus Project -> policy -> usage serialization for Sandbox-limit update with
  no namespace lock;
- exact same-key capacity rejection replay and explicit new-key Retry;
- committed Terminal reservation, transaction-free fenced startup, active-only
  success, same-Run in-progress/convergence, capacity-holding
  failed/release-requested cleanup, canonical pending-cleanup failure replay,
  and transport-only WebSocket;
- one Terminal-specific Store transaction binding an operation to one Run:
  only `starting` returns HTTP 202 with persistent `runId`, `active` fixes HTTP
  200, `failed`/`release_requested` fix failure, and `released` replays or
  fixes failure without restarting that operation; only a new operation may
  admit/reserve from a released Task, and crash-only same-Run fenced lease
  recovery follows deadline drain;
- one-process `startupOperationsByRunId` Promise ownership, with unsettled
  same-Run calls returning only in-progress and no lease takeover;
- one-replica AgentSmith API deployment using `Recreate`, with manifests and
  configuration forbidding old/new control-plane overlap;
- accepted released-message behavior in which post-admission startup failure is
  durable Run/interaction state and never a `sandbox_start_failed` request;
- `AtomicTaskMessage` transactionally writing the ready Run, message, initial
  interaction, and fixed accepted receipt together;
- always-selectable Terminal peer view, one command-only `openTerminal`
  capability, and `sandboxState`-driven static surfaces;
- user-and-Task-scoped draft, history/validated-return URL peer view, and
  Conversation for every other Task entry;
- one 32,768 UTF-8-byte session draft-snapshot ceiling using `TextEncoder`,
  with non-blocking over-limit behavior and no message submission limit;
- one neutral, non-duplicated released-state presentation;
- public `sandboxLimit`/`activeSandboxes`, Alert
  `sandbox_capacity`/`active_sandboxes`, and no public aliases;
- adapter-only outward mapping for retained private SQL/Alert legacy values;
- focused Slice 1 migration `074` adding `startup_ready_at` and
  `startup_action_deadline_at`, backfilling old active Runs ready solely from
  database lifecycle fact, leaving old starting Runs null, and updating exact
  generated Alert/notification copy; application startup reconciliation, not
  SQL, owns marker validation and old starting-Run recovery/failure cleanup;
- trigger-correct, idempotently deduplicated rejection Audit, with no
  count/limit or Project Alert for substrate rejection;
- create rejection with no admitted business state; pre-admission directory
  failure keeps its own error, while post-rejection compensation failure cannot
  hide the capacity envelope and leaves remnants invisible/unbindable;
- deletion of old visible `active task` copy, capacity envelope, route
  serializer, public alias, and WebSocket admission.

Implementation/commit order:

1. Write the focused failing Store/contract tests for all three entry points,
   Project-first simultaneous saturation, mixed races, replay, lock-sensitive
   finalization/policy updates, atomic initial message/interaction creation,
   startup readiness/claim lifetime/action deadlines, runtime-tick pickup, and
   absolute projections.
2. Add focused Slice 1 migration `074` for nullable `startup_ready_at`,
   nullable `startup_action_deadline_at`, active-Run readiness backfill,
   leaving existing starting Runs null, and exact generated copy.
3. Implement descriptor-safe Project `.preparations/<taskId>` staging,
   operation marker, same-volume promotion, capacity-rejection cleanup,
   same-operation recovery, the application startup reconciler and
   preparation-recovery service for old starting Runs, ready-gated startup
   claim, `AtomicTaskCreate`, and message/interaction dispatch gating.
4. Write failing Terminal service/API tests, then implement the dedicated
   atomic Store begin method, ready restart reservation, preparing behavior for
   null-ready starting Runs, `startupOperationsByRunId`, action-deadline CAS,
   bounded Kubernetes apply plus independently bounded Botified readiness under
   one continuous claim, crash-only lease recovery, active confirmation,
   failed/release-requested cleanup, exact pending-cleanup replay, and pure
   WebSocket transport.
5. Implement the remaining admission lock orders, release finalization,
   deadline drain/list-empty cleanup, namespace-free Sandbox-limit update,
   canonical envelope, `AtomicTaskMessage`, idempotency, Audit/Alert rules, and
   adapter-only private enum/column mappings.
6. Set the AgentSmith API manifest to one replica and `Recreate`; remove or
   reject every configuration path that could overlap control-plane instances.
7. Write failing Web/client tests for envelope mapping, snapshot-only draft
   ceiling, always-selectable Terminal surfaces, scoped URL view, `returnTo`,
   and public names; then implement message/Terminal/create recovery and
   continuity.
8. Delete replaced serializers, old public aliases, WebSocket admission, and
   duplicated released-state/capacity copy.

Primary modules:

- `packages/contracts/src/api.ts`
- `packages/ports/src/store.ts`
- `packages/adapters-postgres/src/inMemoryProductStore.ts`
- `packages/adapters-postgres/src/postgresProductStore.ts`
- `packages/application/src/projectPolicyService.ts`
- `packages/application/src/taskService.ts`
- `packages/api-entry-node/src/server.ts`
- `src/lib/api/client.ts`
- `src/components/tasks/TaskCreateDialog.tsx`
- `src/components/tasks/TaskDetailPage.tsx`
- `src/components/tasks/TaskComposer.tsx`
- `src/components/tasks/TaskTerminalPanel.tsx`
- `src/components/resources/UsageView.tsx`
- `src/components/resources/ResourcePolicyPage.tsx`
- `src/components/alerts/*`
- AgentSmith API Deployment manifests and local deployment configuration

Focused checks:

- each of create, released message, and released Terminal admits with room,
  rejects at Project capacity, rejects at namespace-only capacity, and exactly
  replays that rejection for the same key;
- when both scopes are full, all three entry points return Project rejection
  with non-null `activeSandboxes`/`sandboxLimit`;
- mixed concurrent create/message/Terminal requests for one remaining Project
  or namespace slot produce one winner, no limit breach, no orphan message,
  and no duplicate/unadmitted unreleased Run;
- admission racing release finalization and `sandboxLimit` update observes the
  prescribed separate lock orders, has no namespace lock in policy update,
  remains serialized by Project, observes authoritative `state != released`
  rows, and has an absolute usage projection after every admission/release
  commit;
- active Task messaging consumes no new slot; no production path can insert an
  unreleased Run outside admission;
- initial Task-create reservation persists `startupReadyAt: null`; released
  message/Terminal restart reservation is ready because it reuses the promoted
  workspace; a mismatched Task, Run, or fence cannot ready the initial Run;
- `AtomicTaskCreate` admission writes the Task, Library creation/binding,
  reserved Run, initial message, and initial interaction in one transaction;
  rollback removes the whole write set and dispatcher observation can never
  split the message from its interaction;
- before Task-create admission, all writes stay under the operation-owned
  Project `.preparations/<taskId>` root, outside every Library root and Sandbox
  mount; preparation failure returns its own error;
- capacity rejection removes only that staging root; cleanup failure preserves
  the exact capacity envelope and any remnant remains invisible/unbindable;
- the five-second runtime tick, message dispatcher, direct startup, and every
  Kubernetes/Botified `create_resource`/`adopt_resource` startup path return
  `not_ready` or in-progress before promotion, create no startup
  resource/claim/failure, and leave the interaction pending;
- cleanup/release reconciliation ignores startup readiness and can remove
  residual resources plus finalize a Run whose `startupReadyAt` is null;
- descriptor-safe same-volume promotion followed by the exact
  `taskId`/`runId`/`fencingToken` transaction is the only transition to ready;
  only then can one startup claim succeed;
- that claim remains current across Kubernetes apply/create/adopt and Botified
  readiness; a Kubernetes-started resource cannot cause intermediate active
  confirmation or claim release, and only atomic final `active` or failure
  ends the claim;
- same-key Task-create retry resumes the marker-matched staging root,
  promotion, Task, interaction, and Run; it cannot reserve or promote a
  successor;
- create rejection persists only exact idempotency plus one deduplicated
  rejected Audit; directory preparation failure before admission returns its
  own error, while failed compensation after a decided capacity rejection
  cannot change the envelope, expose a Library, or make a remnant bindable;
- Project rejection Audit has canonical count/limit, while substrate Audit has
  neither and emits no Project `sandbox_capacity` Alert;
- Terminal reservation commits before one fenced out-of-transaction start;
  same-key concurrency observes in-progress or the same Run, success waits for
  active, failure enters failed/release_requested and returns exact
  pending-cleanup replay, capacity remains held until confirmed resource
  absence and release finalization, and no pre-success WebSocket mounts;
- Terminal idempotency begin/replay and bound-Run convergence are one Store
  transaction: only `starting` returns HTTP 202 with its persisted `runId`,
  `active` fixes HTTP 200, `failed`/`release_requested` fix canonical failure,
  and `released` replays its stored receipt or fixes explicit failure without
  restarting that operation; only a new operation may admit/reserve from a
  released Task, and a starting/null-ready Run remains preparing without a
  Terminal ready write;
- while `startupOperationsByRunId` holds an unsettled Promise, same-Run calls
  return only in-progress and neither take over the lease nor issue another
  external action;
- before each Kubernetes `create_resource`/`adopt_resource` action and the
  separate Botified readiness action, Store CAS persists matching claim/fence
  and a fresh `startupActionDeadlineAt`; adapter hard deadlines do not exceed
  the applicable timestamp, normal completion clears that action's deadline
  without dropping the claim, and timeout/unknown completion retains both
  through deadline drain and cleanup;
- process recovery/release waits out an unexpired action deadline, then cleans
  all app-owned resources and re-lists empty before clearing the deadline;
  crash-only lease takeover requires the drained deadline and no local Promise;
- Terminal failure completion changes state only when operation, `requestHash`,
  claim/fence, Project, Task, Run, Task current Run, and resource identity all
  match; every stale mismatch is a no-op/error;
- released-message admission persists the message before startup; later
  readiness/startup/dispatch failure appears only in Run/interaction state and
  never changes the fixed accepted HTTP receipt/replay or stores a message
  `sandbox_start_failed` envelope; Run, message, initial interaction, and that
  receipt are one `AtomicTaskMessage` transaction;
- every retryable Slice 1 failure has exactly
  `{error:{code,message,retryable:true,details,presentation}}`, with the
  required nullability and no legacy envelope/serializer;
- drafts at 32,768 UTF-8 bytes persist; above that ceiling they remain editable
  and submittable while persistence stops, the old snapshot is removed, and a
  non-blocking hint appears; returning within the ceiling resumes persistence
  and removes the hint;
- capacity rejection preserves the draft; browser history restores its URL
  view; Task -> Files -> validated `returnTo` -> Task restores that view;
  cross-origin or malformed `returnTo` is ignored; every other Task entry
  opens Conversation; peer view is absent from storage;
- readable Tasks always expose Terminal, `openTerminal` authorizes only the
  command, and each `sandboxState` renders exactly one static
  Start/progress/Connect/Pending-cleanup/Unavailable surface;
- API/Web payload assertions contain only `sandboxLimit`, `activeSandboxes`,
  `sandbox_capacity`, and `active_sandboxes`; old public names are rejected and
  retained private storage names are adapter-confined;
- migration `074` only adds nullable `startup_ready_at` and
  `startup_action_deadline_at`, backfills existing active Runs ready from
  database lifecycle fact, leaves existing starting Runs null, and rewrites
  only exact generated Alert/notification copy; the application startup
  reconciler and its preparation-recovery service validate markers, resume a
  matching old starting Run, or move a missing/invalid-marker Run to
  failure/cleanup, and Slice 3 retains its distinct lifecycle migration;
- deployment assertions require exactly one AgentSmith API replica,
  `strategy.type: Recreate`, no old/new Pod overlap, and no generation,
  credential, webhook, or multi-controller mechanism.

Slice completion:

- all three entries share one admission authority and exact replay behavior;
- Run rows, not usage projection, decide capacity; release and policy updates
  use their specified separate lock orders;
- no startup-capable path can outrun Task-create promotion because every claim
  requires persisted readiness in its Store transaction;
- Task-create retry converges on its marker-matched staging/Run identity;
- same-process startup converges through one Promise, while database lease
  recovery occurs only after crash, deadline drain, and local-operation
  absence;
- single-replica Recreate deployment prevents control-plane process overlap;
- Terminal start is fenced outside the transaction and the WebSocket is pure
  transport; failed cleanup remains capacity-holding and is never presented as
  released;
- no retained public contract calls Sandbox allocation `active Task capacity`,
  and substrate saturation has no count/limit, Project-policy link, or Project
  Alert;
- Slice 1 migration `074` adds startup readiness/action deadline plus generated
  copy while private legacy enum/column values remain adapter-confined; Slice 3
  retains its separate forward Library lifecycle migration.

### Slice 2: File and folder object behavior

Deliver:

- single-click selection for files and folders;
- explicit folder Open action, desktop double click, and keyboard behavior;
- folder details and object-specific Delete confirmation;
- recursive server deletion with path/symlink protection;
- descriptor-anchored same-volume isolation before recursive removal;
- reserved `workspace/.artifacts` behavior across list and mutation routes;
- typed missing-folder recovery to the selected Library root;
- aggregate byte accounting and one Audit event;
- selection, URL, preview, and presentation-page repair after deletion;
- deletion of the regular-file-only branch and hidden secondary selection
  behavior.

Implementation/commit order:

1. Rename-linearized descriptor-anchored delete operation/idempotency state,
   exact-marker recovery, and reserved-path policy.
2. FileService entry delete, point-in-time accounting, Audit, and missing-path
   contract.
3. Files row selection/open/details/delete and narrow-region behavior.

Primary modules:

- `packages/contracts/src/api.ts`
- `packages/application/src/filePathValidationService.ts`
- `packages/application/src/fileService.ts`
- `packages/application/src/fileLibraryService.ts`
- `packages/application/src/projectPolicyService.ts`
- `packages/api-entry-node/src/server.ts`
- `src/lib/api/client.ts`
- `src/components/files/ProjectFilesPage.tsx`

Focused checks:

- select and open file/folder with pointer, keyboard, and narrow layout;
- delete a file, empty folder, and nested non-empty folder;
- reject Library root, traversal, symlink, and unsupported entry types;
- reject reserved Artifact paths and an ancestor deletion that would remove
  them;
- recover a crash after rename but before database `isolated` persistence
  without touching a recreated source path;
- a concurrently replaced parent cannot redirect deletion outside the selected
  Library;
- recursive delete removes only the selected Library subtree;
- complete point-in-time Project file bytes remain correct;
- one directory delete creates one content-free Audit event;
- stale/missing selected entry recovers in place;
- an externally removed current folder recovers to the selected Library root
  rather than showing an empty-folder state.

Slice completion:

- file and folder rows share one selection model;
- folder deletion is a complete server-owned product path;
- no recursive mode, batch API, or file index is added.

### Slice 3: Unbound File Library deletion

Deliver:

- shared lifecycle serialization for Task binding and Library mutation;
- the distinct Slice 3 forward `active | deleting` Library lifecycle
  migration;
- one recursive unbound-Library delete application path;
- bound-Library rejection with owning Task;
- complete point-in-time post-delete file usage;
- one File Library delete Audit action;
- one destructive confirmation and updated capability copy;
- deletion of empty-only checks and compensation behavior;
- deterministic same-volume deletion quarantine and idempotent retry.

Implementation/commit order:

1. Forward migration, Store begin/finalize/resume operations, Task bind gating,
   and concurrency tests.
2. Library service/API reuse of the recursive deletion primitive, accounting,
   and destructive Audit.
3. Active/deleting/bound Library presentation, confirmation, retry, and
   post-Task-delete availability.

Primary modules:

- `packages/contracts/src/api.ts`
- `packages/ports/src/store.ts`
- `packages/adapters-postgres/src/inMemoryProductStore.ts`
- `packages/adapters-postgres/src/postgresProductStore.ts`
- `packages/application/src/fileLibraryLifecycleLock.ts`
- `packages/application/src/filePathValidationService.ts`
- `packages/application/src/fileLibraryService.ts`
- `packages/application/src/fileService.ts`
- `packages/application/src/taskService.ts`
- `packages/api-entry-node/src/server.ts`
- `src/lib/api/client.ts`
- `src/components/files/ProjectFilesPage.tsx`

Focused checks:

- delete empty and non-empty unbound Libraries;
- reject bound active and archived Task Libraries without data loss;
- Task create versus Library delete has one database winner;
- interrupted filesystem removal leaves a retryable deleting Library, never an
  active partially deleted Library;
- repeated idempotency key does not delete a later Library;
- failure does not detach a Task or report false success;
- complete point-in-time Project bytes and one Library delete Audit event
  remain;
- nearest Library and empty-state behavior are correct after success;
- successful Task purge makes its Library Available with ordinary files
  unchanged, while conversation/session/Artifact access is gone;
- a deleting Library remains visible and retryable after refresh and
  reauthentication.

Slice completion:

- content no longer controls Library delete capability;
- binding remains the only business prohibition;
- there is one delete path and no force-mode fork;
- no Files operation can mutate the Task Artifact namespace.

### Slice 4: Shared shell and dialog correction

Deliver:

- remove static Topbar shadow and duplicate page-header divider treatment;
- align shell, header, toolbar, and body gutters/rhythm;
- retain a compact full-height Task workbench header;
- replace the nested-Layout dialog anatomy with direct Astryx
  `Dialog`/`DialogHeader` and `AlertDialog` use;
- migrate every retained dialog caller and delete the replaced implementation;
- correct focus, dismissibility, low-height scrolling, and narrow actions;
- refine AgentSmith theme surfaces and state distinctions without adding a
  second visual source.

Primary modules:

- `src/theme/agentSmithTheme.ts`
- `src/components/app-shell/Topbar.tsx`
- `src/components/app-shell/AppShell.tsx`
- `src/components/layout/PageHeader.tsx`
- `src/components/layout/PageLayout.tsx`
- delete `src/components/ui/Dialog.tsx` after callers use Astryx directly
- all retained dialog callers
- Task, Files, Usage, Alerts, Audit, directory, and settings compositions where
  shared-layer changes expose a real hierarchy defect

Focused checks:

- representative standard, full-width, data-dense, settings, and Task pages in
  light and dark;
- one desktop, one narrow width, and one low-height viewport;
- form, information, destructive, validation-error, busy, and long-content
  dialogs;
- simple two-action confirmation uses Astryx `AlertDialog`; forms,
  typed-name confirmation, and rich mutation recovery use direct Astryx
  `Dialog` composition without a generic AgentSmith wrapper;
- keyboard open/close, safe initial focus, focus return, Escape/backdrop, and
  200%/400% zoom where the changed composition is affected;
- 320 CSS px, enlarged text, low-height landscape, soft keyboard/safe area,
  forced colors, and applicable 44x44 touch targets;
- route change, Files deletion, Details Sheet close, and dialog close focus
  land on the named destination, surviving row, or original trigger;
- Task page/timeline have one scroll owner and streaming updates do not steal
  focus or spam live regions;
- no static shell shadow, duplicated divider, clipped dialog action, or page
  title styled like a panel title remains.
- Released state appears once with neutral paused semantics, and Task details
  do not consume primary work height until requested.

Slice completion:

- Topbar has one boundary and no static shadow; standard Page Header has no
  default full-width divider; header/body gutters align without an extra panel
  gap;
- every retained dialog has one anatomy and Astryx primitive path;
- 320px width, 1366x768, one low-height viewport, and 400% zoom keep the current
  object, primary action, work content, and dialog actions reachable without
  overlap, clipping, or page-level horizontal scroll;
- focus enters the correct dialog target, destructive confirmation defaults to
  the safe action, and focus returns to the trigger;
- no legacy or parallel visual implementation is introduced.

### Slice 5: Product coherence pass

Use the existing local single-node K8s deployment and real configured
OpenAI-compatible endpoint. Work serially and fix observed defects in place.
The AgentSmith API Deployment has exactly one replica and
`strategy.type: Recreate`; redeploy must terminate the old API Pod before
starting the new one.

Product path:

1. Deploy/redeploy and confirm one AgentSmith API Pod, Recreate strategy, and no
   old/new control-plane overlap; then complete OIDC login and Project open.
2. Inspect and change Sandbox capacity.
3. Fill capacity, open a released Task, preserve a draft, and observe the
   blocked message and Terminal treatment.
4. Navigate from that Task to Files and back as the same user, then confirm its
   draft and selected view remain.
5. Release another Sandbox and continue the same Task/session/Library.
6. Select, open, and delete file and folder entries; remove the current folder
   externally and observe Library-root recovery.
7. Confirm Files cannot browse or mutate the Artifact namespace.
8. Delete a non-empty unbound Library and reject a bound Library.
9. Inspect resulting Usage, Alert, and Audit semantics.
10. Traverse Task, Files, Usage, Alerts, Audit, one directory, and one settings
   page in light/dark and narrow/desktop composition.
11. Open representative form and destructive dialogs.

This is an active developer check, not a stored suite or release gate. Do not
commit screenshots, traces, reports, evidence directories, or a generic
runner.

Slice completion:

- the AgentSmith API manifest/configuration permits exactly one replica and a
  non-overlapping Recreate rollout;
- the real path produces the user outcomes in section 3;
- defects found on this exact path are corrected in their owning code;
- no unrelated feature expansion or governance artifact is left behind.

## 10. Focused Testing Discipline

Use focused TDD for changed business risk: add the exact failing behavior test,
make the owning implementation pass, and delete replaced-path assertions in
the same Slice. Slice 1 coverage is mandatory and remains serial:

- Store tests cover create, released message, and released Terminal separately
  at Project capacity, namespace capacity, and simultaneous saturation;
- concurrency tests cover mixed create/message/Terminal contention, admission
  versus release finalization, admission versus Sandbox-limit update, one-slot
  winners, namespace locking only for admission/release finalize,
  Project-serialized namespace-free policy update, authoritative
  unreleased-Run counts, absolute usage projection, and rejection of every
  unreleased-Run bypass;
- startup-readiness Store tests prove initial Task create starts null, released
  message/Terminal restart reserves ready, only the exact Task/Run/fence can
  ready a prepared initial Run, `not_ready` has no startup side effects, and
  runtime tick, dispatcher, direct startup, and every Kubernetes/Botified
  `create_resource`/`adopt_resource` startup path share the transactional gate;
- `AtomicTaskCreate` Store/concurrency tests prove admission commits or rolls
  back Task, Library creation/binding, Run, initial message, and initial
  interaction together; even when readiness changes concurrently, dispatcher
  queries never observe a ready initial message without its interaction;
- cleanup/release tests prove reconciliation can claim residual cleanup,
  confirm resource absence, and finalize release when
  `startupReadyAt: null`;
- Task-create service tests prove pre-admission writes are confined to the
  descriptor-safe FD-walked Project `.preparations/<taskId>` root outside all
  Library roots and Sandbox mounts; exact operation marker and same-volume
  promotion precede ready, and the five-second tick cannot claim the initial
  pending interaction before it;
- idempotency tests cover exact same-key capacity/error replay, deduplicated
  rejected Audit, explicit new-key Retry, Terminal in-progress/same-Run
  convergence, failed/pending-cleanup startup replay, same-staging Task-create
  recovery, pre-admission preparation errors, and
  invisible/unbindable post-rejection cleanup remnants;
- Terminal service/API tests prove reservation commit precedes one fenced K8s
  start outside the transaction, success follows active confirmation, failure
  remains capacity-holding through `failed`/`release_requested`, release waits
  for confirmed resource absence, failure replay never claims released, and
  WebSocket transport never admits or starts;
- Terminal Store tests prove begin/hash/replay and bound-Run state convergence
  are one transaction: only `starting` writes HTTP 202 with a persisted
  `runId`; `active` writes the fixed HTTP 200 receipt;
  `failed`/`release_requested` write the fixed canonical failure receipt; and
  `released` replays its stored receipt or writes explicit failure without
  reserving/restarting that operation. A new operation may reserve ready from
  a released Task, while a starting/null-ready Run remains preparing without a
  Terminal ready write;
- in-process startup tests prove `startupOperationsByRunId` installs one shared
  Promise, every additional same-Run caller returns only `in_progress`, no
  same-process lease takeover or second external action occurs, and `finally`
  removes the settled entry;
- startup-claim lifecycle tests prove one operation/Run/fence claim remains
  held through Kubernetes apply/create/adopt and independently bounded
  Botified readiness; Kubernetes resources reaching started cannot confirm
  active or clear the claim, and only an identity-checked final `active` or
  atomic `failed`/`release_requested` transaction terminates it;
- action-deadline tests prove Store CAS persists matching claim/fence plus
  a fresh `startupActionDeadlineAt` before each Kubernetes
  `create_resource`/`adopt_resource` action and separately before Botified
  readiness; each adapter request/server deadline never exceeds its own
  persisted value, normal completion clears only that action deadline while
  preserving the claim between phases, and readiness success atomically clears
  its deadline, records `active`, and ends the claim;
- recovery/release tests prove an unexpired action deadline causes waiting with
  no cleanup/finalize/takeover and timeout/unknown completion clears neither
  deadline nor claim; after expiry all app-owned resources are cleaned and
  re-listed empty before deadline drain, atomic failure/claim termination,
  release, or crash-only same-Run lease recovery with no local Promise;
- Terminal failure-completion tests independently mismatch operation,
  `requestHash`, claim/fence, Project, Task, Run, current Run, and resource
  identity and prove each stale completion leaves all state unchanged;
- released-message tests prove `AtomicTaskMessage` writes the ready Run,
  message, initial interaction, and fixed accepted receipt in one transaction,
  and any later startup/dispatch failure is durable Run/interaction state
  rather than `sandbox_start_failed` or a changed HTTP/idempotency receipt;
- API contract tests assert the sole error envelope and its exact Project,
  substrate, create, message, and Terminal nullability, canonical message, and
  presentation rules;
- Web/client tests cover draft preservation, snapshot-only 32,768 UTF-8-byte
  `TextEncoder` ceiling and non-blocking overflow recovery, history/return-only
  URL peer view, Conversation default for other Task entries, canonical
  same-origin relative `returnTo`, readable-Task Terminal surfaces, and no
  multiple Terminal capabilities;
- public-contract tests permit only `sandboxLimit`, `activeSandboxes`,
  `sandbox_capacity`, and `active_sandboxes`, and prove private old
  SQL/Alert values cannot escape the adapter;
- Slice 1 migration `074` tests add nullable `startup_ready_at` and
  `startup_action_deadline_at`, backfill existing active Runs ready solely from
  database lifecycle fact, leave existing starting Runs null, update only
  exact generated Alert/notification copy, and preserve near matches,
  user-authored copy, private enums, and other private column names; they
  perform no filesystem or marker assertion;
- application startup reconciler service tests prove exact marker validation
  resumes the same old starting Run and staging/promotion operation, while a
  missing or invalid marker atomically records
  `failed`/`release_requested` and hands cleanup an ungated null-ready Run;
- deployment tests/assertions prove the AgentSmith API manifest has
  `replicas: 1` and `strategy.type: Recreate`, configuration cannot overlap old
  and new control-plane Pods, and no generation/credential/webhook mechanism
  is introduced;
- Store tests also cover atomic capacity and Library-binding races;
- service tests for Task cold-start, Project/namespace admission, recursive
  deletion, descriptor-anchored symlink/parent replacement resistance,
  reserved paths, accounting, and idempotency;
- separate Slice 3 migration/store tests cover `active | deleting`,
  bind-versus-delete, and interrupted deletion retry;
- API contract tests for typed errors and final response shape;
- focused Web state/client behavior tests only where continuity or error
  mapping has non-trivial logic;
- temporary manual browser checks for layout, dialogs, keyboard, responsive
  composition, and real Task behavior.

Do not add:

- screenshot baselines;
- broad page snapshots;
- style-class assertions;
- tests of Astryx, Playwright, helpers, scripts, or the test runner;
- a permanent E2E suite for the manual product path;
- coverage gates, release gates, reports, or evidence output.

Run builds, tests, browsers, image work, and K8s operations serially. Keep only
the local cluster needed for the current product path.

## 11. Required Deliverables

The development team delivers:

- final API contract and focused Slice 1 migration `074` adding nullable
  `sandbox_runs.startup_ready_at` and
  `sandbox_runs.startup_action_deadline_at`, database-fact active-Run
  readiness backfill, unchanged null readiness for old starting Runs, and
  exact generated Alert/notification updates, while private Alert/storage enum
  and other column names remain adapter-mapped;
- the distinct Slice 3 forward File Library `active | deleting` lifecycle
  migration; these are two focused migrations, not one combined or
  ambiguously named migration;
- server-owned Project/substrate Sandbox admission and typed capacity failures;
- Run-row capacity authority, absolute usage projection, capacity-writer lock
  order for admission/release finalization, namespace-free Project-serialized
  Sandbox-limit updates, exact rejection replay, and no unreleased-Run bypass;
- operation-owned Project `.preparations/<taskId>` staging, descriptor-safe
  FD walk and operation marker, same-volume workspace promotion, exact fenced
  ready transition, and same-staging/Run recovery;
- `AtomicTaskCreate` admission that writes Task, Library creation/binding,
  reserved Run, initial message, and initial interaction together, plus a
  dispatcher contract that cannot expose a ready message without interaction;
- an application startup reconciler plus preparation-recovery service that
  validates old starting-Run markers, resumes only an exact operation match,
  and sends missing/invalid-marker Runs to failed/release cleanup;
- one transactional startup-ready claim required by runtime tick, dispatcher,
  direct startup, and every Kubernetes/Botified apply/adopt/readiness startup
  path; it remains held from Kubernetes work through final Botified readiness
  and ends only at atomic `active` or failure, without gating cleanup/release
  reconciliation;
- one-process `startupOperationsByRunId` Promise ownership and persisted
  action-deadline CAS independently around every external Kubernetes
  `create_resource`/`adopt_resource` action and bounded Botified readiness
  action, with adapter hard deadlines, normal per-action clearing, and
  unknown-result deadline-drained cleanup/re-list before release or crash
  recovery;
- exactly one AgentSmith API replica with Recreate deployment and no
  configuration path for overlapping control-plane processes;
- fenced transaction-free Terminal startup with active-only success,
  capacity-holding failed/pending cleanup, exact non-released failure replay,
  and a pure transport WebSocket;
- one Terminal Store begin transaction with bound-Run convergence: only
  `starting` produces in-progress with persistent `runId`, `active` fixes HTTP
  200, `failed`/`release_requested` fix failure, and `released` replays or
  fixes failure without restarting that operation; plus preparing behavior for
  a starting/null-ready Run, crash-only deadline-drained same-Run lease
  recovery, and full-identity atomic failure completion;
- `AtomicTaskMessage` transactionally fixed accepted receipt, with later
  startup/dispatch failure represented only by durable Run/interaction state;
- one error envelope plus coherent message, Terminal, Usage, Policy, Alert, and
  Audit behavior using only canonical public Sandbox names;
- user-and-Task-scoped draft with snapshot-only byte ceiling,
  history/validated-return URL peer view, Conversation default elsewhere, and
  validated Task-to-Files return continuity;
- recursive file/folder and unbound-Library deletion;
- descriptor-anchored deletion, protected Artifact storage, and corrected File
  Library lifecycle/binding behavior;
- Files selection/open/delete experience;
- corrected shell, page header, dialog anatomy, and Astryx visual hierarchy;
- updated `docs/api-contract.md`, `docs/architecture.md`,
  `docs/storage-and-files.md`, and the authority notes in superseded plans;
- focused tests for changed core logic;
- the working local single-node K8s product, fixed in place.

The team does not deliver a test report, evidence archive, migration ledger,
rehearsal document, release report, visual baseline, or new governance
repository.

## 12. Handoff Completion Criteria

The milestone is complete only when all of the following are true:

- a released Task explains that its next message or Terminal action starts
  compute; a rejected attempt then explains the capacity scope while
  preserving user input and context;
- once capacity is available, that same Task continues with the same Botified
  session and File Library;
- a raced start returns one typed Sandbox-capacity failure and creates neither
  an orphan message nor an extra Run;
- Project and substrate namespace limits are both enforced atomically for Task
  create, message restart, and Terminal restart, with scope-correct recovery;
- simultaneous Project/namespace saturation returns Project rejection for all
  three entry points;
- every Run with `state != released` is counted as authoritative capacity, no
  unreleased Run can bypass admission, and
  `project_resource_usage.active_tasks` is an absolute same-transaction
  projection rather than an increment/decrement authority;
- admission and release finalization obey namespace -> Project ->
  policy/usage -> Task -> Run -> Library -> writes, skipping absent objects;
  Sandbox-limit updates obey Project -> policy -> usage -> writes, serialize
  with admission on Project, and never take namespace; unrelated policy/File
  writers also take no namespace lock and retain applicable shared object
  order;
- same-key capacity rejection exactly replays its original canonical envelope;
  explicit Retry uses a new key;
- Task create writes before admission only to its operation-owned,
  Project-contained `.preparations/<taskId>` root outside all Library roots and
  Sandbox mounts; descriptor-safe FD walk and the exact operation marker guard
  every prepare/recovery/promote, preparation failure returns its own error,
  and capacity-rejection cleanup failure cannot replace the canonical envelope
  or expose/bind the remnant;
- initial Task-create reservation starts with `startupReadyAt: null`; released
  message/Terminal restart reservation is ready because the canonical
  workspace was already promoted; only descriptor-safe same-volume promotion
  followed by an exact
  `taskId`/`runId`/`fencingToken` Store transaction makes a Task-create Run
  ready;
- `AtomicTaskCreate` admission atomically writes the Task, Library
  creation/binding, reserved Run, initial message, and initial interaction;
  rollback leaves none of them, and dispatcher can never observe a ready
  initial message without its interaction;
- the five-second runtime tick, message dispatcher, direct startup, and every
  Kubernetes/Botified `create_resource`/`adopt_resource` startup path
  transactionally require readiness; `not_ready` is in-progress, creates no
  startup resource/claim/failure, and leaves pending interactions undispatched;
- cleanup/release reconciliation does not require readiness and can clean
  residual resources, confirm absence, and finalize release when
  `startupReadyAt: null`;
- same-key Task-create retry resumes only the marker-matched staging,
  promotion, Task, interaction, and Run;
- while the single API process has an unsettled
  `startupOperationsByRunId[runId]`, every additional same-Run call returns
  only `in_progress`; it performs no lease takeover or second external action;
- one persisted startup claim/fence spans Kubernetes apply/create/adopt and
  Botified readiness; Kubernetes resources reaching started never confirm the
  Run or drop the claim, and only final atomic `active` or
  `failed`/`release_requested` terminates it;
- before every Kubernetes `create_resource`/`adopt_resource` action and the
  separate bounded Botified readiness action, Store CAS persists a fresh
  `startupActionDeadlineAt` for the exact claim/fence, and each adapter's hard
  server/request deadline is no later than its own timestamp; normal completion
  clears that action deadline, preserving the claim between phases, while
  timeout/unknown completion retains deadline and claim through drain/cleanup;
- recovery or release waits while an action deadline is unexpired. After it
  expires, cleanup removes all app-owned resources and re-lists empty before
  draining the deadline, finalizing release, or allowing crash-only database
  lease recovery for the same Run with no local Promise;
- the AgentSmith API runs exactly one replica with
  `strategy.type: Recreate`; manifests/configuration cannot overlap old and new
  control-plane processes, and no generation, rotating credential, webhook,
  leader-election, or multi-controller mechanism is introduced;
- Terminal commits one reservation before fenced Kubernetes/Botified startup
  outside the transaction, same-key concurrency stays on that Run, only active
  confirmation succeeds, startup failure enters
  `failed`/`release_requested`, remains capacity-holding until resource absence
  is confirmed, replays the canonical failed/pending-cleanup presentation
  without pretending released, and the WebSocket is pure transport;
- Terminal idempotency begin/hash/replay and bound-Run state convergence are
  one Store transaction: only `starting` returns HTTP 202 with a persisted
  `runId`; `active` fixes HTTP 200; `failed`/`release_requested` fix canonical
  failure; and `released` replays its stored receipt or fixes explicit failure
  without restarting that operation. Only a new operation may reserve ready
  from a released Task; a current starting/null-ready Run remains preparing
  and is never made ready by Terminal; crash recovery can take the same Run
  only after deadline drain and local-Promise absence; and failure completion
  requires matching operation/request hash, claim/fence, Project, Task,
  Run/current Run, and resource identity;
- after released-message admission succeeds, its message is accepted; later
  startup/dispatch failure is persisted Run/interaction state;
  `AtomicTaskMessage` wrote the ready Run, message, initial interaction, and
  fixed accepted HTTP/idempotency receipt in one transaction, so no later
  error changes replay and `sandbox_start_failed` is never used for that
  message request;
- every readable Task can select Terminal; `openTerminal` authorizes only
  start/connect, and `sandboxState` alone selects
  Start/progress/Connect/Pending-cleanup/Unavailable without extra capability
  fields;
- Slice 1 has one error shape,
  `{error:{code,message,retryable:true,details,presentation}}`: Project details
  are non-null, substrate details are null, create presentation is null, and
  released-message/Terminal capacity presentation is the original released
  Task; `sandbox_start_failed` is Terminal-only and carries canonical
  failed/pending-cleanup presentation;
- rejected create leaves no admitted business state; idempotency and one
  deduplicated rejected Audit are allowed; directory preparation failure before
  admission returns its own error, while compensation failure after capacity
  rejection neither obscures the canonical capacity envelope nor exposes/binds
  a remnant;
- Task creation, Task detail, Usage, Policy, Alerts, and Audit use coherent
  Sandbox-capacity semantics;
- public contracts expose only `sandboxLimit`, `activeSandboxes`,
  `sandbox_capacity`, and `active_sandboxes`; retained old SQL/Alert values are
  private adapter inputs with no public aliases; focused Slice 1 migration
  `074` adds nullable `startup_ready_at` and `startup_action_deadline_at`,
  backfills old active Runs ready solely from database lifecycle fact, leaves
  old starting Runs null, rewrites only exact generated Alert/notification
  copy, and remains separate from the Slice 3 lifecycle migration; the
  application startup reconciler and its service tests own marker validation,
  exact-operation recovery, and missing/invalid-marker failure/cleanup;
- substrate rejection Audit has no count/limit and triggers no Project
  capacity Alert;
- Audit no longer records an existing-Task restart rejection as Task creation;
- Task messages have no 32 KiB server or Web submission limit. Only
  `sessionStorage` snapshots stop at 32,768 UTF-8 bytes by `TextEncoder`;
  over-limit drafts stay editable/submittable, discard the old snapshot, and
  show a non-blocking hint until persistence resumes within the ceiling;
- leaving and returning to a Task as the same user in the same browser session
  restores its valid draft; history and Task -> Files -> Task through validated
  canonical same-origin relative `returnTo` may restore the URL peer view,
  every other Task entry defaults Conversation, and another user never
  receives the draft;
- file and folder entries share one selection model and separate Open action;
- recursive folder deletion is safe, accounted, audited once, and repairs the
  browser state;
- a missing current folder recovers to the selected Library root, and Files
  cannot expose or mutate `workspace/.artifacts`;
- an unbound non-empty File Library deletes through the same action as an empty
  Library;
- a bound Library cannot be deleted and visibly identifies its owning Task;
- successful Task purge preserves ordinary Library files and makes that
  Library Available before any separate Library deletion;
- Library deletion cannot race into a dangling or silently detached Task;
- an interrupted Library delete remains safely retryable and cannot be rebound;
- a deleting Library remains discoverable and retryable after refresh or
  reauthentication;
- a Sandbox path swap cannot redirect recursive deletion beyond the selected
  Library;
- Project file-byte usage records a complete point-in-time measurement of
  remaining active Library roots after every destructive path;
- the Topbar, Page Header, and work surface no longer form repeated static
  shadow/divider layers;
- every retained dialog uses one Astryx anatomy and remains usable with
  keyboard, narrow width, low height, and long or invalid content;
- every retained dialog caller has migrated before
  `src/components/ui/Dialog.tsx` is deleted; no caller retains the nested page
  `Layout`, a second footer/header system, or a compatibility wrapper;
- Released status appears once with neutral stopped-compute semantics rather
  than repeated success treatment;
- light and dark themes distinguish surface, selection, focus, active work,
  success, warning, failure, and disabled state without a parallel visual
  system;
- the serial local K8s product path in Slice 5 works with the real
  OpenAI-compatible endpoint;
- no automatic reclamation, force-mode fork, public compatibility alias,
  removed feature, report, evidence artifact, or default release gate has been
  added.
