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
- any claim that the first Astryx migration completed the shell, dialog, or
  visual-composition work.

The following decisions remain unchanged:

- one durable Task has one Botified session, one exclusively bound File
  Library, many turns, and sequential Sandbox Runs;
- release is explicit and unconditional, with no idle TTL, process inspection,
  or automatic reclamation;
- the Web is an AgentSmith API client, and all authorization, resource,
  deletion, accounting, and Botified behavior is server-owned;
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
- Leaving a Task for Files or another product page and returning as the same
  user in the same browser session restores its unsent draft and selected peer
  view.
- Task, Files, Usage, Alerts, Audit, directories, and settings feel like parts
  of one long-lived Astryx work environment without obscuring operational
  content.

### 3.2 Engineering outcomes

- One atomic server admission path is the only capacity truth for every
  Sandbox start. The Web does not infer or cache whether a future start will
  succeed.
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
- Message and Terminal cold-start capacity presentation and typed race errors.
- Consistent Sandbox capacity terminology in Task creation, Task detail,
  Usage, Resource Policy, Alerts, and relevant Audit details.
- Correct Audit action attribution for capacity rejection.
- A shared atomic Project/namespace Sandbox admission path for initial Task,
  released-message, and released-Terminal cold-start.
- User-and-Task-scoped draft plus URL peer-view continuity without a global
  client state framework.
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
- Cloud validation, multi-replica control-plane design, automated visual
  approval, permanent Playwright suites, default end-to-end gates, reports, or
  evidence generation.
- Persisting Task drafts to the server, persisting follow/read mode or scroll
  anchors across routes, sharing drafts across users/devices, or introducing a
  global frontend store.

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

### 5.2 Capacity language describes the wrong durable object

`activeTasks`, `activeTasksLimit`, `Task capacity`, and
`active_tasks_limit_reached` are used for a counter now held by starting or
active Sandbox Runs. A released Task does not consume the resource. This
language confuses Task lifecycle with compute allocation and leaks into Usage,
Resource Policy, Alerts, and Audit.

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
  | { kind: "admitted" }
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
  start use the same Store admission primitive;
- Project and substrate admission happen in the same transaction and fixed
  lock order;
- capacity-holding means every Run not yet confirmed `released`, including
  startup, active work, release cleanup, and failed cleanup;
- Project rejection may expose current Project count and limit;
- substrate rejection never exposes another Project's allocation or
  infrastructure internals;
- authorization, Task lifecycle, Endpoint eligibility, and cleanup state are
  checked before capacity and keep their own typed errors.

The Web never joins policy and usage data to infer admission. Usage remains the
place to inspect live allocation after a rejection.

Task creation does not preflight capacity. Its atomic rejection preserves the
dialog's title, prompt, Endpoint, Library mode, selected Library, and new
Library name. It shows the same scope-correct recovery as released Task start.
A rejected create writes no Task, File Library, message, Run, or accepted Audit
event.

### 6.2 Released Task message behavior

- released state says once that Send starts a Sandbox for this same Task,
  Botified session, and File Library;
- the draft remains editable and Send remains available while Task capability
  permits it;
- admitted Send atomically creates one Run and one message, then shows startup
  progress in the same workbench;
- rejected Send creates no Run, message, queued interaction, or accepted
  message Audit event and leaves the Task released;
- the safe error envelope returns `retryable: true`, the same canonical Task
  presentation, and either `project_sandbox_capacity_reached` with Project
  count/limit or `substrate_sandbox_capacity_reached`;
- the Web keeps draft, focus, timeline, and peer view, and titles the inline
  error `Sandbox could not be started`;
- Project rejection links to live Sandboxes and, for administrators, Resource
  Policy;
- substrate rejection links to live Sandboxes and says to release one the user
  controls or try again later, without a misleading Project Policy link;
- after capacity changes, the user retries through the same Send action;
- there is no automatic retry, compute queue, future slot, or auto-release.

### 6.3 Released Task Terminal behavior

- Selecting Terminal on an active Sandbox opens the existing peer workbench
  without reserving another slot.
- Restoring `?view=terminal`, refreshing, or browser history navigation never
  starts compute. A released Task first shows a static Terminal start surface.
- Only the explicit `Start sandbox and open Terminal` command calls the
  idempotent JSON `POST /tasks/:taskId/terminal/start` endpoint.
- On a released Task, that command uses the same atomic admission primitive,
  creates at most one Run, and returns the canonical Task presentation.
- On a capacity rejection, the Web does not mount or reconnect the WebSocket.
  It keeps the selectable Terminal peer view and static start surface, then
  displays the same scope-correct recovery used by message Send. Retry is
  another explicit start command and never starts automatically.
- Only after the start command succeeds does the existing authenticated
  AgentSmith Terminal WebSocket become a pure transport connection.
- A later transport disconnect may use bounded reconnect; typed admission
  failures never enter the generic `Workspace is starting` reconnect loop.
