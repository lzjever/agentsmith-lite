# API Semantics

Mutating routes require the session cookie and `x-csrf-token`; command routes that declare replay protection also require an `Idempotency-Key`. Task resources require project membership; there is no global control-plane API. The Web client uses only AgentSmith `/api/v1` routes and never calls Botified.

Project credential create and rotate requests accept a plaintext provider secret only for that write. The server encrypts it before storage and returns metadata, mask/fingerprint, and rotation information only. Endpoint create and update requests bind an existing project credential through `credentialId`. Endpoint `baseUrl` must be HTTPS and must not include credentials, query, or hash; it must normalize to the bound credential base URL. Public credential, endpoint, dashboard, and chat payloads never expose provider plaintext.

`GET /api/v1/workspaces` projects include the current user's nullable `pinnedAt`; it is never shared with other members. `PUT /api/v1/projects/{projectId}/pin` accepts `{ pinned: boolean }` and naturally idempotently sets that member's pin. Removing project membership removes the pin.

`POST /api/v1/projects/{projectId}/chat` accepts `{ endpointId, messages }`, where `messages` is an array of `{ role, content }` with role `system`, `user`, or `assistant`. The server verifies project access, loads the endpoint and its bound encrypted project credential, validates the normalized base URL binding, and decrypts the provider key only for the server-side OpenAI-compatible Chat Completions call. The response is `{ message, endpointSnapshot }`; `message` is the assistant message mapped from `choices[0].message.content`.

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
| `POST /api/v1/tasks/{taskId}/cancel` | Cancels the whole task and begins its scoped cleanup. |

An interaction has stable `id`, monotonic `revision`, `position`, `occurredAt`, and `updatedAt`. Its discriminated `kind` is one of `user_message`, `assistant_message`, `tool`, `background_task`, `task_question`, `task_notice`, `task_result`, `subagent_result`, `file`, `execution_boundary`, or `system_error`; each kind carries its typed status and controlled detail fields. Tool and work execution status is separate from delivery status. File items expose an AgentSmith artifact ID only.

The interaction snapshot contains `items`, history and stream cursors, `historyStatus` (`complete` or `gap`), queued messages, `runState`, runtime reachability, last sync time, and server-calculated capabilities. Capabilities are `sendMessage`, `editQueuedMessage`, `abortTurn`, `cancelTask`, `openTerminal`, and `deleteTask`; clients must use them rather than infer actions from task state.

Message mutations return a typed receipt: `messageId`, `disposition`, `targetTaskId`, duplicate flag, queued message or interaction when applicable, capabilities, and a safe error on failure. Dispositions are `accepted_by_active_run`, `queued_for_active_run`, `successor_pending`, `successor_created`, and `failed`. A terminal task may create a linked successor; the original task receives an `execution_boundary` rather than a fabricated continuation.

The interaction SSE stream has one durable event: `interaction`. It carries a complete interaction item and an opaque cursor in `id`; clients upsert by `id + revision` and return the cursor without parsing it. All other frames are typed transient state: `state` carries only `queuedMessages` and `capabilities`, `run_state` carries `runState`, and `connection` carries `connectionState`, `runtimeReachability`, `historyStatus`, `lastSyncedAt`, and a safe nullable message. The server emits each transient frame independently whenever its authoritative fields change.

`assistant_preview` and `assistant_preview_clear` update only the active temporary assistant surface. `reset` carries an authoritative interaction snapshot, `reconnect` asks the client to reconnect with its last durable cursor, and `done` is sent only after task deletion. The stream remains open through task terminal states, sends comment heartbeats, and has a finite connection lifetime. Every reconnect rechecks the OIDC session and task membership before durable catch-up resumes.

`POST .../turn/abort` does not cancel the task, stop detached work, or trigger cleanup. `POST .../cancel` fences later delivery, drains artifacts, and reaps only app-owned task resources. Both routes return server-authoritative state or capabilities; neither action is inferred by the Web client.
