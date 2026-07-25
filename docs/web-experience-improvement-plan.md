# AgentSmith Lite Web Experience Improvement Plan

Status: handoff-ready

Date: 2026-07-23

Applies to: `agentsmith-lite`

## 1. Authority and Purpose

This is the implementation handoff for the next AgentSmith Lite Web milestone.
It addresses four product concerns as first-class work:

1. data-heavy views must present a useful summary before bounded detail;
2. the whole Web App must move to one Astryx visual system;
3. Task must become a smooth, stable long-running work surface;
4. SVG and image assets must improve comprehension and product character
   without becoming decoration.

This document is authoritative for Web information architecture, visual
implementation, interaction performance, responsive composition, and the
related read APIs needed to keep views bounded.

For the current correction milestone,
`docs/core-workflow-product-improvement-plan.md` supersedes this document only
for shell/page-header composition, direct Astryx dialog use, released-Task
capacity and continuity, Files selection/deletion/recovery, and the resulting
visual completion criteria. The one-theme Astryx architecture and bounded-view
decisions here remain authoritative.

The following documents retain their existing authority:

- `docs/task-workspace-product-improvement-plan.md` owns Task, File Library,
  Botified session, Sandbox Run, usage settlement, and release semantics.
- `docs/ux-ui-design-principles.md` owns stable product-wide design principles.
- `docs/api-contract.md` owns the final public API after implementation.

Where an older plan says to preserve or copy the original AgentSmith visual
tokens, theme, primitive components, or CSS, this document supersedes it. The
reference application remains useful for retained product capability,
information architecture, terminology, and workflow comparison. It is not a
visual implementation dependency.

This is a development plan, not a design-governance process. Implementation
must fix issues in place, use focused checks selected for the current change,
and leave no report, evidence bundle, visual-baseline repository, rehearsal,
or release-gate machinery behind.

## 2. Product Decision

AgentSmith Lite is a long-lived agent work environment, not a generic
administration dashboard. The primary experience is the Task workspace.
Supporting views help users configure work, find files, understand current
resource use, and resolve problems without competing with that workspace.

The final Web App has one mental model:

```text
AgentSmith Astryx Theme
  -> Astryx primitives
  -> AgentSmith domain compositions
  -> one responsive Web experience
```

There is no legacy visual layer beneath or around this model. Existing visual
code must be migrated, rewritten on Astryx, or deleted. Do not retain:

- a legacy CSS theme or token namespace;
- a neutral theme selected separately at runtime;
- compatibility variables or fallback aliases;
- wrapper components that only translate old props to Astryx;
- parallel old/new pages, feature flags, or a deferred cleanup phase;
- page-level raw colors, fonts, radius values, or shadow systems.

When Astryx cannot directly replace a domain surface such as Task timeline,
Markdown, Terminal, file preview, or an artifact viewer, implement that
surface as an AgentSmith domain component that consumes the active Astryx
theme. Do not preserve the old implementation merely because replacement is
not one-to-one.

## 3. Milestone Outcomes

### 3.1 User outcomes

- Usage answers current allocation and cumulative use immediately. Sandbox Run
  history is requested and shown only after the user asks for it.
- Alerts opens on work that needs attention. Historical alerts remain
  available without displacing active items.
- Audit and Files remain understandable and responsive as their datasets grow.
- Task clearly distinguishes following current work from reading earlier
  history. Live output never steals the viewport from a user reading above.
- Long Task histories, streaming output, Markdown, tool activity, and artifact
  publication remain responsive.
- Conversation, Terminal, and Artifacts use the available work area instead of
  forcing the main activity into a small dashboard panel.
- Light and dark themes are independently comfortable for long sessions,
  clearly layered, and semantically consistent.
- Product-authored SVG and real file/artifact media add identity and
  comprehension where they are useful; operational content stays primary.

### 3.2 Engineering outcomes

- One AgentSmith Astryx Theme is the only editable visual source and the only
  runtime Astryx theme.
- Astryx owns reusable interaction and accessibility primitives. Tailwind owns
  composition, not a second design system.
