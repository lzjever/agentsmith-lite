# Botified Operations Manual

This manual is for running Botified as a small, headless HTTP agent service in a
local or controlled network environment.

The goal is simple operation. This manual is not a release-process replacement;
use the README and Makefile gates for release validation. Botified does not
include fleet management, multi-tenant auth, approval workflows, or a sandbox.

## 1. Scope

Botified runs as one process:

- One HTTP service.
- One active agent loop at a time.
- One optional named session per process.
- One provider router over OpenAI Chat Completions-compatible endpoints.
- Built-in tools configured from YAML: `bash` and `view_image`.

It is suitable for development, demos, and robot-side integration behind a
trusted control plane. Treat it as a powerful local executor when `bash` is
enabled.

Integration boundaries:

- Botified core is the resident HTTP agent service and TUI.
- Gateway or playground components are external integrations; they are not part
  of the core service contract or core release bundle.
- Public release staging happens outside this repo; this repo builds and checks
  the core bundles.
- Core install and startup do not require Node or npm; Node checks belong to the
  separately installed gateway companion.

## 2. Start Modes

Startup is config-first:

```text
botified serve [--config PATH] [--mock-provider]
```

If the selected config file is missing, Botified writes a default example to
that path and exits before binding. The default path is `./botified.yaml`.

Local mock mode with the generated default config:

```bash
botified serve --mock-provider
export BOTIFIED_SERVICE_KEY=dev
botified serve --mock-provider
```

Custom config path:

```bash
botified serve --config robot.yaml
```

Real provider mode:

```bash
export BOTIFIED_TEXT_API_KEY=...
export BOTIFIED_VISION_API_KEY=...
export BOTIFIED_SERVICE_KEY=change-me
botified serve --config botified.yaml
```

Remote bind with HTTP entry protection is YAML configuration:

```yaml
service:
  host: 0.0.0.0
  port: 17777
  service_key_env: BOTIFIED_SERVICE_KEY
  max_queue_messages: 32
  max_queue_bytes: 33554432
```

If configured built-ins in `tools.enabled` are enabled and `service.host` is not
loopback or localhost, Botified refuses to start unless
`service.service_key_env` is configured.

No built-in `bash` or `view_image` tools:

```yaml
tools:
  enabled: []
```

This does not remove service control tools such as `publish_file` or
`task_list`; it only disables the YAML-controlled built-ins.

AGENTS instruction loading is enabled by default:

```yaml
runtime:
  cwd: /path/to/project

context_files:
  enabled: true
  max_total_bytes: 32768
```

Disable AGENTS loading:

```yaml
context_files:
  enabled: false
  max_total_bytes: 32768
```

## 3. CLI Reference

Usage:

```text
botified serve [--config PATH] [--mock-provider]
```

Options:

| Flag | Meaning |
| --- | --- |
| `--config PATH` | Select the runtime YAML file. Defaults to `./botified.yaml`. |
| `--mock-provider` | Replace configured endpoints with the local development mock provider. Service, runtime, tools, sessions, skills, and context files still come from YAML. |

Old runtime and provider startup flags are rejected. Configure non-secret
settings in YAML.

## 4. Runtime Config

Runtime settings live in these YAML sections:

| Section | Fields | Meaning |
| --- | --- | --- |
| `version` | `1` | Config format version. |
| `providers[]` | `name`, `base_url`, `model`, `api_key_env`, `request_timeout_secs`, `priority`, `capabilities`, `thinking` | OpenAI-compatible endpoint definitions. |
| `tools` | `enabled`, `execution` | Built-in tools: `bash`, `view_image`, or an empty list, plus optional tools.execution policy. |
| `service` | `host`, `port`, `service_key_env`, `max_queue_messages`, `max_queue_bytes` | HTTP bind, bearer token env name, and waiting queue limits. |
| `registry` | `enabled`, TTL, retention, topic/value/query/frame limits | Short-term high-frequency state registry. |
| `runtime` | `cwd`, `data_dir`, `session` | Agent working directory, state directory, and optional session name. |
| `timeline` | `retention_days` | Durable timeline history retention. |
| `files` | `root_dir`, size/count limits, retention | Upload and published-file storage limits. |
| `skills` | `default_discovery`, `explicit` | Local skill discovery and explicit skill names or paths. |
| `context_files` | `enabled`, `max_total_bytes` | Project AGENTS instruction loading and raw byte budget. |
| `subagents` | `enabled`, `max_parallel`, `max_branches`, `model_aliases` | One-level subagent/team support and optional model aliases. |
| `compact` | `enabled`, `threshold_tokens`, `keep_recent_tokens` | Automatic context compaction controls. |
| `profiling` | `enabled`, `output_dir`, `run_label` | Optional server-side CSV timing/profiling reports. |
| `llm_text_preview` | `enabled` | Optional side-channel live text preview for clients. |

Credentials live only in environment variables named by `api_key_env` and
`service_key_env`. Do not put raw keys in YAML, and do not move ordinary runtime
configuration into environment variables.

The complete default config is generated by `botified serve [--config PATH]`
when the file is missing. This is an abridged operations example that keeps the
generated defaults that matter for operations:

```yaml
version: 1

providers:
  - name: text-main
    base_url: https://text-provider.example/v1
    model: text-tool-model
    api_key_env: BOTIFIED_TEXT_API_KEY
    request_timeout_secs: 60
    priority: 10
    capabilities: [text, tool_calls]
    thinking:
      format: none
      level: off
      level_map: {}
      budget_tokens: null

  - name: vision-main
    base_url: https://vision-provider.example/v1
    model: vision-model
    api_key_env: BOTIFIED_VISION_API_KEY
    request_timeout_secs: 60
    priority: 20
    capabilities: [text, image]
    thinking:
      format: qwen
      level: off
      level_map: {}
      budget_tokens: null

  - name: reasoning-main
    base_url: https://reasoning-provider.example/v1
    model: reasoning-model
    api_key_env: BOTIFIED_REASONING_API_KEY
    request_timeout_secs: 120
    priority: 30
    capabilities: [text, tool_calls]
    thinking:
      format: deepseek
      level: high
      level_map:
        minimal: null
        low: null
        medium: high
        high: high
        xhigh: max
      budget_tokens: null

tools:
  enabled: [bash, view_image]
  execution:
    default_detach_after_secs: 1.0
    max_detach_after_secs: 10.0
    default_timeout_secs: 120.0
    max_timeout_secs: 1800.0
    max_concurrent_tasks: 4
    callback_output_tail_bytes: 8192
    max_task_output_bytes: 16777216
    max_task_ask_pending_secs: 300.0
    max_retained_tasks: 128
    task_retention_secs: 86400

service:
  host: 127.0.0.1
  port: 17777
  service_key_env: BOTIFIED_SERVICE_KEY
  max_queue_messages: 32
  max_queue_bytes: 33554432

registry:
  enabled: true
  retention_secs: 300
  default_ttl_secs: 5
  max_topics: 4096
  max_topic_len: 256
  max_source_len: 128
  max_value_bytes: 8192
  max_history_items: 20000
  max_history_bytes: 67108864
  default_query_limit: 100
  max_query_limit: 1000
  max_response_bytes: 262144
  websocket_max_frame_bytes: 65536

runtime:
  cwd: .
  data_dir: .botified/state
  session: null

timeline:
  retention_days: 14

files:
  root_dir: files
  max_file_bytes: 52428800
  max_upload_files: 16
  max_upload_request_bytes: 104857600
  max_message_files: 16
  max_message_referenced_file_bytes: 104857600
  max_store_bytes: 1073741824
  retention_secs: 604800

skills:
  default_discovery: true
  explicit: []

context_files:
  enabled: true
  max_total_bytes: 32768

subagents:
  enabled: true
  max_parallel: 3
  max_branches: 32
  model_aliases: {}

compact:
  enabled: true
  threshold_tokens: 1000000
  keep_recent_tokens: 32000

profiling:
  enabled: false
  output_dir: null
  run_label: null

llm_text_preview:
  enabled: false
```

Omitted `tools.execution` fields use built-in defaults.
`session: null` means ephemeral service state with no session file. `/v1/state`
reports `session_id: "thread_local"` in that mode. Set a non-empty
`runtime.session` to resume state across restarts.
The generated config sets `subagents.enabled: true`; if the `subagents` section
is omitted entirely, the implementation default is disabled.
The generated config sets `registry.enabled: true`. When
`registry.enabled: false`, `/v1/registry/*` routes return `404`, registry tools
are not advertised to main agents or subagents, and registry prompt guidance is
not injected.
Registry state is in-memory short-term state; a service restart creates a new
`registry.instance_id` and starts empty.

Path resolution:

- `--config PATH` is resolved from the directory where `botified serve` starts.
- Relative `runtime.cwd` is resolved from the config file's directory.
- Relative `runtime.data_dir` is resolved from `runtime.cwd`.
- Relative `files.root_dir` is resolved from `runtime.data_dir`.
- Relative `profiling.output_dir` is resolved from `runtime.data_dir`.

Validation fails fast for missing provider fields, missing or empty credential
env vars, duplicate provider names, unknown tools or capabilities, invalid
thinking config, invalid `files.*` or `registry.*` limits, non-loopback tools or
enabled registry without service key configuration, and `view_image` without a
`[text, image]` endpoint.

Registry config defaults:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enables WebSocket registry read/write, read-only HTTP debug routes, agent tools, and prompt guidance. |
| `retention_secs` | `300` | Maximum retained history window and maximum effective TTL. |
| `default_ttl_secs` | `5` | TTL used when a write omits `ttl_secs`. Must be <= `retention_secs`. |
| `max_topics` | `4096` | Maximum active current topics before expired topics are pruned. |
| `max_topic_len` | `256` | Maximum topic or topic pattern length. |
| `max_source_len` | `128` | Maximum trimmed `source` length. |
| `max_value_bytes` | `8192` | Maximum JSON-encoded value size per write. |
| `max_history_items` | `20000` | Retained history sample cap. Oldest samples are pruned first. |
| `max_history_bytes` | `67108864` | Retained history byte cap. Oldest samples are pruned first. |
| `default_query_limit` | `100` | Limit used when a query omits `limit`. |
| `max_query_limit` | `1000` | Largest accepted `limit`. |
| `max_response_bytes` | `262144` | Response cap; items are truncated on item boundaries. |
| `websocket_max_frame_bytes` | `65536` | Maximum WebSocket text frame size. |

If `service.host` is non-loopback and registry is enabled, configure
`service.service_key_env`. The same bearer token protects registry HTTP reads
and WebSocket upgrades.

### Profiling

Profiling is off by default. Enable it only when you need server-side timing and
token/task CSVs:

```yaml
profiling:
  enabled: true
  output_dir: null
  run_label: robot-demo
```

With `output_dir: null`, reports are written under
`<runtime.data_dir>/profiling/<timestamp>_<pid>_<run_label>/`. A relative
`profiling.output_dir` is resolved from `runtime.data_dir`; an absolute path is
used as-is. Each run writes `events.csv` and `summary.csv`. CSV rows contain
timing and counters, not raw provider payloads.

## 5. Provider Routing And Thinking

Provider endpoints declare capabilities from:

- `text`
- `image`
- `tool_calls`

For each provider request, the router computes the required capabilities and
selects one endpoint that supports all of them. The lowest numeric `priority`
wins. Config order breaks ties. Botified does not split a single request across
providers.

Common capability requirements:

| Request | Required capabilities |
| --- | --- |
| Main request with no tools available to the main agent | `[text]` |
| Main request when any main-agent tool is available | `[text, tool_calls]` |
| Main request with file refs and any main-agent tool available | `[text, tool_calls]` |
| `view_image` internal vision request | `[text, image]` |

Uploaded file refs are metadata-only manifests in the main request. They do not
require provider image capability and are not automatically read or forwarded as
provider media.

Because Botified injects service control tools such as `publish_file` and
`task_list` independently of `tools.enabled`, a main request usually still needs
one provider endpoint with `[text, tool_calls]` even when `tools.enabled: []`.

Thinking config belongs to the selected endpoint and does not affect routing.
Supported formats are `none`, `openai`, `deepseek`, `qwen`, and `glm`.
Supported levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
`budget_tokens` is valid only for `qwen`.

Raw reasoning or thinking text is not part of the public event or tool output
contract.

## 6. HTTP API

Examples in this section use:

```bash
BASE=http://127.0.0.1:17777
AUTH='Authorization: Bearer dev'
```

`GET /healthz`

- Public.
- Returns `{"ok":true}`.
- Does not verify provider, model, tools, or session health.

`GET /v1/state`

```bash
curl -s "$BASE/v1/state" -H "$AUTH"
```

Abridged response with diagnostic fields:

```json
{
  "state": "idle",
  "queue_length": 0,
  "tasks": {
    "running": 0,
    "cancelling": 0,
    "pending_callbacks": 0,
    "pending_asks": 0
  },
  "timeline_cursor": "evt_p7k3_0",
  "timeline_seq": 0,
  "session_id": "thread_local",
  "last_error": null,
  "timeline": {
    "endpoint": "/v1/timeline",
    "version": "botified.timeline.v1",
    "retention": {
      "kind": "durable_file",
      "retention_days": 14,
      "hot_event_capacity": 1024,
      "earliest_seq": 0,
      "earliest_cursor": "evt_p7k3_0",
      "latest_seq": 0,
      "latest_cursor": "evt_p7k3_0"
    },
    "capabilities": {
      "timeline_live_follow": true,
      "durable_timeline_read": true,
      "history_pagination": true,
      "incremental_output": true
    }
  },
  "registry": {
    "enabled": true,
    "endpoint": "/v1/registry/ws",
    "current_endpoint": "/v1/registry/current",
    "history_endpoint": "/v1/registry/history",
    "topics_endpoint": "/v1/registry/topics",
    "instance_id": "reg_abc123",
    "retention_secs": 300,
    "default_ttl_secs": 5,
    "max_topics": 4096,
    "max_value_bytes": 8192,
    "max_query_limit": 1000,
    "max_response_bytes": 262144,
    "websocket_max_frame_bytes": 65536,
    "latest_seq": 0,
    "capabilities": {
      "set": true,
      "get": true,
      "history": true,
      "topics": true,
      "wildcard": true,
      "http_read": true,
      "subscribe": false
    }
  },
  "providers": [
    {
      "profile": "text-main",
      "name": "text-main",
      "model": "text-tool-model",
      "capabilities": ["text", "tool_calls"]
    }
  ],
  "active_items": [
    {
      "id": "service",
      "type": "service_status",
      "status": "idle",
      "data": { "state": "idle", "queue_length": 0 }
    },
    {
      "id": "queue",
      "type": "queue_state",
      "status": "ready",
      "data": { "queue_length": 0 }
    }
  ],
  "active_items_omitted": {
    "omitted_count": 0,
    "by_type": {}
  }
}
```

State responses use `session_id` for the configured session name and
`timeline_cursor` for timeline bootstrap. Timeline history is stored as a
durable file-backed log under `runtime.data_dir`; the default retained window is
14 days. Registry state is separate in-memory short-term state; `instance_id`
changes after restart. `providers`, `active_items`, and `active_items_omitted`
are diagnostic fields used by clients such as the TUI; they are useful for
checking active provider metadata, queued inputs, background tasks, pending task
asks, and active subagents.

`POST /v1/messages`

```bash
curl -s -X POST "$BASE/v1/messages" \
  -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"client_message_id":"op-1","text":"Check current state."}'
```

Accepted body shapes:

```json
{ "text": "non-empty text" }
```

```json
{
  "urgency": "normal",
  "items": [
    { "type": "text", "text": "Describe this uploaded file." },
    { "type": "file", "file_id": "file_0123456789abcdef0123456789abcdef" }
  ]
}
```

File refs must come from `POST /v1/files` or from a previous
`file.published` event. `/v1/messages` does not accept multipart bodies or file
bytes. File contents are not automatically read by Botified; the agent only
uses `view_image`, `bash`, or another available tool when the user request
requires reading the internal file path from the manifest.

`POST /v1/files`

```bash
UPLOAD=$(curl -s -X POST "$BASE/v1/files" \
  -H "$AUTH" \
  -F 'file=@image.png;type=image/png')
FILE_ID=$(printf '%s' "$UPLOAD" | jq -r '.files[0].file_id')
```

Response:

```json
{
  "ok": true,
  "files": [
    {
      "file_id": "file_0123456789abcdef0123456789abcdef",
      "filename": "image.png",
      "mime_type": "image/png",
      "size_bytes": 1234,
      "sha256": "hex-encoded-sha256",
      "download_url": "/v1/files/file_0123456789abcdef0123456789abcdef",
      "source": "upload",
      "description": null
    }
  ]
}
```

`GET /v1/files/{file_id}`

```bash
curl -s -L "$BASE/v1/files/$FILE_ID" \
  -H "$AUTH" \
  -o downloaded-image.png
```

The same download endpoint is used for files published by the agent. Operators
discover those from timeline events with `type: "file.published"` and
`data.download_url`.

Ordinary user messages may include `urgency: "normal"` or `urgency: "urgent"`;
omitted means `normal`. Urgency is a server-side scheduling hint: clients may
submit and display it, but Botified owns the scheduling behavior. Accepted urgent
input asks Botified to abort the current agent turn at the next safe boundary and
prioritize the urgent input in the next drain. In the TUI, `Alt+Enter` submits an
urgent user message. It is not a robot emergency stop, does not cancel detached
background tasks, and remains bounded by queue limits, pending limits, request
timeouts, and provider/tool cancellation behavior. Service slash commands do not
use urgency; if a command request body includes `urgency`, the command semantics
are unchanged.

Messages return `kind: input_accepted`, `kind: input_queued`, or
`kind: input_duplicate` with `input_id`, `message_id`, `timeline_cursor`,
`queue_length`, and service `state`. These responses do not include a generic
`cursor` field. Append-safe rejections include `timeline_cursor` for the
`input.rejected` timeline event. If a rejection cannot safely append, the
response omits `timeline_cursor`; operators should call `GET /v1/state` or keep
the previous confirmed cursor.

Task slash commands sent through `POST /v1/messages`, including `/tasks`,
`/task <id>`, and `/task stop <id>`, are intercepted and return command
responses without `cursor` or `timeline_cursor`. Interactive task asks are
normally answered by the agent with `task_reply(task_id, ask_id, message)`. If
the agent needs human judgment, it asks through ordinary chat and then replies
to the task. Do not use slash commands to answer interactive asks in normal
operation.

`GET /v1/timeline`

```bash
curl -s "$BASE/v1/state" -H "$AUTH" \
  | jq '{state, queue_length, tasks, last_error, session_id, timeline_cursor}'
CURSOR=$(curl -s -X POST "$BASE/v1/messages" \
  -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"client_message_id":"op-events-1","text":"Check current state."}' \
  | jq -r .timeline_cursor)
curl -s -D headers.txt "$BASE/v1/timeline?cursor=$CURSOR&follow=false" -H "$AUTH"
NEXT=$(awk 'BEGIN { IGNORECASE=1 } /^x-botified-next-cursor:/ { print $2 }' headers.txt | tr -d '\r')
curl -N "$BASE/v1/timeline?cursor=$NEXT&follow=true" -H "$AUTH"
```

