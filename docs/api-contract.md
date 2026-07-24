# API Semantics

Mutating routes require the session cookie and `x-csrf-token`; command routes that declare replay protection also require an `Idempotency-Key`. Task resources require project membership; there is no global control-plane API. The Web client uses only AgentSmith `/api/v1` routes and never calls Botified.

Project credential create and rotate requests accept a plaintext provider secret only for that write. The server encrypts it before storage and returns metadata, mask/fingerprint, and rotation information only. Endpoint create and update requests bind an existing project credential through `credentialId`. Endpoint `baseUrl` must be HTTPS and must not include credentials, query, or hash; it must normalize to the bound credential base URL. Public credential, endpoint, dashboard, and Task payloads never expose provider plaintext.

`GET /api/v1/workspaces` projects include the current user's nullable `pinnedAt`; it is never shared with other members. `PUT /api/v1/projects/{projectId}/pin` accepts `{ pinned: boolean }` and naturally idempotently sets that member's pin. Removing project membership removes the pin.

## Project Usage

`GET /api/v1/projects/{projectId}/usage` accepts only `endpointId` and `userId`.
It is a bounded database read and returns
`{ projectId, limits, fileStorage, provider, sandbox }`; it never traverses
Project files. Provider data is always scoped to the authenticated user and one
explicit 30 UTC-day period. The endpoint selector filters `daily` and `totals`;
`endpoints` retains that user's per-endpoint period totals and rolling limits.
Sandbox data is scoped to the selected member and returns the Project-lifetime
summary plus every capacity-holding Run in `liveRuns`; `unreleasedCount` counts
all of them, including `starting`, `release_requested`, and `failed`. It never
returns settled Runs.

`fileStorage` is the last recorded storage projection:
`{ recordedBytes, measuredAt, limitBytes, remainingBytes }`. It is separate
from `limits`; `measuredAt` is the time of the most recent complete File Library
root traversal, and `null` means no such measurement exists. Known API file
mutations can update `recordedBytes` without changing that measurement time.
The scope is every regular file under the Project's current File Library roots,
including workspace and projected artifact files; symbolic links are not
followed. Sandbox containers write directly to the shared JuiceFS volume, so
the recorded value can change immediately after any measurement.

`POST /api/v1/projects/{projectId}/usage/file-storage/refresh` accepts no query
parameters and requires an empty JSON object. Any current Project member may
call it with the normal session and CSRF token; it deliberately has no
idempotency key because every request performs a new measurement. It measures
and stores File Library bytes while holding the process-local Project file
lock, then returns `{ projectId, fileStorage }`. This is a point-in-time
measurement, not a filesystem snapshot or a lock against concurrent sandbox
writes. An over-limit measurement is still recorded and returned with HTTP
200, and file-storage alerts are updated or recovered from the measured value.

`GET /api/v1/projects/{projectId}/usage/sandbox-runs` accepts only `userId`,
`cursor`, and `limit`; the default is 20 and the maximum is 50. It returns
`{ projectId, selectedUserId, summaryStartedAt, scopeMeasuredAt, items,
nextCursor }`, ordered by release time and Run ID descending. Its opaque v1
cursor binds the Project, selected member, first-page snapshot timestamp, and
final item key. Later pages exclude Runs released after that snapshot. Deleted
Tasks retain a null title and `taskAvailable: false`. Members may select only
themselves; Project owners and administrators may select another current
member.

Alert, rule, and Audit reads retain legacy Task-terminal records only as
history. Legacy `task_failure` alerts and rules are returned as
`historical_task_failure`; historical alerts are never `active`, and historical
rules are disabled with their prior enabled state available only for display.
Legacy Task-terminal Audit rows use `task.historical_terminal`, with the prior
action available only for display. Historical alerts and rules are read-only:
they cannot be acknowledged, silenced, edited, tested, enabled, or deleted, and
they are excluded from runtime evaluation and mutation. None of these historical
records represents a current Sandbox failure.

## Task Conversation

Task Conversation has eight routes. The removed transcript and raw `/events` routes have no replacement.

| Route | Purpose |
| --- | --- |
| `GET /api/v1/tasks/{taskId}/interactions` | Returns the paged typed interaction snapshot. `cursor` pages older items and `limit` is bounded by the server. |
| `GET /api/v1/tasks/{taskId}/interactions/stream` | Streams changes from a signed stream cursor supplied as `cursor` or `Last-Event-ID`. |
| `POST /api/v1/tasks/{taskId}/messages` | Submits `{ content }` through the task's single composer. |
| `PATCH /api/v1/tasks/{taskId}/messages/{messageId}` | Changes an editable queued message with `{ content }`. |
| `DELETE /api/v1/tasks/{taskId}/messages/{messageId}` | Deletes a deletable queued message. |
| `POST /api/v1/tasks/{taskId}/turn/abort` | Stops only the current Botified turn. |
| `POST /api/v1/tasks/{taskId}/work/{interactionId}/stop` | Stops a stoppable typed background-work interaction. |
| `POST /api/v1/tasks/{taskId}/sandbox/release` | Unconditionally releases the current Sandbox Run after user confirmation. |