- Task uses one snapshot path, one interaction SSE path, and one local
  presentation state model. A healthy SSE connection does not compete with a
  five-second Task-detail poll.
- Streaming preview updates do not rerender settled history or repeatedly
  parse settled Markdown.
- Usage, Task lists, Task Artifacts, Alerts, and Audit use bounded server reads.
  Files keeps its approved current-folder read and bounds browser rendering
  without introducing indexed file metadata.
- Each migrated area deletes the replaced implementation in the same change.
- No new state framework, data-grid framework, event bus, analytics service,
  image service, frontend BFF, compatibility adapter, or governance system is
  introduced.

## 4. Scope Boundaries

### 4.1 Included

- An AgentSmith Astryx Theme for light, dark, typography, geometry, motion,
  semantic color, syntax, and shared component behavior.
- Direct migration to Astryx primitives across the entire retained Web App.
- Removal of legacy visual tokens, type classes, raw UI colors, duplicate
  primitives, and theme conflicts.
- Task list, detail, timeline, composer, queued messages, Terminal, artifacts,
  live connection presentation, history navigation, and responsive workbench.
- Usage summary and on-demand paginated Sandbox Run detail.
- Active-first Alerts, bounded alert history, and clearer Audit query state.
- Bounded current-folder presentation for File Library directory listings.
- Bounded Task list pagination that remains stable while tasks are inserted.
- Server-side pagination for Task Artifact listings.
- Product-authored brand/empty-state SVG, real file and artifact previews, and
  small data visualizations where exact values remain available.
- Focused API, application, store, reducer, and behavior checks for changed
  logic.
- Temporary manual Playwright and browser profiling during implementation.

### 4.2 Explicit non-goals

- Changing Task, Sandbox, Library, Botified, identity, endpoint, membership,
  policy, usage-settlement, or Audit business semantics.
- Restoring Chat, LLMUP, Codex runner behavior, JVS, WebDAV, mounts, templates,
  savepoints, file versions, or other previously excluded capabilities.
- A generic dashboard builder, BI view, report export, saved-query system,
  cross-project analytics, or alert operations console.
- A generic DataGrid, application-wide query framework, React Query migration,
  global client store, frontend event bus, or virtual-list abstraction.
- Indexed file metadata, a file search service, recursive search, or File
  Library server pagination/sort.
- Runtime image generation, an SVG sanitization/rasterization service, a media
  pipeline, illustration management, or a second icon system.
- Pixel reproduction of the original AgentSmith visual design.
- New localization infrastructure; the Web App remains English-only.
- Automated screenshot approval, permanent performance harnesses, default E2E
  gates, reports, evidence, rehearsals, or test-framework tests.

## 5. Current-State Problems

### 5.1 Data views expose detail before intent

`AuditUsagePage.tsx` renders every Sandbox Run after the summary, while the
application service and PostgreSQL store read unbounded settlement and live Run
history. Page length, response size, memory, and query cost grow together.

Alerts defaults to a mixed history view, so resolved records can displace
active work. Audit is paginated but does not clearly communicate active
filters, page position, or reset. Files reads a whole current directory as its
approved storage boundary, but then renders the entire result instead of
bounding the visible presentation.

The shared correction is not “put everything in a card.” It is:

```text
current decision -> concise summary -> explicit disclosure -> bounded detail
```

### 5.2 The visual system has two sources

`src/app/globals.css` imports the Astryx neutral theme and also defines another
color, typography, radius, spacing, and shadow system. `src/app/providers.tsx`
selects `neutralTheme`, while `tailwind.config.js` maps utilities to the
parallel legacy variables.

Consequences include inconsistent Astryx and hand-built controls, weak surface
hierarchy, excessive use of orange, raw Terminal colors, faint metadata and
boundaries, and page-specific density.

### 5.3 Task work scales poorly with activity

Streaming preview frames update React state immediately. The whole loaded
interaction list is mapped again, settled rows are not memoized, and Markdown
configuration is recreated during render. Interaction upsert rebuilds a Map
and sorts the full loaded history for each incoming event.

