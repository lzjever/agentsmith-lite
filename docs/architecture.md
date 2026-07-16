# Architecture

AgentSmith Lite is a product API and Web client for the local single-node Kubernetes loop. The Node server owns authorization, projects, endpoints, tasks, task conversations, artifacts, and sandbox lifecycle. The Web UI is a presentation client: it does not call model providers, Botified, Kubernetes, databases, object storage, or filesystem APIs directly.

Postgres is the product store when `POSTGRES_APP_URL` is set; only local dry-run and tests may use the in-memory fallback. SQL migrations live in `infra/db/migrations/*.sql`. Sandbox lifecycle uses app-owned labels, task/run identity, and resource UID fences, so cancel, TTL, and reap affect only the matching task resources.

## Task Conversations

The application projector is the single conversation read-model owner. It reads canonical Botified history and product message state, redacts display text, correlates stable Botified identities, and upserts typed `TaskInteractionItem` revisions. The Web receives only the projected interaction snapshot, message receipts, capabilities, and SSE changes; it does not parse NDJSON, merge lifecycle events, or infer business state.

`task_interaction_changes` is the durable interaction log. Each mutation atomically persists interaction revisions, correlation fields, source cursor/history state, and any task lifecycle update. Source identity and interaction revision uniqueness make repeated timeline reads idempotent and preserve in-place updates through process recovery.

Botified history is the canonical input. The server resumes from a safe source cursor, recovers complete history by paging backward then forward when needed, and records `historyStatus: gap` when an earlier boundary is unavailable. A gap is surfaced to the client; it is never hidden by a tail-only reset or by advancing a cursor past unavailable history.

The runtime config enables Botified LLM text preview. The server relays it as transient `assistant_preview` SSE for the active assistant interaction and does not persist it as final conversation truth. Completed timeline interactions replace the preview. Preview loss affects only the live display, not timeline recovery.

`abortTurn` is a current-turn operation through Botified and leaves the task and detached work alive. Task cancellation is a separate task-lifecycle operation: it fences delivery, drains artifacts, and starts scoped cleanup. Stoppable background work is also a typed interaction operation, not a task cancellation.

## Secrets

The server decrypts a project-scoped provider credential only for its OpenAI-compatible request. Botified receives task-scoped access only; the browser never receives provider credentials or Botified service keys. Per-task service keys are derived from server secret and task/run identity, held in memory for service calls, and placed only in the live Kubernetes Secret apply body. Runtime and run-state records contain non-secret metadata only.

Interaction projection redacts secret-like fields and values, including bearer tokens, service keys, provider keys, and task-known credential values. Raw Botified payloads, internal file URLs and paths, Kubernetes Secrets, session tokens, and provider credentials are not public task-conversation data.
