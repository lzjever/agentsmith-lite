# AgentSmith Lite UX/UI Principles

## Purpose and Authority

This document defines the target product experience for AgentSmith Lite. It is
not a description of the current codebase. When implementation and principle
disagree, the product should move toward the principle unless user evidence
shows that the principle itself is wrong.

Use this document to make product and design decisions. Do not turn it into a
release gate, evidence process, compliance report, or component encyclopedia.
Review the real experience, fix problems in place, and keep process lighter
than the product work it supports.

## Product Promise

AgentSmith Lite is a cloud-agent workbench for sustained, tool-using work. It
should feel calm, capable, precise, and quietly distinctive. Users should
understand where they are, what the agent is doing, what resources exist, and
what action is available before they notice the styling.

The product is operational rather than promotional. It should not use hero
layouts, decorative dashboards, onboarding theater, or explanatory copy to
fill space. Confidence comes from clear state, continuity, fast feedback, and
predictable recovery.

## Product Model

The interface must make the product's object model visible and stable:

- A **workspace** contains members, shared context, and projects.
- A **project** contains endpoints, credentials, conversations, tasks, file
  libraries, resource policy, usage, alerts, and audit activity. Conversations,
  tasks, and file libraries are independent first-class project objects.
- A project **conversation** is a lightweight model conversation. Its endpoint
  is fixed once the conversation starts.
- A **task** is sustained agent work. Each task owns one unique Botified
  session, binds exactly one endpoint and agent configuration, and binds
  exactly one file library. These bindings are fixed for the task lifetime.
- A **file library** is a durable, project-owned collection of files. A task may
  bind an existing library in its project or create a new one when the task is
  created. Library access follows project access; tasks never bind a library
  from another project.
- A task may have at most one active **sandbox**. The sandbox is execution
  capacity, not the task, session, conversation history, or file library.
- A **terminal** is shell access to the task sandbox. It is not a second agent
  or an alternative business-logic path.

The scope hierarchy is Workspace -> Project. Conversations, tasks, and file
libraries are project-level work objects. A task is a compound workbench that
contains its timeline, bound library context, terminal, session, and sandbox
state. Terminal is never a project-level destination detached from a task.
Context-changing choices must remain visible. Navigation must never silently
create, duplicate, switch, or release a conversation, session, library, or
sandbox.

## Experience Principles

1. **Work first.** Put the active task, conversation, file, terminal, or
   setting at the visual center. Supporting UI should make the work easier to
   understand, not compete with it.
2. **Continuity over ceremony.** Preserve the user's object, input, history,
   selection, and scroll position across navigation, refresh, reconnect, and
   recoverable failure.
3. **One hierarchy.** Global context, local navigation, object state, content,
   and metadata must remain visually and semantically distinct.
4. **Dense, not cramped.** Optimize repeated operational work for scanning and
   comparison while giving primary work surfaces enough breathing room.
5. **State is part of the interface.** Loading, running, waiting, reconnecting,
   read-only, failed, stopped, completed, and released states must be explicit.
6. **One action language.** Similar actions look and behave alike everywhere.
   Each clear scope has at most one visually dominant action.
7. **Progressive disclosure.** Show the information needed for the current
   decision. Keep details available without making every detail permanently
   visible.
8. **Responsive by composition.** Recompose the task for the available space;
   never solve mobile layout by shrinking desktop UI.
9. **Accessible by default.** Keyboard, touch, screen-reader, zoom, contrast,
   and reduced-motion behavior are properties of the primary experience.
10. **No decorative complexity.** A new surface, control, animation, or visual
    asset must improve orientation, comprehension, or action.

## Information Architecture

Use a small set of page archetypes. Do not invent a new page composition for
each module.

### Directory

Directories organize workspaces, projects, tasks, conversations, and file
libraries. They provide a stable title, search or filters when useful, a
comparable list, and one creation action when permitted. The primary object
name is a real link; row actions do not compete with the link.

### Workbench

Workbenches host Conversation, Task, Files, and Terminal experiences. They
preserve the current object, dedicate most space to the work, and move auxiliary
rails or details into sheets on narrow screens. A workbench does not repeat the
global navigation inside its content.

### Detail and Configuration

Detail pages show one object's identity, status, properties, and available
actions. Configuration pages use a readable form width, stable sections, and
an action area that remains discoverable without excessive scrolling.

### Administration

Usage, alerts, audit, members, policy, and settings prioritize comparison and
operational clarity. They present scope, filters, units, time range, current
state, and recovery actions explicitly. They should feel like working tools,
not analytics marketing pages.