Earlier pages remain mounted forever. Preview growth is not part of the same
follow/read behavior as durable interactions. History prepend uses total
scroll-height compensation instead of an element anchor. Conversation remains
active behind Terminal, Terminal may focus while hidden, and a five-second
detail poll overlaps the interaction SSE.

The current fixed-height Task workbench and always-visible desktop artifact
rail also reduce the area available for the product's primary activity.

### 5.4 Visual content has no coherent role

The product has no authored visual-asset family. Most visual expression comes
from Lucide icons and repeated bordered surfaces. Real file and artifact
previews exist, but their behavior and safety differ.

Adding decoration everywhere would make an operational workspace worse. The
needed improvement is a small, coherent set of functional assets plus stronger
presentation of real user and agent output.

## 6. Final Visual Architecture

### 6.1 One AgentSmith Astryx Theme

Create one theme definition, for example:

```text
src/theme/agentsmith-theme.ts
```

It may extend Astryx `neutralTheme` internally to reuse complete Astryx token
coverage. The application, however, imports and selects only
`agentSmithTheme`. `neutralTheme` is never a separately selectable runtime
theme and its CSS is not loaded as a parallel visual authority.

The AgentSmith theme owns:

- Cursor Gothic for interface and headings;
- Berkeley Mono for code, paths, IDs, timestamps, logs, and machine values;
- independent light and dark surface relationships;
- brand orange and coordinated on-brand content;
- focus, selection, informational, active-work, success, warning, error, and
  disabled semantics;
- matching foreground, subtle surface, border, icon, and solid-content values;
- 4-8px ordinary geometry and the approved spacing scale;
- restrained motion and reduced-motion behavior;
- syntax colors used by code and Markdown;
- component visual defaults and variants that are genuinely product-wide.

Use existing Astryx semantic and categorical tokens before adding AgentSmith
extensions. Add a token only when an actual retained interface state cannot be
expressed clearly with the existing contract.

### 6.2 Layer responsibilities

**Astryx owns**

- Theme, shell, navigation, typography, buttons, fields, selectors, dialogs,
  sheets, banners, tabs, badges, tables, pagination, empty/loading states,
  skeletons, toasts, menus, popovers, tooltips, and focus behavior.

**Tailwind owns**

- Grid, flex, responsive composition, dimensions, spacing, positioning,
  overflow, visibility, and stable workbench constraints.
- A small bridge to Astryx CSS variables where a domain component needs a
  utility. The bridge references Astryx variables and never defines visual
  values or legacy aliases.
- The bridge uses direct CSS-variable mappings. It does not use opacity
  modifiers on values that cannot support them, target Astryx internal DOM, or
  rebuild Astryx component variants with utilities.

**AgentSmith domain components own**

- API and request state;
- server-projected capabilities and authorization presentation;
- Task timeline composition and follow/read state;
- Markdown parsing and safe content composition;
- Terminal lifecycle and Xterm configuration;
- File/Artifact preview behavior;
- product-specific confirmation and recovery flows.

Domain components import Astryx primitives directly. Do not create
`AgentSmithButton`, `LegacyBadge`, or similar pass-through wrappers.

### 6.3 Required deletion

Delete replaced code as its consumer moves:

| Existing path or concept | Final action |
|---|---|
| Runtime `neutralTheme` selection | Replace with `agentSmithTheme`; remove old import |
| Direct neutral theme CSS as app authority | Remove after the AgentSmith theme CSS is active |
| `--bg-*`, `--text-*`, `--accent`, status and shadow legacy values | Migrate consumers to Astryx tokens, then delete |
| Legacy Tailwind color/radius/shadow aliases | Replace with the Astryx bridge, then delete |
| `.type-*` visual classes | Replace with Astryx typography, then delete |
| Raw Xterm theme colors | Resolve from the active Astryx theme |
| Unused serif/JJannon UI configuration | Delete |
| Custom Toast when Astryx covers the behavior | Migrate callers directly and delete |
| Primitive wrappers that only restyle Astryx | Delete; keep only domain compositions |
| Invalid or undefined semantic utility classes | Replace with Astryx semantics |

