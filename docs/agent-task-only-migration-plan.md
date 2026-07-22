# Agent Task-only Migration Plan

## Goal

AgentSmith Lite has one user work model: an **Agent Task**. A Task is the only
place to start, continue, inspect, or stop agent work. It owns its continuous
agent context, execution lifecycle, and task-bound files. There is no separate
project Chat product, conversation type, or direct provider-chat workflow.

This change removes the existing Chat module completely. It is not a navigation
change, a hidden route, or a compatibility layer. A user who wants to work with
an agent creates or opens a Task.

The Web App remains guided by
[UX/UI Design Principles](./ux-ui-design-principles.md): work is primary,
navigation is stable, states are explicit, and the interface does not expose
implementation detail.

## Scope and Non-goals

In scope:

- Remove the independent Chat UI, route, navigation entry, API, service,
  contracts, store operations, database tables, migrations' retained schema,
  audit action/resource variants, and tests.
- Make Task the sole agent interaction entry point in project navigation and
  project overview actions.
- Preserve the existing Task conversation and Botified service API as the one
  agent-message path; do not introduce a second client-side agent path.
- Remove references to Chat from product, architecture, API, development, and
  port-planning documentation when they describe live functionality.

Out of scope:

- Converting Chat threads into Tasks.
- Adding a chat-like quick prompt mode, a task-template system, or a second
  conversation UI.
- Changing Task execution, sandbox, file-library, endpoint, identity, or
  resource-policy behavior except where a Chat dependency must be removed.
- Preserving a read-only Chat archive or export mechanism.

## Product Boundary

The project has one agent-work destination, labelled **Tasks**. Creating a
Task is the single way to select the endpoint and task inputs required for
agent work. Once created, every follow-up is sent to that same Task's agent
context. Task list and Task detail are the only surfaces that present agent
history.

Endpoints stay because Tasks use OpenAI-compatible completions through the
server. The endpoint protocol name is an infrastructure contract, not evidence
of a user-visible Chat feature.

## Removal Boundary

### Web App

Delete the project Chat route and its loading/error route files, all
`components/chat` components, Chat navigation icon/item, Chat client types and
methods, Chat-specific route state, and Chat-only UI tests. Replace any project
overview or empty-state action that opens Chat with the existing Task creation
path. No redirect is needed: the removed URL returns the application's normal
not-found result.

### Public API and server

Delete all `/api/v1/projects/{projectId}/chat/...` route handling, validation,
stream framing, request parsing, idempotency cases, and API-route recognition.
Delete the legacy direct project-completion endpoint if it exists solely for
the removed Chat module. Keep the task-internal OpenAI-compatible completion
endpoint: it is the server-to-Botified execution boundary, not a public Chat
API.

Remove `ProjectCapabilities.canSendChat`, `ProjectOverviewAction.start_chat`,
and `chatReadyEndpointCount` from their calculation logic, every API
serialization, frontend type and consumer, and test fixture. The Task path
retains only `canCreateTasks` and `taskReadyEndpointCount` for agent-work
availability.

Remove `ProjectChatThread`, `ProjectChatMessage`, Chat response types used only
by that module, Chat audit actions/resource kinds, and the corresponding
project-policy mappings. Retain generic provider accounting and endpoint
health behavior used by Tasks.

### Application and persistence

Delete `ChatService` and its construction in the application factory. Remove
all Chat operations from `ProductStore`, the in-memory store, and the Postgres
store. Remove Chat-specific project deletion and endpoint-deletion handling
once their tables no longer exist.

Add one forward-only database migration that:

1. Deletes audit events whose action is `chat.thread.*` or `chat.message.*`.
2. Drops the Chat audit constraints and recreates them without Chat actions or
   Chat resource kinds.
3. Drops `project_chat_messages` and `project_chat_threads`, including their
   indexes and dependent constraints.

Earlier historical migration files remain immutable. The new migration is the
only removal mechanism for an existing database; a fresh database simply
applies the full migration sequence and ends without Chat tables.

## Data Compatibility Decision

Chat data is intentionally **not retained and is not migrated**. Threads and
messages cannot be transformed reliably into Task work: a Task needs a task
identity, endpoint binding, file-library choice, Botified session, and
execution lifecycle that a Chat thread does not have. Inferring those values
would create misleading Tasks and a second migration-specific behavior.

The local single-node deployment is the supported target. The upgrade path is
therefore a clear, destructive product simplification: deploy the migration
with the application release and remove old Chat data. Existing Task history,
Task files, artifacts, endpoint configuration, project data, usage, and
non-Chat audit history remain untouched.

## Implementation Sequence

1. Establish focused failing tests for the desired boundary: Tasks remain
   available; the former Chat route and API are absent; and a migrated database
   has no Chat tables, Chat actions, or Chat resource kinds.
2. Remove public Web App routes, navigation, page components, client contracts,
   and their tests. Remove `canSendChat`, `start_chat`, and
   `chatReadyEndpointCount` from overview/capability calculation, API payloads,
   frontend consumption, and fixtures; retain the equivalent Task fields.
   Update project-level actions to create a Task.
3. Remove server routes and request handling, then remove Chat contracts,
   `ChatService`, factory wiring, policy mappings, Store port methods, and both
   store implementations. Keep provider and Task code only where Task uses it.
4. Add the forward-only database migration and adjust migration/integration
   coverage to assert the final schema rather than historic Chat behavior.
5. Remove obsolete Chat references from the maintained product and developer
   documents. Update broad workflow tests that previously exercised Chat to
   exercise the Task path instead.
6. Search the owned application, packages, migrations, Web App, and tests for
   remaining independent Chat symbols and routes. Retain only generic
   `openai_chat_completions` protocol naming and the task-internal completion
   route that Botified requires.

Each step lands as a small coherent change. Avoid a temporary adapter, feature
flag, deprecated route, dual write, or compatibility API.

## Verification Focus

Use narrow tests selected for the changed boundary:

- a Task creation and follow-up path still reaches the Task service and
  Botified through the server;
- former Chat routes and API paths are not recognized;
- the Postgres migration removes only Chat tables and Chat-specific audit
  values while retaining Task data;
- the project shell exposes Tasks as the sole agent-work destination; and
- a visual check confirms task creation and task detail remain clear at desktop
  and narrow layouts after navigation changes.

Do not add a parallel test harness, generated reports, or release-gate layer.

## Completion Definition

The migration is complete when the shipped application contains one agent work
model, **Agent Task**: no standalone Chat page, route, UI components, public
Chat API, Chat service, Chat-specific domain contracts, storage operations,
database tables, Chat audit variants, or live documentation remain. Task
creation and continuation work through the existing server-owned Task path,
and the Web App presents Tasks as the only agent-work destination.