Every page has one semantic `h1`. Standard pages use one shared page-header
pattern; immersive workbenches use one shared workbench-header pattern. Panel
titles and card titles never imitate page titles.

## Agent Interaction Contract

### One Continuous Task Session

- A user message always continues the current task's Botified session.
- Do not expose internal concepts such as "new execution" as user workflow.
- Starting another task is the explicit way to create independent agent
  context.
- A task has at most one active agent turn. A message submitted while a turn is
  running enters a visible FIFO queue; it does not interrupt or inject into the
  active turn. Queued messages may be edited or removed until the server begins
  accepting them.
- A message accepted by Botified is immutable. Correct it with a new follow-up
  message. Only a failed message that Botified did not accept may be retried in
  place.
- Drafts and queued messages remain attached to their task. They must not leak
  into another task or conversation. After a turn completes or stops, the next
  queued message is submitted in order.
- Project conversation editing and branching, when offered, are explicit
  conversation operations and do not change Task history semantics.
- A task's endpoint, model, agent configuration, and file-library binding do
  not change within its session. If a required configuration becomes
  unavailable, history remains readable but continuation is blocked; changing
  configuration requires a new task.

### One Coherent Timeline

The task timeline is the source of truth for what happened. It presents user
messages, assistant responses, tool calls, background work, questions, files,
notices, failures, and final results in chronological order.

- Assistant text is optimized for reading; commands and machine output are
  optimized for inspection.
- Tool and background-work summaries show name, state, and useful outcome.
  Detailed command output is disclosed on demand.
- Running items update in place instead of creating a trail of duplicate
  status messages.
- Failures remain next to the operation that failed and expose a relevant next
  action when one exists.
- Streaming content must not cause layout jumps, steal focus, or force-scroll a
  user who has intentionally moved away from the end.

### Run, Stop, Reconnect, and Release

- **Stop** ends the current agent turn or controllable operation. It does not
  destroy the task, session, files, or sandbox.
- Connection state and agent run state are separate. "Disconnected" does not
  imply "stopped," and "idle" does not imply "released."
- Reconnecting preserves confirmed history and clearly identifies any gap or
  uncertain operation.
- A task may exist without an active sandbox. Creating or viewing a task does
  not allocate one. The first explicit action that requires execution, such as
  submitting executable agent work or opening Terminal, provisions a sandbox
  and shows its startup state.
- The system does not automatically release a sandbox because it appears idle.
- **Release sandbox** is an explicit user action. Confirm once that running
  processes and unsaved work may be lost; after confirmation, release the
  sandbox unconditionally without trying to infer whether work is running.
- Released sandboxes leave the task, session history, and file library intact.
- The next explicit execution action after release provisions a new sandbox,
  continues the same Botified session, and mounts the same bound file library.
  Rebuilding a sandbox never creates a new task, session, or history.

### Questions, Approval, and Human Attention

- Agent requests for input, clarification, credentials, or approval are Task
  timeline items and move the task to `Waiting for input`. They are not detached
  modal interruptions.
- When an external side effect requires approval, show the exact action,
  target, scope, duration where relevant, and consequence. Approve and reject
  act only on that request.
- Rejection, timeout, or insufficient permission remains in the timeline and
  lets the agent continue, revise its approach, or fail clearly.
- Leaving a task page does not stop work. Notifications compete for attention
  only for completion, failure, or required human input; progress chatter is
  aggregated rather than emitted as a notification stream.
- A notification links to the exact project, task, and timeline position. Page
  state, global notification, and any external notification use the same
  server-owned event as their source of truth.

### Files and Terminal

- Task creation lets the user choose an accessible file library or create one.
- Files always show which library is selected and let the user switch among the
  libraries they can access in the current project.
- A task always shows its bound library; changing that binding is never an
  implicit side effect of browsing Files.
- Upload shows per-file progress, supports cancellation, and reports partial
  success without discarding completed files. Name conflicts require one clear
  choice to replace, rename, or cancel; the interface never silently overwrites
  a file.
- When multi-file or drag-and-drop workflows are offered, they have equivalent
  keyboard and file-picker paths. Any destructive bulk action that exists
  states the affected count and preserves per-file failure details.
- File previews show the real content when safe and useful. Long, binary, or
  unsupported files provide metadata and an explicit download action.
- Terminal opens shell access to the current task sandbox. Its connection,
  reconnect, and closed states are explicit. Terminal failure never rewrites
  task or agent state.

## State, Feedback, and Recovery

Async UI must answer four questions: what is happening, what remains usable,
what changed, and what the user can do if it fails.

### Scope Feedback Correctly

