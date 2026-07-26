# API Semantics

Mutating routes require the session cookie and `x-csrf-token`; command routes that declare replay protection also require an `Idempotency-Key`. Task resources require project membership; there is no global control-plane API. The Web client uses only AgentSmith `/api/v1` routes and never calls Botified.

Task create and Task message commands expose only three server outcomes:
`completed`, `accepted_in_progress`, and `rejected_before_acceptance`. Every
response includes `keyDisposition`. A completed command returns
`keyDisposition: retire`; an accepted command whose final response is not yet
durable returns `keyDisposition: retain`; a rejected command returns either
value according to whether replay may still converge. An idempotency
fingerprint mismatch is `rejected_before_acceptance` with `retain`, does not
replace the original command, and leaves the original payload replayable with
the same key. Ordinary rejection before admission retires the key. When the
server cannot prove rejection or completion, it retains the key.

Task message never returns `accepted_in_progress`: its message identity,
interaction, optional Sandbox admission, and completed command receipt commit
atomically. A short-lived unresolved claim is returned as a retained rejection
for the Web client to synthesize as `outcome_unknown`. Task create may return
`accepted_in_progress` after its Task, File Library binding, initial
interaction, optional Run, and durable preparation operation have committed
but JuiceFS preparation has not completed. Replaying the original Task create
route resumes that same Task identity; there is no status query route. Recovery
uses the persisted Task, Library, Run, context snapshot, and preparation
operation directly. It does not re-run mutable Endpoint health, context
resolution, or Sandbox capacity admission. Reclaiming an expired preparation
lease preserves the original Task resource ID. Any failure while reading or
preparing an already-admitted identity remains `accepted_in_progress` with
`keyDisposition: retain`.

Project credential create and rotate requests accept a plaintext provider secret only for that write. The server encrypts it before storage and returns metadata, mask/fingerprint, and rotation information only. Endpoint create and update requests bind an existing project credential through `credentialId`. Endpoint `baseUrl` must be HTTPS and must not include credentials, query, or hash; it must normalize to the bound credential base URL. Public credential, endpoint, dashboard, and Task payloads never expose provider plaintext.

`GET /api/v1/workspaces` projects include the current user's nullable `pinnedAt`; it is never shared with other members. `PUT /api/v1/projects/{projectId}/pin` accepts `{ pinned: boolean }` and naturally idempotently sets that member's pin. Removing project membership removes the pin.

## Provider Directories

`GET /api/v1/projects/{projectId}/credentials` accepts only `q`, `cursor`, and
`limit`; `GET /api/v1/projects/{projectId}/endpoints` additionally accepts
`mode=all|task_ready`. Both default to 20 items and cap `limit` at 50.
Credentials return `{ items, nextCursor }`; endpoints return
`{ items, nextCursor, total, readiness }`. Endpoint items embed their safe
credential summary. Public credential reads never select encrypted secret
columns.

Both directories order by `createdAt` and ID descending, using PostgreSQL `C`
collation for IDs. Their canonical cursors bind the authenticated actor,
Project, normalized search, directory kind, and endpoint mode, but not the
limit. Search is trimmed, case-insensitive, capped at 160 characters, and
rejects controls. Empty, malformed, noncanonical, cross-actor, cross-Project,
cross-query, and cross-mode cursors are rejected.

`GET /api/v1/projects/{projectId}/credentials/{credentialId}` and
`GET /api/v1/projects/{projectId}/endpoints/{endpointId}` are authoritative
Project-scoped exact metadata reads; they never scan a directory. Endpoint
name uniqueness and policy endpoint validation are targeted store operations,
not full-directory reads.

## Membership Directories

`GET /api/v1/workspaces/{workspaceId}/members` and
`GET /api/v1/projects/{projectId}/members` accept only `q`, `role`, `cursor`,
and `limit`. `GET /api/v1/projects/{projectId}/members/candidates` accepts only
`q`, `cursor`, and `limit` and requires active Project administrator access.
All three return `{ items, nextCursor }`; the default limit is 20 and the
maximum is 50. Search is case-insensitive across user ID, display name, and
email. Results use immutable `createdAt` and user ID ascending keysets, with
user IDs compared using PostgreSQL `C` collation.

Membership cursors are canonical opaque values bound to the authenticated
actor, directory kind, Workspace or Project, normalized query, and role
filter; changing only `limit` is allowed. Project candidates are selected
server-side from current Workspace members who do not already belong to the
Project. Membership mutations return one authoritative exact rich membership
read and never scan a directory page. Complete membership fan-out used by
Workspace revocation, quota recovery, and notifications is an explicit
internal operation and is never truncated by directory limits.