There is no later “legacy cleanup” milestone. A phase is incomplete while the
old path for that phase remains.

## 7. Target Product Experience

### 7.1 Usage

Use three visibly scoped sections:

1. **Project limits**: current project policy and remaining capacity.
2. **Your provider usage**: current user, current endpoint selector, and the
   existing provider period stated explicitly.
3. **Sandbox usage**: selected member, current allocation, lifetime totals,
   and on-demand Run history.

Sandbox overview content:

- Active now.
- Launches.
- Total runtime.
- CPU request-time.
- Memory request-time.
- All currently live Runs for the selected member, because current allocation
  must never be hidden.

Settled history appears behind `View run history`. Opening it requests the
first page. Closing it may retain the current page for the current visit but
must not trigger background loading. Live Runs occur only in the overview and
settled Runs occur only in history; the two result sets never overlap.

Run history rules:

- server-side opaque cursor;
- 20 rows by default and a conservative server maximum;
- stable order: released time descending, then Run ID descending;
- Task title is primary identity; Task and Run IDs are secondary and copyable;
- pagination shows the visible range and whether more data exists;
- member change refreshes Sandbox summary and live Runs, resets settled-history
  cursor, and does not change provider-usage scope;
- refresh and pagination retain known rows until replacement succeeds;
- mobile uses labelled rows rather than a forced 52rem-wide table.

The summary is computed over the complete authorized filter scope, never from
the current detail page.

### 7.2 Alerts and Audit

Alerts opens on `Active`:

- current actionable records ordered by creation time before history;
- one clear primary resolution action;
- resolved and dismissed records available through bounded History;
- Rules remains a peer view, not an analytics or automation platform.

Audit remains a light, read-only project history:

- existing server pagination remains. The final allowlist in
  `docs/task-workspace-product-improvement-plan.md` is authoritative; the Web
  does not preserve an old action merely because the current contract exposes
  it;
- Sandbox Audit retains only `sandbox.started`, `sandbox.released`, and
  `sandbox.failed`; obsolete historical Task and release-requested values are
  deleted without compatibility presentation;
- query controls stay next to the result scope;
- active filters and a direct reset remain visible;
- page/range and “more available” state remain understandable;
- refresh keeps the last usable page;
- selected detail remains open unless the selected record no longer exists;
- actor lookup must not depend only on current members or the current page.

Do not turn either view into governance infrastructure.

### 7.3 Files

Files keeps the Library -> current folder -> selected entry mental model.

- The selected Library and folder path remain in the URL.
- The existing authorized current-folder read remains the storage boundary.
  Do not add an index or claim that a response cursor bounds JuiceFS
  `readdir`, per-entry metadata reads, or sorting.
- The browser presents at most 50 loaded entries per page, with clear current
  page/range controls. This is a bounded presentation of the fully loaded
  current folder, not server pagination.
- Name filtering and sorting are explicitly scoped to the loaded current
  folder, and changing them returns to the first presentation page.
- Desktop may show Library, browser, and detail regions together.
- Narrow layouts show one primary region at a time; Library is a selector and
  details/preview becomes a sheet or disclosure.
- Pagination, refresh, and preview failure keep folder context and selection
  whenever the selected object still exists.
- Preview has stable dimensions and does not resize the file list.

Product-authored SVG may render as a bundled application asset. Uploaded or
published SVG, HTML, and unknown active content are never rendered inline as an
image. PNG, JPEG, GIF, and WebP may use one common safe preview path. The same
MIME allowlist applies to File Library and Task Artifact previews. Other
supported text and media types use an explicit allowlist; everything else
downloads.

### 7.4 Task as the primary workbench

Task occupies the useful remaining viewport. It is not capped at 48rem on a
tall display.

Desktop composition:

- compact Task identity and actions;
- one primary Conversation or Terminal region;
- composer anchored within the Conversation workbench;
- Artifacts available through a collapsible/resizable rail or peer view;
- Task metadata disclosed on demand.

Narrow composition:

- one primary Conversation, Terminal, or Artifacts view at a time;
- composer remains above the dynamic viewport and safe-area inset;
- no competing page scroll and timeline scroll for the primary operation.

The timeline has two explicit behavioral modes:

**Following latest**

- default on initial entry;
- restored only by an explicit current-work action: sending a message or
  selecting `Jump to latest`;
- preview growth and durable interactions keep the viewport at the bottom;
- updates do not use per-token smooth scrolling.

**Reading earlier**

- entered when the user deliberately moves away from the bottom;
- all live updates preserve the current viewport;
- a downward `New activity` control shows the accumulated update count;
- only sending a message or explicit `Jump to latest` resumes following;
- the count tracks newly appended durable interactions, not preview frames or
  revisions of an existing item.

History behavior:

- `Load earlier messages` is explicit; reaching the top does not silently
  request another page;
- prepend retains the first visible interaction ID and its pixel offset;
- concurrently arriving tail content does not alter that anchor;
- connection recovery and refresh keep the draft, mode, and reading position;
- known conversation remains visible during transient failure.

Composer behavior:

- Enter sends and Shift+Enter adds a line;
- IME composition Enter never sends;
- failed delivery keeps the draft;
- successful delivery returns focus without stealing focus from another
  control the user selected;
- queued-message edit/delete keeps the same Task and server capability model.

Terminal behavior:

- opening Terminal preserves Conversation state and draft;
- Terminal receives focus only after an explicit switch to Terminal;
- hidden reconnect or resize never steals focus;
- the Xterm palette, selection, cursor, and scrollbar derive from Astryx;
- Terminal remains one WebSocket path and does not create a second agent path.

### 7.5 Task performance design

Keep the existing interaction contract unless a measured problem requires a
contract change:

- one initial interaction snapshot;
- one cursor-resumable interaction SSE;
- one Terminal WebSocket;
- explicit API mutations and authoritative receipts.

Use one local Task presentation reducer for ordered interaction items,
revision lookup, queued messages, presentation, connection, preview, and
follow/read state.

Required behavior:

- unchanged or stale revisions return the existing collection;
- ordinary durable events append or replace by indexed ID without full-history
  Map construction and sorting;
- reset and earlier-history merge are the only full-order reconciliation paths;
- settled interaction rows and settled Markdown receive stable props and do
  not rerender for preview-only changes;
- Markdown plugin/component definitions are static;
- preview is an isolated tail item;
- preview frames are coalesced to at most one visible update per 50ms;
- preview may use lightweight plain text while streaming, then the durable
  final message replaces it with full Markdown;
- the server keeps the existing cumulative preview-frame contract in this
  milestone; only the client controls visible preview update frequency;
- healthy SSE presentation replaces the five-second Task-detail poll;
- explicit refresh and mutation receipts remain available;
- artifact refresh happens on an artifact event or explicit user action.

Do not begin with variable-height virtualization. Each explicit history request
is bounded, while history that the user explicitly loads may remain mounted.
First isolate streaming work and measure 50, 300, and 1,000 loaded
interactions. If 1,000 loaded items do not meet the acceptance behavior, use a
proven variable-height list library. Do not invent an eviction scheme or
in-house virtualization layer.

## 8. Functional Visual Assets

Visual assets must serve orientation, understanding, identity, or real output.

Include a small, coherent asset family:

- one formal AgentSmith brand mark SVG for shell and identity;
- up to three restrained empty/first-use SVG scenes for Tasks, Files, and
  initial project configuration only when each asset is mapped to one concrete
  empty state, the user question it answers, and the primary next action;
- compact product diagrams only where a relationship is otherwise hard to
  understand;
- accessible SVG mini-trends for real Usage data when accompanied by exact
  values;
- file thumbnails and Artifact previews based on real content.

Asset rules:

- one authored visual language, with light/dark-safe colors from Astryx;
- stable reserved dimensions and useful alternative text, or `aria-hidden`
  when purely supplementary;
- no gradient background, orb, decorative mascot, stock-like hero, or
  page-specific illustration collection;
- no second control icon set; Lucide remains the control icon system;
- no illustration inside the active Task timeline, Terminal, forms, tables,
  Audit, Alerts, or settings;
- generated raster art is not a default deliverable. If one concrete
  first-use state is demonstrably clearer with it, curate the static asset at
  development time; never generate media at runtime;
- real user and agent content always takes priority once present.

## 9. API and Storage Changes

### 9.1 Usage

Keep one Project Usage area but separate bounded reads:

- the existing overview returns project limits, provider summary, Sandbox
  summary, and `liveRuns` only;
- a settled Sandbox Runs query accepts selected member, opaque cursor, and
  limit;
- response returns `items`, `nextCursor`, and the authoritative summary scope
  timestamp needed by the UI;
- aggregation uses the full authorized filter scope in PostgreSQL;
- pagination order is stable and includes a unique tie-breaker.

Do not encode raw offset or database keys as a public cursor.

### 9.2 Files

Do not change the current Library directory API in this milestone. It continues
to return the authorized current folder after canonical path checks. The Web
adds a 50-entry presentation page over that loaded result.

Do not add cursors that only shrink the response while the server still reads,
stats, and sorts the full JuiceFS directory. Do not add recursive search,
indexing, full-text search, or cross-Library queries.

### 9.3 Task list

Keep the existing response shape and change the opaque cursor implementation
from offset semantics to keyset semantics bound to:

- query and status filter;
- selected sort and direction;
- final item sort value;
- Task ID tie-breaker.

Task interaction snapshot/history/SSE contracts remain unchanged in this
milestone.

### 9.4 Task Artifacts

Extend the existing Task Artifact list route with an opaque keyset cursor and a
bounded limit. The Task workbench requests the latest page; `View all` pages
through older Artifacts. Preview and download routes remain unchanged.

Order by publication time descending with Artifact ID as the unique
tie-breaker. Keep task membership authorization and all artifact filtering on
the server.

### 9.5 Alerts and Audit

Reuse existing created-time filtered pagination. Change the default Alerts
status to Active without adding a client-only reorder. Do not change the
product's final Audit scope. Add only the actor lookup/facet needed to select
authorized historical actors without loading all events.

## 10. Implementation Phases

Each phase is a usable vertical change. It migrates callers and deletes the
replaced path before moving on.

### Phase 1: Astryx foundation and shell

Deliver:

- define and build `agentSmithTheme`;
- select only that theme in the provider;
- make Astryx the source for fonts, light/dark colors, semantics, geometry,
  motion, syntax, and shared primitives;
- convert the Tailwind configuration into a layout-oriented Astryx token
  bridge;
- mechanically migrate every retained page and domain component from legacy
  visual variables, `.type-*`, raw UI colors, and old Tailwind visual keys to
  Astryx tokens in this phase;
- migrate shell, navigation, page composition, typography, focus, toast,
  loading, empty, error, and confirmation presentation;
- remove the neutral runtime selection and the complete legacy theme
  namespace. Do not leave temporary aliases for later page phases.

Focused checks:

- light, dark, system selection and first paint;
- keyboard shell navigation, focus, overlays, and narrow navigation;
- no legacy theme variable, `.type-*`, raw UI color, or old Tailwind visual key
  remains anywhere in the retained Web App.

Completion:

- every retained page and Xterm render through the AgentSmith Astryx Theme;
- remaining phases improve Astryx primitive use and domain composition without
  depending on a second visual source.

### Phase 2: Task workbench and long-session performance

Deliver:

- migrate Task list/create/detail/timeline/composer/Terminal/Artifacts to
  Astryx;
