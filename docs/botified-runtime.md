# Botified Runtime

Botified consumption is fixed as vendored server source from upstream stable `v0.4.37`
commit `3cb852daae060faa6e26cc538f6c12d940d89ed5`, plus the narrow Lite runtime
extensions recorded in the pin:

- pin file: `third_party/botified/PINNED_SOURCE.json`
- runtime entrypoint: `botified serve`

AgentSmith server uses Botified exclusively through its service API. The runner Dockerfile builds the vendored service runtime and the entrypoint execs:

```bash
botified serve --config /etc/botified/botified-config.yaml
```

Only the server runtime is vendored. TUI modules, TUI/bin targets, setup commands,
and unrelated optional components are not part of the runner. There is no stock
binary fallback.

AgentSmith owns the `bash-executor` sidecar and its loopback NDJSON protocol.
`tools.execution.bash_executor_addr` is loopback-only, and the Lite runner always
configures it. Botified sends explicitly typed `tool` and `terminal` requests.
Tool execution uses piped output and only pipes stdin when interactive stdio is
present; terminal execution alone uses a PTY. Botified retains the v0.4.37 Bash
credential filtering, bounded output accounting, cancellation, process-reaping,
and detached-task semantics around that external execution boundary.

`packages/botified-runtime` owns:

- hardened config generation;
- timeline ingestion for the application interaction projector;
- a small wrapper for starting `botified serve`;
- a runtime HTTP client adapter in `packages/ports`.

## Runtime Config Contract

`generateBotifiedConfig` emits the vendored Rust `RuntimeConfig` shape. The important compatibility points are:

- `version: 1`
- `providers` is an array, not a keyed object.
- Provider entries use `api_compat: standard`. Lite does not emit legacy CA,
  thinking-shape, or provider alias fields.
- Provider `base_url` normally requires HTTPS. Plain HTTP is accepted only for a
  literal loopback IP or the exact AgentSmith API service form
  `agentsmith-lite-api.<namespace>.svc.cluster.local[:port]`; other plaintext
  hosts remain invalid.
- `service.host` is `0.0.0.0` for the runner service and `service.service_key_env` names the per-task service-key environment variable.
- `runtime.cwd` points at the task home and `runtime.data_dir` points at the Botified state directory. `runtime.session` is the Lite task id.
- `runtime.resume_unfinished` is `true` for first start and same-Run recovery. The first start after an explicit Sandbox release sets it to `false`, which durably discards queued input, the interrupted request boundary, its deduplication cursors, and pending callback delivery intents before the service accepts requests while retaining completed session history.
- `registry.enabled`, `subagents.enabled`, and `profiling.enabled` are disabled for Lite runner use. `llm_text_preview.enabled` is enabled for transient server-relayed assistant previews.
- `skills.default_discovery` is disabled; Lite supplies no product skill discovery in the runner.
- `bash` is enabled only in this sandbox runner config. `view_image` is enabled only when the configured model endpoint advertises both `text` and `image`.

The Rust config loader uses strict unknown-field rejection. Lite does not emit
removed fields such as top-level `compact`, `subagents.model_aliases`,
`ca_bundle_path`, `providers.default`, or `runtime.project_mount`.

## HTTP Client Contract

The Botified service exposes `/healthz` without auth. All Lite runtime control/data endpoints use the per-task service key:

- `POST /v1/messages`
- `GET /v1/deliveries/{deliveryKey}`
- `GET /v1/timeline`
- `GET /v1/state`
- `POST /v1/files`
- `POST /v1/abort`
- `POST /v1/background-tasks/{taskId}/stop`
- `GET /v1/terminal/ws` (WebSocket upgrade)
- `GET /v1/llm-text-preview`

The HTTP adapter sends `Authorization: Bearer <serviceKey>` to those endpoints and does not send it to `/healthz`.

AgentSmith message delivery supplies `delivery_key` and `request_hash`.
Botified records that identity on the canonical durable accepted-input session
event, rebuilds its bounded message index during session replay, returns the
existing receipt for the same key/hash, rejects reuse with a different hash, and
serves receipt reconciliation through `GET /v1/deliveries/{deliveryKey}`. Receipt
lifetime follows the existing accepted-message replay window and session
lifecycle; receipts are not stored in the File Library.