- Terminal does not create a new Task or Botified session and does not queue a
  shell while waiting for capacity.

### 6.4 Task workbench continuity

Keep small recoverable state scoped by Task ID:

- unsent composer draft: `sessionStorage`, partitioned by stable current-user
  ID and Task ID;
- selected Conversation/Terminal/Artifacts peer view: URL state so
  back/forward and direct return are predictable.

Rules:

- clear the draft only after the server accepts that exact message or the Task
  is deleted;
- clear or ignore stored state on logout, identity change, denied Task access,
  or Task deletion;
- archived/read-only Tasks may show a retained draft but cannot submit it;
- no browser state is treated as conversation truth or shared across users,
  devices, or Tasks;
- do not persist follow/read mode, scroll anchors, streamed previews,
  interaction bodies, credentials, Terminal data, or server capability
  decisions.

The storage key includes schema version, current user ID, Project ID, and Task
ID. Draft length is bounded by the message contract. If browser storage is
unavailable or full, the current mounted composer still works; persistence
degrades quietly rather than blocking Task work.

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
SQL column names do not need a migration solely for wording; adapters keep that
storage detail out of the public contract. No compatibility alias, dual public
field, or old visible term remains.

Audit behavior:

- a rejected initial Task creation remains `task.create / rejected`;
- a rejected released-Task message restart is
  `sandbox.started / rejected` with trigger `task_message`;
- a rejected Terminal restart is `sandbox.started / rejected` with trigger
  `terminal`;
- detail distinguishes `project_policy` from `substrate_namespace`;
- no rejected message event is recorded when the message was never accepted;
- detail contains IDs, trigger, active count, and limit only, never prompt,
  message, credential, or file content.

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
- `workspace/.artifacts`, its descendants, and an ancestor deletion that would
  remove it: reject through the ordinary entry endpoint;
- symlink or path crossing a symlink: reject;
- missing entry: return the existing not-found result;
- unsupported entry type: reject without mutation.

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

A visible ancestor such as `workspace` that currently contains the protected
Artifact subtree does not show an enabled Delete action and displays the
reason in its selected details. The server returns the same typed reason if a
client bypasses the Web.

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
- one `file.delete` Audit event records `entryType`, normalized path, and total
  bytes removed without descendant names or content;
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

- initial Task creation reserves one Run;
- released-Task message creation reserves one Run and creates the message in
  the same transaction;
- released-Task Terminal start reserves one Run before WebSocket transport.

Move namespace admission out of the current Task-create-only preflight. Pass
the configured namespace limit into each atomic create/restart operation. The
PostgreSQL adapter uses one internal admission implementation and one fixed
lock order for every trigger:

```text
namespace advisory lock
  -> Project / policy / usage rows
  -> existing Task row, when present
  -> selected File Library row, when initial Task creation needs one
  -> Run, message, Task, usage, and idempotency writes
```

- count every Run whose release has not been confirmed, not only `active`
  Runs;
- apply namespace and Project policy limits before any Task, message, Run,
  usage, or accepted Audit write;
- the in-memory store implements the same result contract;
- results distinguish `project_capacity_rejected` and
  `substrate_capacity_rejected`;
- only a successful transaction increments Project usage and creates a Run;
- remove the old non-atomic namespace preflight.

A message cold-start rejection returns a safe error envelope with the typed
code, `retryable: true`, and the canonical presentation for the same released
Task. It contains no queued message.

Add an idempotent JSON Terminal-start command that performs the same atomic
admission and returns either canonical Task presentation or the same typed
error envelope. The Web opens the existing Terminal WebSocket only after this
command succeeds. The WebSocket no longer owns Sandbox admission and remains a
pure authenticated transport. Do not introduce a Terminal ticket unless the
existing OIDC session and single-terminal ownership check prove insufficient.

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
only filesystem source identity and phase for that operation. It does not
write Project usage, Audit, domain rows, HTTP responses, or request completion.

The engine then:

1. validate the target policy and its operation identity;
2. open the canonical Library root as a directory without following symlinks;
3. for an entry, normalize the relative path and walk each parent relative to
   an opened directory descriptor; for a Library, anchor its canonical parent
   and the claimed root entry;
4. reject every symlink component and unsupported final entry type, then
   enforce the selected root/Artifact policy;
5. persist the source identity and deletion phase, then atomically rename the
   final entry through descriptor-anchored paths to
   `<projectRoot>/.deletions/<operationId>/entry`;
6. persist the isolated phase and return the isolated entry identity and
   aggregate regular-file bytes to the owning service;
7. after the owning service persists its point-in-time Project accounting,
   remove the quarantine entry and marker;
8. persist the physical-removal phase and return control to the owning
   service.

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
contract. If that capability is unavailable, deletion fails closed; do not
fall back to validate-then-`rm(path)`.

The durable operation state records enough phase/source identity to resume:

- if the quarantine entry exists, continue only that isolated operation;
- if isolation had not completed and the source still has the claimed
  identity, resume the descriptor-anchored rename;
- if the source path now refers to a different entry, never delete the new
  entry as part of the old operation;
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

Add one forward migration with a narrow File Library deletion fence:

```text
active -> deleting
```

Successful removal means the row no longer exists; `removed` is not a stored
state. The migration adds only:

```text
lifecycle_status = active | deleting
deletion_operation_id = nullable stable string
```

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

Task creation must not mutate an existing Library workspace before the atomic
bind succeeds. After the Store admits the Task and binds an `active` Library,
the service ensures required directories through the shared safe Library path
API. Any post-bind preparation failure uses the existing deterministic Task
creation recovery for that same Task identity; it never leaves an unbound
filesystem preparation that can race Library deletion.

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
- URL owns selected Library and current folder.
- Files browser state owns selected entry, local filter/sort, and presentation
  page.
- Task URL owns the current peer view. User-and-Task-scoped `sessionStorage`
  owns the unsent draft.
- Astryx owns primitive focus, overlay, input, button, and semantic styling.
- AgentSmith domain components own Task workbench, Files browser, and modal
  composition only where product semantics require composition.

### 8.2 Error treatment

Map typed API errors at the affected action:

| Code | Product treatment |
| --- | --- |
| `project_sandbox_capacity_reached` | preserve draft/view; show Project count/limit and live Sandboxes |
| `substrate_sandbox_capacity_reached` | preserve draft/view; show local capacity guidance without a policy link |
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
  user-scoped draft and peer view.
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

- canonical scoped Sandbox admission contract and error codes;
- one atomic Project/namespace admission path for all cold starts;
- message and Terminal cold-start presentation;
- typed Terminal startup failure;
- user-and-Task-scoped draft plus URL peer-view continuity;
- one neutral, non-duplicated released-state presentation;
- consistent Task create/detail, Usage, Policy, Alert, and Audit language;
- correct Audit attribution for each reservation trigger;
- deletion of old visible `active task` capacity copy and old error mapping.

Implementation/commit order:

1. Store admission result, fixed lock order, namespace/Project counting, and
   concurrency tests.
2. Message and JSON Terminal-start application/API contracts, canonical error
   envelopes, and removal of WebSocket-owned admission.
3. Released Task message/Terminal UI and scope-correct recovery.
4. User-scoped draft, URL peer view, released-state deduplication, terminology,
   and Audit copy.

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

Focused checks:

- released Task with room starts one new Run and keeps Task/session/Library;
- released Task at Project or substrate capacity accepts no message and creates
  no Run;
- draft remains after capacity rejection;
- active Task messaging does not require another slot;
- released Terminal succeeds once or returns the same scoped capacity
  rejection without mounting its WebSocket;
- one last slot won concurrently has one winner;
- namespace count and Project count remain within their limits across
  concurrent create/message/Terminal starts;
- Audit identifies create, message restart, and Terminal restart correctly;
- releasing a Sandbox returns capacity and refreshes the blocked Task
  presentation on explicit retry/refresh;
- navigating Task -> Files -> Task as the same user restores draft and peer
  view without persisting conversation content in browser storage.

Slice completion:

- no retained UI calls Sandbox allocation `active Task capacity`, and no
  Project-policy link is shown for substrate saturation;
- message and Terminal have one admission and recovery behavior;
- atomic reservation remains authoritative.

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

1. Descriptor-anchored delete operation/idempotency state and reserved-path
   policy.
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
- one forward `active | deleting` Library lifecycle migration;
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

Product path:

1. OIDC login and Project open.
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

- the real path produces the user outcomes in section 3;
- defects found on this exact path are corrected in their owning code;
- no unrelated feature expansion or governance artifact is left behind.

## 10. Focused Testing Discipline

Tests scale with changed business risk:

- store tests for atomic capacity and Library-binding races;
- service tests for Task cold-start, Project/namespace admission, recursive
  deletion, descriptor-anchored symlink/parent replacement resistance,
  reserved paths, accounting, and idempotency;
- migration/store tests for `active | deleting`, bind-versus-delete, and
  interrupted deletion retry;
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

- final API contract and any single forward database migration;
- server-owned Project/substrate Sandbox admission and typed capacity failures;
- coherent message, Terminal, Usage, Policy, Alert, and Audit behavior;
- user-and-Task-scoped draft plus URL peer-view continuity;
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
- Task creation, Task detail, Usage, Policy, Alerts, and Audit use coherent
  Sandbox-capacity semantics;
- Audit no longer records an existing-Task restart rejection as Task creation;
- leaving and returning to a Task as the same user in the same browser session
  restores its valid draft and peer view; another user never receives it;
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
- no automatic reclamation, force-mode fork, compatibility adapter, removed
  feature, report, evidence artifact, or default release gate has been added.