- implement full-height responsive workbench and on-demand Artifact region;
- implement explicit following/latest and reading/earlier behavior;
- anchor history prepend by visible interaction;
- introduce the local Task presentation reducer and stable row rendering;
- isolate and coalesce preview rendering;
- remove healthy-SSE detail polling and hidden Terminal focus behavior;
- change Task list cursor to keyset semantics;
- paginate Task Artifacts and request only the newest page in the workbench;
- apply the common safe File/Artifact MIME preview allowlist;
- delete the replaced Task visual and state-update paths.

Focused checks:

- create a Task, send and queue messages, receive streamed work and final
  Markdown, open an Artifact, switch Terminal, reconnect, and release Sandbox;
- page through Artifacts; publish SVG and PNG outputs and confirm only the safe
  raster image previews inline;
- read earlier history while updates arrive and confirm the viewport does not
  move;
- confirm draft, focus, reading position, and Task identity survive expected
  transitions;
- inspect representative 50/300/1,000-item sessions locally and fix observed
  long commits in place.

Completion:

- settled rows do not render for preview-only changes;
- visible preview updates do not exceed 20 per second;
- following remains pinned; reading remains anchored;
- an active Task has one interaction SSE and no five-second detail poll;
- the workbench fetches one bounded Artifact page;
- no Task action creates a second session or successor Task.

### Phase 3: Usage and bounded detail

Deliver:

- split summary/live allocation from paginated Run history;
- implement the server query, cursor, aggregation, contract, API client, and
  Astryx UI together;
- move member selection into Sandbox scope;
- clarify Project, current user, selected member, and endpoint periods;
- make the history disclosure and pagination responsive;
- delete unbounded store/application/UI reads.

Focused checks:

- current user and administrator-selected member;
- live Run visibility, settled history, member changes, pagination, refresh,
  empty history, deleted Task reference, and transient error;
- aggregate totals remain constant while paging;
- default request remains bounded regardless of historical Run count.

Completion:

- Usage first view never fetches settled Run history;
- history fetches only one bounded page after explicit disclosure;
- no client-side fake pagination remains.

### Phase 4: Files, Alerts, Audit, and remaining pages

Deliver:

- add bounded 50-entry current-folder presentation and migrate Files/preview
  to Astryx without changing the directory API;
- make Alerts active-first and history bounded;
- complete Audit filter, paging, actor selection, continuity, and mobile
  presentation;
- migrate all other retained pages and dialogs directly to Astryx;
- remove replaced primitive and composition code for each page as that page
  lands.

Files, Alerts, Audit, and each remaining page are independent vertical commit
boundaries inside this phase. Do not defer their old-path deletion until the
whole phase ends.

Focused checks:

- large loaded current folder, local filter/sort/presentation pages,
  back/forward, upload, preview, download, delete, and preview failure;
- upload and publish the same SVG and PNG; confirm both Files and Artifacts use
  the same inline-preview decision;
- active and historical Alerts, rules, acknowledgement/dismissal, filtered
  empty reset, deep link, and failure continuity;
- Audit filter combinations, historical actor, paging, detail, and refresh
  failure;
- retained settings, members, credentials, endpoints, contexts, and overview
  actions in desktop and narrow composition.

Completion:

- every database-backed potentially unbounded retained list has a server
  bound; Files honestly retains one current-folder read and a bounded browser
  presentation;
- no page uses a legacy visual primitive or visual token.

### Phase 5: Functional assets and local product pass

Deliver:

- add the approved brand SVG and limited empty-state/first-use asset family;
- consolidate real file and Artifact previews;
- add only useful, exact-data-backed mini visualizations;
- remove decorative placeholders and redundant bordered containers discovered
  while placing the assets;
- complete one serial local single-node K8s product pass.

Focused local path:

1. OIDC login and theme selection.
2. Create/open a Project and Endpoint.
3. Create a Task and File Library.
4. Work through a multi-turn Task with streaming, tool activity, Terminal,
   file output, Artifact preview, history reading, and reconnect.
5. Release the Sandbox and confirm the same Task and Library remain.
6. Inspect bounded Usage history, active Alerts, Audit, and a large folder.
7. Check desktop light/dark, one narrow viewport, low height, keyboard, focus,
   and reduced motion where the changed path uses motion.

