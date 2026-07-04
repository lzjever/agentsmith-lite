# Botified Runtime

P0 Botified consumption is fixed as vendored source from pinned commit:

- pin file: `third_party/botified/PINNED_SOURCE.json`
- runtime entrypoint: `botified serve`

The app does not expose Botified's TUI as product runtime. The runner Dockerfile builds the vendored source and the entrypoint execs:

```bash
botified serve --config /etc/botified/botified-config.yaml
```

`packages/botified-runtime` owns:

- hardened config generation;
- pure timeline event projection;
- a small wrapper for starting `botified serve`;
- a runtime HTTP client adapter in `packages/ports`.

## Runtime Config Contract

`generateBotifiedConfig` emits the vendored Rust `RuntimeConfig` shape. The important compatibility points are:

- `version: 1`
- `providers` is an array, not a keyed object.
- `service.host` is `0.0.0.0` for the runner service and `service.service_key_env` names the per-task service-key environment variable.
- `runtime.cwd` points at the task home and `runtime.data_dir` points at the Botified state directory. `runtime.session` is the Lite task id.
- `registry.enabled`, `subagents.enabled`, `profiling.enabled`, and `llm_text_preview.enabled` are disabled for Lite runner use.
- `skills.default_discovery` is disabled; Lite supplies no product skill discovery in the runner.
- `bash` is enabled only in this sandbox runner config. `view_image` is enabled only when the configured model endpoint advertises both `text` and `image`.

The Rust config loader uses strict unknown-field rejection, so Lite must not emit legacy fields such as `providers.default` or `runtime.project_mount`.

## HTTP Client Contract

The Botified service exposes `/healthz` without auth. All Lite runtime control/data endpoints use the per-task service key:

- `POST /v1/messages`
- `GET /v1/timeline`
- `POST /v1/files`
- `POST /v1/abort`

The HTTP adapter sends `Authorization: Bearer <serviceKey>` to those endpoints and does not send it to `/healthz`.

Timeline responses are Botified NDJSON. Blank lines are heartbeat frames and are ignored by the adapter. A `410` response with `error.code = "stale_cursor"` is converted into a structured reset result after fetching `GET /v1/timeline?tail=1`, so callers can replace local timeline state instead of treating the cursor as a generic fatal error.

Non-2xx responses raise `BotifiedHttpError` with the HTTP status, Botified error code, retryability, timeline cursor when present, history boundary when present, and the original response body.

## Task Service Orchestration

P3 wires task creation to the Botified port without connecting to real Kubernetes or a real Botified network endpoint. `TaskService` generates a per-task service key, stores the server-only runtime state in the `sandbox_runtime_state` JSON document collection, creates the dry-run sandbox resources, sends the user prompt through the injected Botified client, and projects returned timeline frames into product task events/artifacts.

Timeline reads reuse the shared projection rules in `packages/botified-runtime`. Existing Botified sequence numbers are passed back into the projection so repeated reads are idempotent, and the latest cursor is stored in the runtime state for subsequent `GET /api/tasks/{taskId}/events` and `GET /api/tasks/{taskId}/artifacts` calls.

`POST /api/tasks/{taskId}/cancel` calls the Botified abort port with the stored service key before the task is marked `stopping`. Botified abort failures are returned from the task API as structured errors containing `code`, `message`, `retryable`, and cursor details when Botified supplies them.