The terminal WebSocket is a thin authenticated proxy to the configured
loopback `bash-executor`. It starts `exec bash -il` in the task working
directory and forwards executor NDJSON frames without adding a CLI or TUI path.
Background stop is likewise a thin authenticated route over v0.4.37's internal
task cancellation capability.

Timeline responses are Botified NDJSON. Blank lines are heartbeat frames and are ignored by the adapter. A stale cursor is represented as a structured history gap. `TaskService` recovers canonical history by paging from a history boundary, then forward to the current cursor; when an earlier boundary cannot be recovered it persists and exposes `historyStatus: "gap"` rather than resetting to a tail page.

Non-2xx responses raise `BotifiedHttpError` with the HTTP status, Botified error code, retryability, timeline cursor when present, history boundary when present, and the original response body. Product-facing task errors redact secret-like text such as Botified service keys, OpenAI-compatible API keys, and bearer tokens before returning the message.

## Task Service Orchestration

P3 wires task creation to the Botified port. By default this remains local-development friendly: `TaskService` creates redacted dry-run sandbox resources and sends the user prompt through the injected Botified client without resolving model credentials or talking to Kubernetes.

When live sandbox mode is explicitly configured, `TaskService` resolves the endpoint's OpenAI-compatible credential binding, checks the normalized credential base URL against the endpoint base URL, persists non-secret sandbox run state, materializes the per-task Secret and Botified config in memory, applies the six fenced Kubernetes resources, waits for the Pod readiness probe with a bounded poll loop, and only then posts the prompt. Startup failures before prompt submission mark the Run `failed`, persist its release intent, and trigger one scoped resource-removal pass.

`TaskService` derives the per-task service key from the server session secret plus task/run identity. Live startup requires `APP_SESSION_SECRET` to be explicitly set to a non-default value; the development fallback is refused in live mode. The key is never written to ProductStore, task JSON, interaction changes, artifacts, or docs. It exists only in memory for Botified HTTP calls and, in live mode, in the Kubernetes Secret apply body.

The `sandbox_runtime_state` JSON document stores only non-secret runtime metadata: Botified base URL, one timeline resume cursor, and sync timestamps. The `sandbox_run_state` JSON document stores resource identity, phase, cleanup status, and non-secret runtime paths. The model API key is not stored in task JSON, interaction changes, artifacts, runtime docs, run state, or ConfigMaps; it is only materialized into the live Secret apply body.

When `sandbox_runtime_state` is missing, `TaskService` rebuilds the non-secret Botified base URL from sandbox run metadata, reads `GET /v1/state`, stores only the safe `timeline_cursor`, and resumes timeline sync from that cursor.

Botified history is canonical input, not a browser contract. The application projector turns timeline and product-message sources into typed interactions, persists each revision with correlation and source-cursor state in `task_interaction_changes`, and redacts secret-like field names and values before they become product data. Botified `/v1/timeline` envelopes use `data`; existing sequence numbers and source identity make repeated reads idempotent. A safe delivery or state cursor seeds later sync; secret-like or missing cursors are ignored.

`GET /v1/llm-text-preview` is an authenticated Botified SSE source for a current assistant draft. AgentSmith relays its filtered text as transient task-conversation SSE and never treats it as durable interaction history. Final timeline messages remain authoritative.

`POST /api/v1/tasks/{taskId}/turn/abort` derives the service key and calls Botified abort only for the current turn; it does not release the Sandbox or stop detached work. `POST /api/v1/tasks/{taskId}/sandbox/release` is the only current-Run release path: after user confirmation it fences delivery and removes that Run's app-owned Kubernetes resources unconditionally. A later message or Terminal open starts a new Run with the same `runtime.session` and data directory but with `runtime.resume_unfinished: false`, so completed history remains and interrupted or queued work from the released Run does not resume. Background work stops through its typed interaction and Botified background-task endpoint. Botified errors are returned as structured errors containing `code`, redacted `message`, retryability, and cursor details when available.