Response is Botified Timeline JSONL v1 (`botified.timeline.v1`) as
`application/x-ndjson`. Omitting `direction` is the forward polling path:
`follow=false` returns a finite retained snapshot after the cursor and includes
`x-botified-next-cursor` plus `x-botified-has-more-after`; save the next cursor
from `headers.txt` for polling. `limit` is optional for forward polling, defaults
to 200, and is capped at 1000. `follow=true` replays retained backlog after the
supplied cursor and then tails live timeline events. The history is durable, but
the live HTTP stream is not a checkpoint and does not return
`x-botified-next-cursor`. While idle, `follow=true` may emit blank keepalive
lines. Clients must skip blank or whitespace-only lines before parsing JSON;
blank lines are not timeline events and do not carry cursors.
The timeline remains the public fact stream. Optional
`GET /v1/llm-text-preview` is a default-off, live-only SSE side channel for
draft LLM text; it has no cursor or replay and is not written to timeline or
session files.

Recent history can be loaded without a starting cursor:

```bash
curl -s -D headers.txt "$BASE/v1/timeline?tail=200" -H "$AUTH"
```

`tail=N` returns the newest retained events in ascending sequence order and does
not combine with `cursor`, `follow`, `direction`, or `limit`. To page older
history, use a page start cursor from a previous tail or backward response:

```bash
curl -s -D headers.txt "$BASE/v1/timeline?cursor=$PAGE_START&direction=backward&follow=false&limit=200" -H "$AUTH"
```

Tail and backward responses include `x-botified-page-start-cursor`,
`x-botified-page-end-cursor`, `x-botified-has-more-before`, and
`x-botified-history-boundary` (`none`, `start`, or `expired`). Backward response
bodies are still ordered oldest to newest.

Timeline cursor operational contract:

- Bootstrap from `GET /v1/state`; do not synthesize a starting cursor.
- `timeline_cursor` is the only public bootstrap and message-write response
  cursor.
- Missing, malformed, or non-`evt_` cursors return `400 invalid_request`.
- `410 stale_cursor` means a well-formed cursor cannot be served because its
  instance is unknown, its sequence is future or missing, or the boundary
  expired out of the retained window.
- After any `410 stale_cursor`, call `GET /v1/state` and use the returned
  `timeline_cursor`.

Optional LLM text preview operational check:

```bash
curl -s -i "$BASE/v1/llm-text-preview" -H "$AUTH"
curl -N "$BASE/v1/llm-text-preview?input_id=op-preview-1" -H "$AUTH"
curl -s -i "$BASE/v1/llm-text-preview?cursor=$CURSOR" -H "$AUTH"
curl -s -i "$BASE/v1/llm-text-preview" -H "$AUTH" -H 'Last-Event-ID: 1'
```

The default config has `llm_text_preview.enabled: false`; the first command
should return `409 preview_disabled`. When enabled, the `curl -N` command tails
live SSE draft text only. Query parameters are filters, not cursors:
`provider_request_id`, `cycle_id`, and `input_id` are allowed; `cursor`, `seq`,
`follow`, `replay`, and `since` return `400 invalid_request`. `input_id`
matches frames whose `input_ids` include that id. `Last-Event-ID` returns
`400 unsupported_last_event_id` because preview has no resume or replay
contract. Operators should continue to use `/v1/timeline` for facts, audit, and
cursor recovery.

### Task Conversation Observer Operations

`task_observe` is a main-agent tool for authorizing a running interactive task
as a read-only conversation sidecar. Successful delivery uses task stdin frames:

```text
<botified>{"op":"observe",...}</botified>
```

The observer feed is best-effort. It is not an HTTP API, not `/v1/timeline`,
not a session log, not `task_send`, not an audit stream, and not replayable. It
observes only future text after `task_observe` succeeds. Observe delivery itself
does not append timeline events, session entries, provider context, tool
results, active items, or `task_send.*` events. Observe has no ack or reply
contract. Each observed task has a bounded observe delivery queue with room for
32 pending observe frames. That queue is only an internal delivery buffer, not a
reliable log, timeline, session, or replay API. The `task_observe` tool call
lifecycle still records bounded
`task_observe.enabled`, `task_observe.disabled`, or `task_observe.failed`
service events.

Modes and common failures:

| Mode | Expected behavior | Common failure |
| --- | --- | --- |
| `final` | Sends future text-only external user text and assistant final text. | No frames for old messages, non-text inputs, tool results, task ask/tell, or subagent internals. |
| `stream` | Sends assistant draft started/delta/done/error from the preview source. | Requires `llm_text_preview.enabled: true`; otherwise the tool returns `preview_disabled` and no observer is enabled. |

Sidecar stdin handling should drain continuously and quickly, demuxing
`reply/send/registry_snapshot/registry_error/observe` before handing work to
the module. TTS, rendering, model calls, file processing, and other heavy work
belong in the sidecar's own queue/worker. An observe frame is a read-only
notification: sidecars should not reply, ack, convert it to a send command, or
treat it as a task ask/control frame. Business modules that are not sidecars can
ignore it.

If a sidecar is slow, exits, closes stdin, or its observe queue fills, Botified
cleans up that observer and stops delivering later observe frames to it. The
agent loop and provider request continue without waiting on that sidecar.
Internal diagnostics use the `task_observer` domain with bounded codes such as
`observer_write_failed`, `observer_queue_full`, or `observer_queue_closed`.
There is no operator action to replay missed observe frames; use timeline for
durable recovery and restart or re-enable the sidecar for future frames.

### Registry HTTP Debug

Registry is a short-term high-frequency state surface. It is not timeline,
session state, task state, a control protocol, or a message bus. Registry
updates are pull-only: they do not wake the agent and are not automatically
inserted into context.

Modules should use the WebSocket endpoint `/v1/registry/ws` for registry
read/write. The HTTP endpoints below are read-only operator/debug helpers for
curl and dashboards:

```bash
curl -s "$BASE/v1/registry/current?topic=robot.**&limit=10" -H "$AUTH"
curl -s "$BASE/v1/registry/history?topic=robot.pose&since_secs=60&limit=20" -H "$AUTH"
curl -s "$BASE/v1/registry/topics?topic=**&limit=100" -H "$AUTH"
```

There is no HTTP set route. `POST /v1/registry/set` is not part of the API.

WebSocket clients send text JSON frames:

```json
{ "op": "set", "id": "pose-1", "topic": "robot.pose", "value": { "x": 1, "y": 2 }, "source": "localization", "ttl_secs": 5, "freq_hz": 20 }
```

```json
{ "op": "get", "id": "read-robot", "topic": "robot.**", "limit": 10 }
```