Completion:

- functional assets help the empty or real-content state without displacing
  work;
- the four milestone outcomes hold in the real local K8s product path;
- issues found are fixed in place, without producing a report or new gate.

## 11. Code Change Map

### Theme and shared UI

- `src/theme/agentsmith-theme.ts` or the equivalent single theme source
- `src/app/providers.tsx`
- `src/app/globals.css`
- `tailwind.config.js`
- `src/components/theme/*`
- `src/components/layout/*`
- `src/components/app-shell/*`
- `src/components/ui/*`

### Task

- `src/components/tasks/*`
- `src/lib/api/client.ts`
- `packages/contracts/src/api.ts`
- `packages/application/src/taskService.ts`
- `packages/adapters-postgres/src/postgresProductStore.ts`
- existing focused Task state and service tests

### Usage, Alerts, and Audit

- `src/components/resources/AuditUsagePage.tsx`
- `src/components/resources/UsageView.tsx`
- `src/components/resources/AlertsPage.tsx`
- `packages/contracts/src/api.ts`
- `packages/application/src/projectPolicyService.ts`
- `packages/adapters-postgres/src/postgresProductStore.ts`
- existing focused policy/store tests

### Files and media

- `src/components/files/ProjectFilesPage.tsx`
- `src/components/tasks/TaskArtifactActions.tsx`
- `packages/contracts/src/api.ts`
- `packages/application/src/fileService.ts`
- the existing filesystem adapter/store path
- `public/` for approved bundled product assets

These are ownership hints, not permission to create new architectural layers.
Prefer editing the existing vertical path.

## 12. Development and Verification Discipline

- Work one vertical phase at a time and keep build, browser, database, image,
  and K8s work serial.
- Use existing Astryx APIs directly. If an Astryx capability is unclear, read
  its installed source and use the narrowest supported path.
- Add tests only for changed business/query/reducer behavior that is costly to
  verify repeatedly by hand.
- Do not add TSX/JSDOM tests merely to assert Astryx styling.
- Do not test Tailwind, Astryx, Playwright, test helpers, or scripts.
- Use temporary Playwright actions and browser profiling for real interaction
  questions. Do not commit a browser suite, screenshots, traces, profiles, or
  performance dashboard for this milestone.
- Choose the smallest verification justified by the current risk. Reducer and
  cursor changes use focused existing-layer checks; visual changes use a
  temporary browser pass; cross-service semantic changes use the relevant
  integration path. The 50/300/1,000 Task inspection is a one-time diagnostic
  for that change, not a default gate.
- Use the real local single-node K8s path for the final product pass. Cloud
  testing is not required.
- Fail fast, correct the implementation in place, and delete obsolete code
  immediately.

## 13. Handoff Completion Criteria

The milestone is complete when:

- AgentSmith has one runtime theme and one editable visual source:
  `agentSmithTheme`.
- No legacy theme, compatibility variable, visual fallback, wrapper adapter,
  raw UI palette, or separately selected neutral theme remains.
- Every retained Web page uses Astryx primitives or an Astryx-themed
  AgentSmith domain component.
- Usage defaults to bounded summaries and live allocation; completed Sandbox
  Runs are explicitly opened and server-paginated.
- Alerts is active-first; Audit and Task Artifacts use bounded reads; Files
  stays current-folder-scoped with bounded presentation and continuity through
  refresh and presentation paging.
- Task behaves as a stable long-running workbench in following and reading
  modes, with responsive streaming and preserved drafts, focus, and position.
- Task interaction rendering remains responsive with representative long
  histories without an unproven custom virtualization layer.
- Product SVG and media are limited, coherent, safe, and useful.
- All business decisions remain server-owned and Web remains an AgentSmith API
  client.
- The retained local OIDC -> Project -> Endpoint -> Task -> Sandbox ->
  Files/Artifacts -> Usage/Alerts/Audit path works in the local single-node K8s
  environment.
- No governance framework, report, evidence artifact, visual baseline, or
  release gate was added.
