# API Semantics

Mutating routes require the session cookie and `x-csrf-token`; command routes that declare replay protection also require an `Idempotency-Key`. Task resources require project membership; there is no global control-plane API. The Web client uses only AgentSmith `/api/v1` routes and never calls Botified.

Project credential create and rotate requests accept a plaintext provider secret only for that write. The server encrypts it before storage and returns metadata, mask/fingerprint, and rotation information only. Endpoint create and update requests bind an existing project credential through `credentialId`. Endpoint `baseUrl` must be HTTPS and must not include credentials, query, or hash; it must normalize to the bound credential base URL. Public credential, endpoint, dashboard, and Task payloads never expose provider plaintext.

`GET /api/v1/workspaces` projects include the current user's nullable `pinnedAt`; it is never shared with other members. `PUT /api/v1/projects/{projectId}/pin` accepts `{ pinned: boolean }` and naturally idempotently sets that member's pin. Removing project membership removes the pin.

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

Public task list/detail and mutation responses expose `sandbox.namespace` only. Rendered Kubernetes resources, internal mount paths, image references, generated ConfigMaps, and Secret structures remain in the persisted lifecycle model and are never part of the browser contract.

An interaction has stable `id`, monotonic `revision`, `position`, `occurredAt`, and `updatedAt`. Its discriminated `kind` is one of `user_message`, `assistant_message`, `tool`, `background_task`, `task_question`, `task_notice`, `task_result`, `subagent_result`, `file`, or `system_error`; each kind carries its typed status and controlled detail fields. Tool and work execution status is separate from delivery status. File items expose an AgentSmith artifact ID only.

The interaction snapshot contains `items`, history and stream cursors, `historyStatus` (`complete` or `gap`), queued messages, `runState`, runtime reachability, last sync time, and server-calculated capabilities. Capabilities include `sendMessage`, `editQueuedMessage`, `abortTurn`, `openTerminal`, `releaseSandbox`, and `deleteTask`; clients must use them rather than infer actions from Task or Sandbox state.

Message mutations return a typed receipt: `messageId`, `disposition`, `targetTaskId`, duplicate flag, queued message or interaction when applicable, capabilities, and a safe error on failure. A message sent while the Sandbox is released atomically starts a new Run for the same Task, Botified session, and File Library before delivery. It never creates a successor Task. Repeated requests with the same idempotency key do not create duplicate messages or Runs.

The interaction SSE stream has one durable event: `interaction`. It carries a complete interaction item and an opaque cursor in `id`; clients upsert by `id + revision` and return the cursor without parsing it. All other frames are typed transient state: `state` carries only `queuedMessages` and `capabilities`, `run_state` carries `runState`, `connection` carries `connectionState`, `runtimeReachability`, `historyStatus`, `lastSyncedAt`, and a safe nullable message, and `preview_status` reports optional live-preview availability without changing the interaction connection state. The server emits each transient frame independently whenever its authoritative fields change.

`assistant_preview` and `assistant_preview_clear` update only the active temporary assistant surface. `reset` carries an authoritative interaction snapshot, `reconnect` asks the client to reconnect with its last durable cursor, and `done` is sent only after task deletion. The stream remains open through task terminal states, sends comment heartbeats, and has a finite connection lifetime. Every reconnect rechecks the OIDC session and task membership before durable catch-up resumes.

`POST .../turn/abort` stops only the current turn and does not release the Sandbox or stop detached work. `POST .../sandbox/release` fences later delivery to the current Run, unconditionally stops its agent, terminals, and processes, deletes only its app-owned Kubernetes resources, and settles that Run's Usage once. Conversation history and the bound File Library remain available. The next message or Terminal open starts a new Run without resuming work interrupted by the release. Both routes return server-authoritative state or capabilities; neither action is inferred by the Web client.