```json
{ "op": "history", "id": "pose-history", "topic": "robot.pose", "since_secs": 60, "limit": 20 }
```

Topic names are dot-separated literal segments such as `robot.pose` or
`remote.joystick.left`; segments may contain ASCII letters, digits, `_`, and
`-`. Query patterns allow `*` for one segment and `**` only as the final segment
for the rest of the topic. Prefer specific patterns; use `**` for explicit
debugging.

Current state is last-writer-wins per topic. `history` is a lossy recent sample
window, not an event queue. Omitted `ttl_secs` uses `default_ttl_secs`; explicit
TTL is clipped to `retention_secs`. `value: null` is a valid JSON state value,
not delete. `ttl_secs: null` is invalid, and there is no reset/delete operation;
write a replacement value, wait for expiry, or restart the service for a fresh
registry instance.

Each item records `source`, `writer_kind`, and `origin`. `source` is a producer
label supplied by the writer. `writer_kind` and `origin` are assigned by
Botified, for example `websocket_client` with `ws:conn_1`, `main_agent` with
`main_agent`, or `subagent` with `subagent:<id>`. Topic naming is a producer
convention, not an ownership or ACL mechanism.

`POST /v1/abort`

```bash
curl -s -X POST "$BASE/v1/abort" -H "$AUTH"
```

Abort is a control-plane endpoint. It requests cancellation of the active run
and returns status fields such as `ok`, `state`, and `queue_length`; it does not
return `cursor` or `timeline_cursor`, and it does not clear the queue. To observe
abort timeline events, read from an existing timeline cursor or re-bootstrap
with `GET /v1/state`.

## 7. State Model

| State | Meaning |
| --- | --- |
| `idle` | No active turn. New message starts immediately. |
| `running` | Agent loop is active. New messages are queued. |
| `aborting` | Abort requested, active turn is stopping. |
| `failed` | Last run failed. New messages can restart processing. After `provider_stop`, queued input remains queued until a later run drains it. |

Provider transport errors can automatically start a queued follow-up turn.
`provider_stop` fails closed: Botified preserves partial context and queued
input, and does not automatically continue.

## 8. Sessions

Sessions are optional and explicit:

```yaml
runtime:
  data_dir: .botified/state
  session: robot-demo
```

Path:

```text
<runtime.data_dir>/sessions/<encoded-session-name>.jsonl
```

Relative `runtime.data_dir` is resolved from `runtime.cwd`. `serve` does not use
`BOTIFIED_HOME` roots.

Session JSONL:

- First line: `type=session`, `version=1`, `name`, `created_at`, `cwd`.
- Later lines: `user_message`, `user_batch`, `assistant_message`,
  `tool_result`, `compaction`, or service metadata used to rebuild runtime
  state. The public live contract is still `GET /v1/state` plus
  `GET /v1/timeline`; session files are not a public cursor API.

Session files are local plaintext. Do not treat them as encrypted audit logs.

## 9. Timeline And Logs

Process logs:

- Startup line, skill warnings, and AGENTS context-file warnings go to stderr.
- Runtime service events are exposed through `/v1/timeline` as Botified Timeline
  JSONL v1 (`botified.timeline.v1`).

Common timeline items:

- service status and queue pressure
- input accepted, queued, rejected, and drained
- cycle started, completed, and failed
- provider request started, completed, and failed
- assistant messages
- published file metadata
- command execution and background task lifecycle
- callback delivery and service errors

Public item payloads are bounded for display. Large command and task output is
reported through metadata and `output_artifact_path` when available. That path
is retained task stdout/stderr output for local inspection. It is not caller
file delivery. Files intended for callers must be published with `publish_file`,
observed as `file.published` on the timeline, and downloaded with
`GET /v1/files/{file_id}`.

Timeline retention is durable file-backed history under `runtime.data_dir` and
defaults to 14 days. Restarting the service with the same `runtime.data_dir` and
`runtime.session` preserves retained timeline replay. A cursor can still return
`410 stale_cursor` if it is from an unknown timeline instance, points beyond the
latest event, refers to a missing sequence, or is older than the retained window;
the recovery path is `GET /v1/state` and the returned `timeline_cursor`.

### File Store Operations

Uploaded and published files live under resolved `files.root_dir`, which is
relative to `runtime.data_dir` by default. The store creates `objects/`,
`metadata/`, `tmp/`, and `corrupt/` below that root.

Operational rules:

- Uploads and `publish_file` both count against `files.max_file_bytes` and
  `files.max_store_bytes`.
- `files.retention_secs` sets each file's retention window. Referencing a file
  from `/v1/messages` extends its retained-until timestamp.
- Expired files return `410 file_expired`; upload the bytes again when a caller
  still needs them.
- Task `output_artifact_path` is local captured stdout/stderr, not file
  delivery. Use `publish_file` for caller-downloadable files.

Event payload protections are best effort:

- secret-looking keys are redacted
- base64/image data is redacted
- long strings are truncated
- arrays and objects are capped

Do not rely on event redaction as a DLP system.

## 10. Tools And Security Boundary

Configure only the YAML-controlled built-ins with `tools.enabled`:

```yaml
tools:
  enabled: [bash, view_image]
```

`bash` is powerful and is not sandboxed.

The service injects control tools independently of `tools.enabled`:
`publish_file`, `task_list`, `task_cancel`, `task_reply`, and `task_send`.
When `subagents.enabled: true`, it also injects `subagent_spawn`,
`subagent_send`, `subagent_read`, `subagent_list`, and `subagent_cancel`.
`tools.enabled: []` disables `bash` and `view_image`; it does not remove these
service control tools.

When `registry.enabled: true`, the service also injects `registry_set`,
`registry_get`, and `registry_history` for both main agents and subagents. These
tools are inline and bounded. `registry_set` returns metadata such as topic,
source, writer, seq, TTL, and expiry, but it does not echo the stored `value`.
`registry_get` and `registry_history` may be truncated by limit or response byte
caps. Registry payload natural language is state text, not instructions, tool
suggestions, permission requests, or shell commands.

Runtime behavior:

- Runs `bash -lc` in `runtime.cwd`.
- The bash tool is not an interactive terminal. It should be treated as a
  service command runner with a predictable working directory and bounded
  output handling.
- `bash -lc` may read login startup files, but interactive-only `.bashrc`
  content is not reliable. Many Linux `.bashrc` files contain an early
  `case $- in *i*) ...` guard and return before later exports, so variables
  placed after that guard will not be available to Botified bash commands.
- Bash inherits the Botified service process environment after filtering
  secret-looking variables and bash exported functions. This is not a secret
  management system, and bash does not read local `.env` files automatically.