- Field validation belongs next to the field.
- Form errors belong before the affected form and focus the first invalid
  field after submission.
- Operation status belongs next to its trigger or affected object.
- Object lifecycle and health belong near the object identity.
- Cross-page account or infrastructure problems alone justify global notices.
- Toasts acknowledge short-lived success after an explicit user action. They
  do not carry persistent errors, required actions, permission changes, data
  loss risk, or ordinary loading completion.

### Preserve Known-Good State

- Refreshing existing content keeps it visible. A refresh failure adds an
  inline notice instead of replacing useful content with an error page.
- Loading a new object uses a layout-preserving skeleton or a specific loading
  state, not an unlabelled spinner in empty space.
- Long operations show their real stage and available control. Avoid generic
  "Working..." labels when the actual action is known.
- Retry repeats only the failed operation and preserves input. Do not ask users
  to re-enter information the system still has.
- Reauthentication returns to the original object and recoverable draft.

### Preserve Truth Across Concurrency

- Never silently overwrite a newer server change made by another member, tab,
  or device. Preserve the user's input, show the current server state, and let
  the user decide how to proceed.
- Confirm that the object is still in the state the user saw before applying a
  destructive action.
- Optimistic UI may show an operation as pending, but never as confirmed fact.
  Timelines distinguish pending, confirmed, rejected, and result-unknown work.
- Reconciliation updates an item in place and does not duplicate it or reorder
  unrelated confirmed history.

### Distinguish Failure Types

Offline, authentication expired, permission denied, not found, conflict,
provider failure, sandbox released, and service unavailable are different
states. Each message should state what happened in product language and offer
the closest useful next step. Never expose stack traces, pod details, internal
service names, or opaque transport terminology to ordinary users.

### Permissions and Read-Only State

Keep information visible when a user may view but not modify it, and explain
the restriction near the unavailable action. Hide an object only when the user
may not know it exists. Do not use a disabled control as the sole explanation
of policy, validation, or permission.

### Protect Sensitive Data Everywhere

Credentials and recognized secrets must not appear in timelines,
notifications, audit details, ordinary errors, environment summaries, file
previews, or copy affordances. Sensitive values are masked by default; any
permitted reveal is a deliberate, temporary user action. Redaction preserves a
safe field name and source so the surrounding event remains understandable.
Copy, preview, and download always honor the source object's access policy.

## Actions and Component Decisions

Use one component and one interaction pattern for each job.

- **Primary button:** the single action most likely to advance work in the
  current page, form, dialog, or empty state.
- **Default button:** an ordinary explicit command.
- **Quiet icon button:** a compact toolbar or row action. It requires an
  accessible name; unfamiliar icons also require a tooltip.
- **Danger action:** begins a destructive flow. The final confirmation uses a
  solid destructive treatment and names the object in the button label.
- **Link:** navigation. Do not style navigation as a button unless it must read
  as the dominant call to action.
- **Menu:** a set of secondary commands or mutually exclusive options.
- **Tabs:** peer views of the same object.
- **Segmented control:** a small set of mutually exclusive display modes.
- **Checkbox or switch:** a binary setting. Use a switch only when the change
  applies immediately.
- **Select:** a bounded option set. Use search or combobox behavior when users
  cannot reasonably scan the set.
- **Dialog:** a short interrupting decision or edit. Use a sheet for subordinate
  context that should preserve the workbench behind it.
- **Status badge:** compact lifecycle or health state, always with text. It is
  not interactive and never means "selected."

Cards are reserved for repeated objects, dialogs, and genuinely bounded tools.
Do not place cards inside cards or turn page sections into floating cards.
Prefer alignment, spacing, separators, and surface contrast over containers.

Destructive confirmation states the object, scope, retained data,
irreversibility, and likely consequence. Default focus stays on the safe action.
Do not add confirmation to reversible or lossless commands.

## Forms and Settings

- Every field has a persistent visible label. Placeholder text is an example,
  never the label.
- Help text explains constraints or consequences, not obvious mechanics.
- Labels, help, required state, and errors are programmatically associated with
  their fields.
- Preserve input after validation, network failure, reauthentication, and
  recoverable conflict.
- Submission keeps the button in place, names the active operation, and blocks
  accidental duplicate submission.
- Ask about unsaved changes only when leaving would actually lose user input.
- Sensitive credentials state how they are stored and replaced, but secrets
  are never revealed again after submission.
- Numeric resource settings show units beside the value and distinguish zero,
  unlimited, inherited, and unavailable.

## Dense Data and Operational Views

- Repeated rows use stable columns, a clear primary identity, visible status,
  and predictable action placement.