## Project Usage

`GET /api/v1/projects/{projectId}/usage` accepts only `endpointId` and `userId`.
It is a bounded database read and returns
`{ projectId, canSelectMemberUsage, limits, fileStorage, provider, sandbox }`;
it never traverses Project files. `canSelectMemberUsage` is authoritative and
true only for a Project owner or administrator. Provider data is always scoped
to the authenticated user and one explicit 30 UTC-day period. The endpoint
selector filters `daily` and `totals`; the base response includes the exact
selected endpoint summary and no all-endpoint array. Sandbox data is scoped to the
selected member and returns the Project-lifetime summary plus every
capacity-holding Run in `liveRuns`; `unreleasedCount` counts all of them,
including `starting`, `release_requested`, and `failed`. It never returns
settled Runs.

`GET /api/v1/projects/{projectId}/usage/endpoints` accepts only `q`, `cursor`,
`limit`, and the existing authorized `userId` scope. It returns
`{ items, nextCursor, total }` with settled 30-day totals and rolling limits
for current endpoints, ordered by endpoint `createdAt` and ID descending.
Search, limits, cursor canonicalization, and cursor binding match the endpoint
directory; the cursor additionally binds the selected usage user.

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

## Project Alerts

`GET /api/v1/projects/{projectId}/alerts` accepts only `view`, `cursor`, and
`limit`. `view` is `active` or `history` and defaults to `active`; history
contains both resolved and dismissed alerts without a status subfilter. The
default limit is 20 and the maximum is 50. Legacy `status`, `view=all`, unknown
views, unknown query parameters, raw key cursors, and cursors from another
Project or view are rejected.

The response is `{ view, items, nextCursor, activeCount }`. Items are ordered by
`createdAt` and ID descending, with IDs compared using PostgreSQL `C` collation.
The opaque base64url JSON v1 cursor binds the Project, view, and final
`{ createdAt, id }` key. `activeCount` always counts the Project's active alerts
independently of the selected view. PostgreSQL obtains the page and count from
one repeatable-read snapshot.

Alert collection and deeplink GETs are pure reads: they do not evaluate rules,
recover alerts, write Audit events, or send notifications. Evaluation and
recovery run only from the business event that changed usage, health, failure,
policy, or rule state. Recovery targets affected rule IDs or an unconfigured
fallback alert; it does not scan and repair alerts during a read.

Each Project has at most 50 alert rules. Rule creation locks the Project and
checks the cap in the same transaction, so concurrent creation cannot exceed
it; the 51st rule returns a conflict and idempotent replay returns the original
result. Gauge rules (`active_tasks`, `project_file_bytes`) have a null window.
Provider and failure rules default to 3600 seconds and accept only 60 through
2592000 seconds. Alert and rule resources are looked up by Project and ID.

## Project Audit

`GET /api/v1/projects/{projectId}/audit` is a pure bounded read available to
Project viewers. It accepts only `actorId`, `subjectUserId`, `action`, `status`,
`resourceKind`, `resourceId`, `from`, `to`, `cursor`, and `limit`. The default
limit is 20 and the maximum is 100. Filters are applied before the keyset and
limit. Results are ordered by `createdAt` and ID descending, with tied IDs
compared using PostgreSQL `C` collation.

The response is `{ items, nextCursor }`. Each item projects
`actorDisplayName`, `actorEmail`, `subjectDisplayName`, and `subjectEmail` in
the same bounded store query. It does not list memberships, fetch full users,
perform per-row identity queries, or write data. The canonical base64url JSON
v1 cursor binds the Project, every normalized filter, and the final
`{ createdAt, id }` key; changing only `limit` is allowed. Malformed,
noncanonical, cross-Project, or cross-filter cursors are rejected.

`GET /api/v1/projects/{projectId}/audit/identities` accepts only
`role=actor|subject`, optional `q`, `cursor`, and `limit`. The default limit is
20 and the maximum is 50; `q` is trimmed, limited to 120 characters, and
matches ID, display name, or email case-insensitively. Only non-null IDs
present in the selected Audit column for that Project are candidates, with an
exact ID match first. It returns `{ items: [{ id, displayName, email }],
nextCursor }`. Its canonical v1 cursor binds Project, role, normalized query,
and the final ID key.

Audit actions are final business events. `task.historical_terminal` and
`sandbox.release_requested` do not exist in the contract. Explicit sandbox
release still uses the internal `release_requested` Run state for fencing,
cleanup, and idempotency, while Audit records only the final
`sandbox.released` event.

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