- Put non-secret variables required by external CLIs or robot modules in the
  service launch environment or in login startup files that `bash -lc` actually
  reads. Keep Botified runtime/provider settings in YAML, with environment
  variables used only for the secrets named by `api_key_env` and
  `service_key_env`.
- Default timeout: `tools.execution.default_timeout_secs` (120 seconds by default).
- Model-requested timeouts use `timeout_secs`: omitted uses the finite default, numeric values are capped by `tools.execution.max_timeout_secs`, explicit `null` means no automatic deadline, and `0` is invalid.
- Callback/output previews are capped by `tools.execution.callback_output_tail_bytes`; retained output artifacts are capped by `tools.execution.max_task_output_bytes`.
- Cancellation is best effort and kills the process group on Unix.

Task output artifacts are for captured command output. They are not published
files. When an agent creates a result file that a caller should receive, it must
use `publish_file`; callers then use `file.published` plus
`GET /v1/files/{file_id}`.

`view_image` behavior:

- Supports PNG, JPEG, WEBP, and GIF.
- Resolves relative paths from `runtime.cwd`.
- Accepts an optional `question`.
- Sends an internal provider request with no tools.
- Requires a provider endpoint with `[text, image]`.
- Returns text and metadata, not raw base64.

Recommended defaults:

- Local development: loopback host is fine.
- Non-loopback bind with configured built-ins or registry enabled: keep
  `service.service_key_env`.
- If a control plane already handles command execution, set `tools.enabled: []`.

### Interactive Stdio Contract

Botified-managed background `bash` tasks use interactive stdio by default.
Plain stdout/stderr is captured as task output only. It is not delivered to the
agent while the task runs. Control-plane scripts use complete
`<botified>...</botified>` stdout frames when they need the agent. Complete
protocol frames are filtered out of task output, callback tails, and artifacts.
Set `interactive_stdio: false` only when stdout must remain raw log text.

Use registry for state the agent can pull when needed. Use `tell` when a module
must notify the agent, `ask` when it needs an answer, `task_reply` to answer an
ask, and `task_send` only to write a short unsolicited message to a running
interactive task stdin. `task_send` is not a general robot control protocol.

For a module-author guide with complete examples, see
[CLI module development](cli-module-development.md).

Ask for a decision:

```text
<botified>{"op":"ask","id":"a1","message":"Should I continue?","expect":"yes/no","timeout_secs":60,"urgency":"normal"}</botified>
```

Notify without needing a reply:

```text
<botified>{"op":"tell","id":"t1","message":"Visitor arrived at the printer","urgency":"urgent"}</botified>
```

The agent sees accepted frames as `<task_ask ... ask_id="...">` and
`<task_tell ... tell_id="...">`. It answers asks only with
`task_reply(task_id, ask_id, message)`. If human judgment is needed, the agent
asks the human through ordinary chat, then uses `task_reply`. Tells are
notification-only and need no reply. The terminal task callback is a separate
final notification.

`task_send(task_id, message)` proactively writes this kind of frame to a
running interactive task stdin:

```text
<botified>{"op":"send","id":"s1","message":"pause after current segment"}</botified>
```

`task_send` does not answer or resolve pending asks and does not wait for an
ack. If the task needs to confirm it processed a send, it should emit a later
tell or ask. Stdin frames are unified short bounded control frames:
`<botified>{"op":"reply"|"send"|"registry_snapshot"|"registry_error"|"observe",...}</botified>`.
They are not a data channel; large payloads, file bodies, images/base64, long
logs, and audit content should use files, artifacts, timeline, registry/API, or
a module-specific API instead of task stdin. Priority/reliable control means a
short frame is completely written or visibly fails, not durable delivery,
retry, ack, or guaranteed processing.

Botified-managed bash tasks use interactive stdio by default; set
`interactive_stdio: false` only when stdout must remain raw log text. When
registry is enabled, such a task may also print stdout `registry_set` and
`registry_get` frames. `registry_set` updates current short-term state without
an ack, provider request, timeline/session entry, or agent queue item.
`registry_get` is a low-frequency snapshot read; the task receives
`registry_snapshot` or `registry_error` on stdin. Stdio does not support
`registry_history`, subscribe, queueing, or a dedicated writer worker; external
modules and history/streaming use cases should still use `/v1/registry/ws`.

Frame rules:

- `op` is `ask`, `tell`, `registry_set`, or `registry_get` on task stdout.
- `id` is the ask or tell correlation ID. It must be a non-empty ASCII token
  containing only `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, and `-`.
- `message` is the text shown to the agent.
- `expect` is an optional semantic hint such as `yes/no`, not a strict schema.
- `timeout_secs` is optional on ask frames and is bounded by service policy.
- `urgency` is optional and may be `normal` or `urgent`. `urgent` is a
  scheduling/preemption hint to get agent attention sooner; it is not an
  emergency stop and does not cancel detached background tasks.
- `message` is limited to 8192 characters.
- `id` and `expect` are limited to 2048 characters each.
- `task_reply`, `task_send`, registry responses, and observe notifications must
  fit the final serialized task stdin frame byte budget, including the
  `<botified>...</botified>` envelope and newline.
- `tools.execution.max_task_ask_pending_secs` must be positive and may use
  fractional seconds.

Urgent asks and tells are still bounded by queue limits, pending ask limits,
ask timeout, and provider/tool cancellation behavior. Botified prioritizes
urgent input within a finite queued set but does not promise strong fairness
under an unbounded urgent flood.

Invalid or oversized asks do not enter the LLM queue. If Botified can still
identify a valid ask ID and the task stdin is writable, it writes a bounded
exception reply frame back to the child process:

```text
<botified>{"op":"reply","id":"a1","exception":{"code":"ask_too_large","message":"task ask exceeded limit","retryable":false}}</botified>
```

Normal replies use the same reply frame with `message` instead of `exception`.

## 11. Limits

| Limit | Value |
| --- | --- |
| HTTP JSON body | 10 MiB |
| Uploaded or published single file | `files.max_file_bytes` (50 MiB by default) |
| Files per upload request | `files.max_upload_files` (16 by default) |
| Upload request bytes | `files.max_upload_request_bytes` (100 MiB by default) |
| Files referenced by one message | `files.max_message_files` (16 by default) |
| Referenced file bytes per message | `files.max_message_referenced_file_bytes` (100 MiB by default) |
| File store bytes | `files.max_store_bytes` (1 GiB by default) |
| File retention | `files.retention_secs` (604800 seconds by default) |
| `view_image` encoded image budget | 8 MiB |
| Provider response body | 1 MiB |
| Provider error text | 4096 chars |
| Event string | 4096 chars |
| Event array/object entries | 64 |
| Timeline retention | `timeline.retention_days` (14 days by default) |
| Hot timeline cache | 1024 events |
| Registry current topic cap | `registry.max_topics` (4096 by default) |
| Registry default TTL | `registry.default_ttl_secs` (5 seconds by default) |
| Registry retention | `registry.retention_secs` (300 seconds by default) |
| Registry topic length | `registry.max_topic_len` (256 bytes by default) |
| Registry source length | `registry.max_source_len` (128 bytes by default) |
| Registry value size | `registry.max_value_bytes` (8192 JSON bytes by default) |
| Registry history items | `registry.max_history_items` (20000 by default) |
| Registry history bytes | `registry.max_history_bytes` (67108864 bytes by default) |
| Registry query limit | `registry.default_query_limit` (100 by default), capped by `registry.max_query_limit` (1000 by default) |
| Registry response bytes | `registry.max_response_bytes` (262144 bytes by default) |
| Registry WebSocket frame | `registry.websocket_max_frame_bytes` (65536 bytes by default) |
| Bash default timeout | `tools.execution.default_timeout_secs` (120 seconds by default) |
| Bash requested timeout | `timeout_secs`; omitted uses the finite default, numeric values are capped, explicit `null` means no automatic deadline, and `0` is invalid |
| Bash callback/output preview | `tools.execution.callback_output_tail_bytes` (8192 bytes by default) |
| Bash retained output artifact | `tools.execution.max_task_output_bytes` (16 MiB by default) |
| Task ask pending timeout | `tools.execution.max_task_ask_pending_secs` (300 seconds by default) |
| AGENTS instruction files | 32 KiB total raw bytes by default |
| Skill file | 256 KiB |
| Skill name | 64 chars |
| Skill discovery depth | 6 |

## 12. AGENTS Instructions Operations

Botified reads AGENTS prompt guidance from the project rooted at `runtime.cwd`.

Operational rules:

- The project root is the nearest ancestor containing `.git` as a file or
  directory.
- Botified loads project candidates from that root down to `runtime.cwd`, in
  root-to-cwd order.
- In each project directory, the first non-empty candidate wins:
  `AGENTS.override.md`, otherwise `AGENTS.md`.
- If no `.git` marker exists, only `runtime.cwd` is checked for project files.
- Empty files are ignored.
- Directories, non-files, uppercase variants, and alternate project instruction
  filenames are ignored.

AGENTS content is prompt guidance only. It is not a skill, tool registry,
plugin manifest, sandbox policy, or permission system. The agent refreshes
AGENTS instructions before normal provider calls in the running service;
compaction requests use the compact summarizer prompt and do not inject AGENTS
content.

## 13. Skills Operations

Skill roots include the entries below when the referenced environment variables
or directories exist:

- official read-only skill root: `share/botified/skills`
- `$HOME/.agents/skills`
- ancestor `.agents/skills`
- `<cwd>/.botified/skills`
- `<cwd>/skills`

Operational notes:

- Core bundles install
  `share/botified/skills/botified-module-dev/SKILL.md` and
  `share/botified/skills/botified-skill-creator/SKILL.md`; those skills refer
  to installed manuals under `share/doc/botified/docs/`.
- The `botified-*` namespace is reserved for official bundled skills. Do not use
  that prefix for user or project skills.
- `serve` does not use `BOTIFIED_HOME` as a skill root.
- Discovery skips hidden subdirectories.
- Duplicate names remain loaded; direct `$name` invocation can become
  ambiguous.
- A skill body loaded through `skills.explicit` is available as user context on
  every provider call until the service restarts or configuration changes.
- A `$name` mention or structured skill item is injected only for that request.
  It is not written into the transcript or session, so a later turn must
  mention or select the skill again.
- Path invocation disambiguates duplicate names only for skills already loaded
  in the registry; it does not read arbitrary local `SKILL.md` paths.
- `allowed-tools` and extra metadata are preserved as skill metadata only.

## 14. E2E And Live Acceptance

`make check` remains the core default gate: fmt, clippy, locked Rust tests, and
the naming audit. It does not run e2e, visual, gateway, or playground component
gates.

E2E validation is independent and opt-in. It is not part of `make check`,
`make test`, `make release`, `make release-check`, or `make release-smoke`; do
not treat it as blocking development or publishing unless an operator explicitly
asks for e2e validation.

`make tui-visual` is an opt-in/manual visual gate. It is not run by
`make check`, `make release`, `make release-check`, or `make release-smoke`.

Gateway and playground are optional components with explicit component gates.
They are not run by the core default gate, e2e gate, visual gate, or release
gates:

```bash
make gateway-test
make playground-test
```

`make gateway-test` runs `npm test` in `botified-claw-gateway`; it requires
Node/npm that satisfy that package's `engines` field and the gateway
dependencies to be installed, for example with `npm ci` in that directory.
`make playground-test` runs `python3 -m unittest` and
`node --check botified_playground/ui/app.js` in `botified-playground`; it
requires Python 3 and Node, and does not enable the manual visual smoke checks.

Product e2e, TUI e2e, and live acceptance are explicit e2e test targets. They
are not run or compiled by default `cargo test`, default clippy, or
`make check`.

`make e2e` is itself the explicit request. It runs deterministic product and
TUI e2e:

```bash
make e2e
```

Run one deterministic e2e by test name:

```bash
E2E_TEST=case_name make e2e
```

Live acceptance is optional and appended only when `RUN_LIVE=1` is set. It uses
the same runtime YAML contract as `serve --config`: provider endpoint, model,
timeout, capabilities, and thinking live in YAML; environment variables only
provide secrets named by `api_key_env`.

By default live acceptance reads `botified.yaml`. Set
`BOTIFIED_LIVE_CONFIG=/path/to/botified.yaml` to use another runtime config.
Export the API key variables named by that YAML before running `make` or
`cargo`. The Makefile does not load `.env` automatically; if secrets are stored
there, source them first with `set -a; . ./.env; set +a`.

The SkillHub/weather live case installs SkillHub and fetches live weather, so it
requires outbound network access.

Run deterministic product and TUI e2e, then the full live acceptance suite:

```bash
RUN_LIVE=1 make e2e
```

Run deterministic product and TUI e2e, then one live acceptance test by name.
If `E2E_TEST` only matches one suite, the other cargo commands may run zero
tests:

```bash
RUN_LIVE=1 E2E_TEST=live_service_deepseek_text_and_bash make e2e
```

DeepSeek compatibility text/bash:

```bash
export BOTIFIED_TEXT_API_KEY=...
export BOTIFIED_VISION_API_KEY=...
export BOTIFIED_REASONING_API_KEY=...
RUN_LIVE=1 cargo test --test live_acceptance live_service_deepseek_text_and_bash -- --ignored
```

Image understanding with a vision-capable OpenAI-compatible endpoint:

```bash
export BOTIFIED_TEXT_API_KEY=...
export BOTIFIED_VISION_API_KEY=...
export BOTIFIED_REASONING_API_KEY=...
RUN_LIVE=1 cargo test --test live_acceptance live_service_image_understanding -- --ignored
```

Artifacts are written under `target/live-acceptance/`, which is ignored by git.

## 15. Release Handoff

`make release` builds two Botified core bundles:

```text
dist/botified-core-linux-x86_64-gnu.tar.gz
dist/botified-core-linux-aarch64-gnu.tar.gz
dist/SHA256SUMS
```

Public release staging happens in the sibling `botified-releases` repository.
The public release handoff must verify those core bundles plus `SHA256SUMS` from
that repository. Each bundle installs `bin/botified`, `bin/botified-tui`, and
`share/doc/botified/README.md`, with core manuals under
`share/doc/botified/docs/`. It also installs the official read-only skill root
with `share/botified/skills/botified-module-dev/SKILL.md` and
`share/botified/skills/botified-skill-creator/SKILL.md`. Core install and
startup do not require Node or npm, and `make release-check` must reject Node,
npm, gateway, or playground runtime assets in the core bundle. Curl interaction
remains example documentation for the HTTP API.

## 16. Troubleshooting

| Symptom | Check | Action |
| --- | --- | --- |
| Config generated and process exited | Selected YAML file did not exist. | Edit the generated file, set named credential env vars, then restart. |
| Usage printed on startup | Missing `serve` or unsupported argument. | Use `botified serve [--config PATH] [--mock-provider]`. |
| Missing provider API key | Provider `api_key_env` is unset or empty. | Set the named env var, or use mock mode for local contract testing. |
| Missing service key | `service_key_env` is configured but unset or empty. | Set the named env var, or set `service_key_env: null` for loopback-only local use. |
| `/v1/*` returns 401 | Service key enabled. | Send exact `Authorization: Bearer <key>`. |
| `/healthz` OK but tasks fail | Health does not verify provider. | Check `/v1/state.last_error` and `/v1/timeline`. |
| Non-loopback bind fails | Configured built-ins in `tools.enabled` or enabled registry without service key configuration. | Configure `service.service_key_env`, or disable built-ins and set `registry.enabled: false`. |
| `/v1/registry/*` returns 404 | Registry is disabled or the route is not one of the registry routes. | Set `registry.enabled: true` and restart; use `/v1/registry/ws`, `/current`, `/history`, or `/topics`. |
| Need to write registry state from curl | Registry HTTP routes are read-only. | Use WebSocket `/v1/registry/ws`; there is no HTTP set route. |
| Registry tools are missing from provider requests | `registry.enabled: false` or the service was started without a registry store. | Enable registry and restart. |
| Registry topic or pattern is rejected | Topic syntax is invalid, or `**` was not the final pattern segment. | Use dot-separated ASCII segments; use `*` for one segment and trailing `**` for the rest. |
| Registry set rejects `ttl_secs: null` | Null TTL is invalid; omitted TTL already means default TTL. | Omit `ttl_secs` or send a positive number. |
| `AGENTS.md` appears ignored | Wrong `runtime.cwd`, empty file, no exact filename, or `context_files.enabled: false`. | Put `AGENTS.override.md` or `AGENTS.md` under `runtime.cwd` or the nearest `.git` root-to-cwd path. |
| Request is rejected as too large | JSON or file upload exceeds configured limits. | Reduce the payload or adjust `service.*` and `files.*` limits. |
| `unsupported_attachment` | Message item type is not supported. | Use `text`, `file`, or `skill`; upload bytes through `POST /v1/files` first. |
| `invalid_file_id`, `file_not_found`, or `file_expired` | A message referenced a bad, missing, or expired file. | Upload the file again and send the returned `file_id`. |
| `file_too_large`, `upload_too_large`, or `too_many_files` | Upload or message file references exceed `files.*` limits. | Reduce file size/count or change the configured file limits. |
| No provider endpoint supports required capabilities | Router could not find one endpoint with all required capabilities. Service control tools can still require `tool_calls` when `tools.enabled: []`. | Add an endpoint with the needed `capabilities` or disable the feature that injects the tool. |
| `view_image` fails on startup | It is enabled without a `[text, image]` endpoint. | Add a vision endpoint or remove `view_image` from `tools.enabled`. |
| No timeline lines returned | `follow=false` found no retained events after the cursor. | Save `x-botified-next-cursor` and poll again, or use `follow=true` to wait for live events. |
| `410 stale_cursor` | A well-formed timeline cursor cannot be served because its instance is unknown, its sequence is future or missing, or the boundary expired out of the retained window. | Call `GET /v1/state` and use the returned `timeline_cursor`. |
| `409 preview_disabled` on `/v1/llm-text-preview` | Live draft preview is default-off. | Set `llm_text_preview.enabled: true` only when operators need best-effort live draft text; timeline remains authoritative. |
| `400 invalid_request` on `/v1/llm-text-preview?cursor=...` | Preview does not accept timeline cursors or replay-style query parameters. | Remove `cursor`, `seq`, `follow`, `replay`, or `since`; use `provider_request_id`, `cycle_id`, or `input_id` only as filters. |
| `400 unsupported_last_event_id` on `/v1/llm-text-preview` | Preview rejects SSE resume semantics. | Drop the `Last-Event-ID` header and reconnect live; use `/v1/timeline` for replayable facts. |
| `state: failed` | Provider, provider stop, compaction, or session persistence failure. | Inspect `last_error`, fix cause, then send a new message if appropriate. |
| Bash timeout or truncated output | Command exceeded the resolved timeout, callback/output preview cap, or retained artifact cap. | Use a smaller command, model-requested `timeout_secs`, or inspect `output_artifact_path` for task output. Use `publish_file` for caller file delivery. |
| Session did not resume | Missing or changed `runtime.session` or `runtime.data_dir`. | Use stable values in YAML. |
| Live test skipped | Missing `RUN_LIVE=1` or ignored-test argument. | Use `RUN_LIVE=1 make e2e` for live acceptance, or run the direct cargo command with `-- --ignored`. |