Public Task responses expose only durable Task fields, the three state
projections, and server-calculated capabilities. Rendered Kubernetes resources,
namespace, internal mount paths, image references, generated ConfigMaps, and
Secret structures remain server-side and are never part of the browser
contract.

An interaction has stable `id`, monotonic `revision`, `position`, `occurredAt`, and `updatedAt`. Its discriminated `kind` is one of `user_message`, `assistant_message`, `tool`, `background_task`, `task_question`, `task_notice`, `task_result`, `subagent_result`, `file`, or `system_error`; each kind carries its typed status and controlled detail fields. Tool and work execution status is separate from delivery status. File items expose an AgentSmith artifact ID only.

The interaction snapshot contains `items`, history and stream cursors, `historyStatus` (`complete` or `gap`), queued messages, runtime reachability, last sync time, and the canonical Task `presentation`. That presentation contains the durable Task fields, state projections, and server-calculated capabilities. Capabilities include `sendMessage`, `editQueuedMessage`, `abortTurn`, `stopWork`, `openTerminal`, `releaseSandbox`, `editTask`, `archiveTask`, and `deleteTask`; clients must use them rather than infer actions from Task or Sandbox state.

Message mutations return a typed receipt: `messageId`, `disposition`, duplicate flag, queued message or interaction when applicable, the canonical Task `presentation`, and a safe error on failure. A message sent while the Sandbox is released atomically starts a new Run for the same Task, Botified session, and File Library before delivery. It never creates a successor Task. Repeated requests with the same idempotency key do not create duplicate messages or Runs.

The interaction SSE stream has one durable event: `interaction`. It carries a complete interaction item and an opaque cursor in `id`; clients upsert by `id + revision` and return the cursor without parsing it. Transient `state` frames carry only `queuedMessages` and the canonical Task `presentation`; `connection` carries `connectionState`, `runtimeReachability`, `historyStatus`, `lastSyncedAt`, and a safe nullable message; `preview_status` reports optional live-preview availability without changing the interaction connection state. The server emits each transient frame independently whenever its authoritative fields change.

`assistant_preview` and `assistant_preview_clear` update only the active temporary assistant surface. `reset` carries an authoritative interaction snapshot, `reconnect` asks the client to reconnect with its last durable cursor, and `done` is sent only after Task deletion. The stream sends comment heartbeats and has a finite connection lifetime. Every reconnect rechecks the OIDC session and Task membership before durable catch-up resumes.

Task list and detail routes expose the final projections only. `lifecycle` is
`active | archived`; `currentTurn` is `ready | queued | starting | running |
aborting`; `sandboxState` is `starting | active | release_requested | failed |
released` and includes the Run ID plus a safe Run-owned cause while a failed Run
is failed or awaiting release.
There is no public Task execution status or second SSE Run-state channel.

`GET /api/v1/projects/{projectId}/tasks` returns `{ items, nextCursor, total }`.
Its opaque v1 cursor is a keyset bound to the Project, normalized search and
archive scope, selected sort and direction, final sort value, and Task ID.
`total` describes the complete filtered scope and is unchanged while paging.
Offset cursors are not accepted.

`GET /api/v1/tasks/{taskId}/artifacts` returns
`{ items, nextCursor }`, newest publication first, with Artifact ID as the
tie-breaker. `limit` defaults to 20 and is capped at 100. Optional `kind`
(`text | image | file`), `mediaType`, and `preview=true` filters are applied
before limiting. The opaque v1 cursor is bound to the Task and normalized
filters. Artifact list payloads never expose the stored Botified file ID;
download remains the authorized attachment route for one exact Artifact.

`POST .../turn/abort` stops only the current turn and does not release the Sandbox or stop detached work. `POST .../sandbox/release` fences later delivery to the current Run, unconditionally stops its agent, terminals, and processes, deletes only its app-owned Kubernetes resources, and settles that Run's Usage once. Conversation history and the bound File Library remain available. The next message or Terminal open starts a new Run without resuming work interrupted by the release. Both routes return server-authoritative state or capabilities; neither action is inferred by the Web client.