- Default row height is 44-52px depending on content. Multi-line operational
  rows may grow, but metadata must remain aligned and scannable.
- Numbers used for comparison align consistently and use tabular numerals.
  Machine identifiers, commands, paths, timestamps, and logs use mono; ordinary
  labels and status text do not.
- Search, filters, sorting, pagination, and bulk actions appear only when the
  real workflow needs them.
- The interface always makes active filters, sort order, result count, and
  pagination position understandable. Filtered-empty states offer a direct way
  to clear filters.
- Critical identifiers, errors, and status are never available only through
  truncation. Provide expansion, copy, or a full detail view.
- Refreshes preserve filters, selection, focus, and scroll whenever the object
  still exists.
- Sandbox usage begins when execution capacity becomes available and ends when
  release or termination is confirmed. Usage can be scoped by user, project,
  and task and includes cumulative sandbox runtime plus applicable requested
  CPU, memory, storage, provider, and cost measures.
- Audit records the actor, task, time, and result for sandbox creation, start,
  stop, rebuild, release, and failure, alongside other meaningful product
  events. Usage is a metering view; Audit is an event view. Neither becomes a
  generated governance report.
- Usage displays units and scope without requiring users to understand billing
  or infrastructure internals. Audit presents actor, resource user, action,
  result, resource, and time as comparable fields.

## Responsive Composition

The complete product must work from 320px wide through large desktop screens,
at low viewport heights, at 200% zoom, with a soft keyboard, and with safe-area
insets. Font size does not scale with viewport width.

- Below 768px, global navigation moves into a left sheet.
- Main content remains primary. Auxiliary navigation, thread rails, library
  rails, details, and filters collapse into clearly labelled sheets or
  disclosure controls.
- In master-detail views, keep the master list in the page and move the detail
  pane into a sheet when simultaneous comparison is not essential.
- Tables first hide truly secondary columns, then become labelled object rows.
  Use horizontal scrolling only when preserving column comparison is essential.
- Toolbars wrap by priority. The current object's primary action remains easy
  to reach; secondary actions move into a menu.
- Essential actions never depend on hover. Hover may reveal convenience, not
  capability.
- Do not reduce type below the established scale to make content fit. Reflow,
  wrap, disclose, or scroll the correct region.
- Frequent and destructive touch actions have at least a 44x44px target.
- Dialogs, sheets, composers, and terminal controls remain usable above the
  soft keyboard and within safe areas.

## Visual System

### Color

- Light mode uses neutral white and gray surfaces; dark mode uses neutral
  charcoal surfaces. Neither mode is a tinted inversion of the other.
- Agent orange identifies the brand, current product context, and primary
  action. It is not a generic information color.
- Blue is informational, green is successful or healthy, amber is cautionary,
  and red is failed or destructive.
- Every semantic color has coordinated text, icon, border, and subtle-background
  tokens for both themes. Do not use raw colors in product components.
- Selection, focus, running, success, warning, failure, read-only, and disabled
  are distinct concepts. Color never carries any of them alone.
- Running and reconnecting use informational semantics, never success.
  `Waiting for input` uses attention semantics; passive waiting is neutral.
  Completed and healthy use success. Degraded uses warning. Failed uses error.
  Stopped, released, archived, and read-only use neutral. Selection uses a
  selection surface, never a status color.
- Avoid beige, brown, blue-slate dominance, single-hue palettes, gradients,
  decorative glows, orbs, and bokeh.

### Typography

- Cursor Gothic is the product UI face. Berkeley Mono is reserved for machine
  values and technical content. Do not use serif typography in the operational
  product.
- Use a small fixed hierarchy: page title 28/32, section title 22/28, panel
  title 18/24, body 15/23, compact metadata 13/18, and mono 13/20.
- Use regular weight for most text, medium for emphasis, and semibold only when
  hierarchy cannot be achieved through size and position.
- Letter spacing is `0` for all product UI, including uppercase labels. Do not
  simulate hierarchy with tracked-out text.
- Use sentence case for titles, labels, tabs, buttons, badges, and table
  headers. Reserve uppercase for user content or established external notation.
- Text wraps without covering adjacent content. Long words and identifiers may
  break only in regions designed for machine values.

### Layout, Geometry, and Surfaces

- Top bar: 52px. Desktop navigation: 240px expanded and 72px collapsed.
- Standard page gutters: 20px mobile and 32px desktop. General content is
  constrained to about 1480px; focused forms and settings use a narrower
  reading width. Workbenches may use the full available area.
- Use a consistent 4/8/12/16/20/24/32px spacing rhythm. Stable controls and
  workbench regions have explicit dimensions or responsive constraints.
- Normal controls and containers use 4-8px corners. Pills are limited to
  statuses, segmented controls, and avatars.
- Page content and ordinary controls are flat. Shadows belong to floating
  layers such as menus, popovers, dialogs, sheets, and toasts.
- Borders separate adjacent operational regions; they should not frame every
  section. No nested cards or decorative section containers.

### Motion and Imagery

- Motion explains entry, exit, reordering, expansion, or state change. Most
  transitions complete in 100-180ms and never delay the operation.
- Reduced-motion mode removes translation, scaling, rotation, flashing, and
  smooth scrolling. State remains legible without animation.
- Never fake progress with decorative animation.
- Do not use decorative illustration to fill empty space. Real file previews,
  generated artifacts, terminal output, charts, screenshots, and agent results
  are product content and should be presented clearly.

## Accessibility and Semantics

Target WCAG 2.2 AA as the baseline, then optimize for the actual work rather
than treating conformance as a checklist.

- Every operation is available by keyboard without timing traps. Focus order
  follows the visual task order.
- Provide a skip-to-content path. Each page has one `main`, one `h1`, named
  navigation regions, and named workbench regions where ambiguity is possible.
- Use native links, buttons, fields, tables, lists, and headings. Do not make a
  generic container behave like a control.
- Opening a dialog or sheet moves focus inside; closing it returns focus to the
  trigger or the nearest surviving logical control. Deleting or refreshing an
  object moves focus predictably.
- Focus indicators remain visible on every surface and meet 3:1 contrast.
- Body and small text meet 4.5:1 contrast; large text, essential boundaries,
  controls, focus, and meaningful graphics meet 3:1.
- Icon-only controls have accurate accessible names. Decorative icons are
  hidden from assistive technology.
- Status is expressed with text and semantics as well as color and icon.
- Live regions announce completed messages or meaningful state transitions,
  never every streamed token, log line, timer tick, or rapidly changing event.
- Live logs can be paused without stopping the underlying work so reading
  position remains stable.
- User and assistant Markdown preserves a coherent heading hierarchy and is
  sanitized without flattening useful structure.
- Terminal, code, and logs provide a named region, keyboard-safe entry and exit,
  copy access, and controlled horizontal scrolling where wrapping would corrupt
  meaning.
- Canvas-based terminals provide an accessible history and copy path outside
  the canvas. Usage charts provide the same facts as a data table or concise
  text summary. Charts, terminals, and streams must not become information
  dead ends for non-visual users.

## Content and Terminology

Use concise, direct English. The interface is English-only unless localization
becomes a real product requirement.

- Use the product terms **workspace**, **project**, **conversation**, **task**,
  **file library**, **sandbox**, **terminal**, **endpoint**, and **credential**
  consistently.
- Do not expose `pod`, `sidecar`, `execution`, transport protocol, internal
  service, or framework terminology in ordinary user flows.
- Commands use "verb + object": `Create task`, `Release sandbox`, `Delete
  library`, `Save policy`.
- Status labels describe current truth: `Running`, `Waiting for input`,
  `Reconnecting`, `Sandbox released`. Avoid vague labels such as `Processing`.
- Error copy states what happened and the next useful action. Do not blame the
  user or promise recovery the system cannot provide.
- Confirmation copy names the affected object and consequence. Success copy is
  brief and does not narrate routine navigation.
- Dates use the user's timezone and locale. Relative time may aid scanning, but
  the exact timestamp remains available.
- IDs are secondary, mono, selectable, and easy to copy. Never make an opaque ID
  the primary name when a human-readable label exists.
- Supporting copy explains state, scope, or consequence. It does not advertise
  features or teach obvious control mechanics inside the work surface.

## Design Review Questions

These questions guide design and in-place correction. They are not a release
gate and require no report or evidence artifact.

- Can the user identify the workspace, project, current object, and state at a
  glance?
- Is the next action clear without competing primary actions?
- Does the workflow preserve session, draft, selection, files, and scroll when
  it should?
- Are agent run state, connection state, and sandbox state distinct?
- Does every async state explain what is happening and how to recover?
- Is known-good content retained during refresh and transient failure?
- Are permission, read-only, and destructive consequences understandable near
  the affected action?
- Can repeated rows be scanned and compared without opening each one?
- Does the same task remain complete and coherent at 320px, 390px, desktop,
  low height, 200% zoom, and in both themes?
- Can every operation be completed with keyboard and touch, with predictable
  focus and meaningful semantics?
- Do content, controls, and status remain legible without color, hover, or
  motion?
- Does every visible element improve orientation, comprehension, or action?
