# Botified HTTP Examples

This page is the compact reference for calling a running Botified service from
curl or another HTTP client. For interactive operation, use `botified-tui`
against the same service.

## Start A Local Service

```bash
botified serve --config botified.yaml --mock-provider
```

If `botified.yaml` does not exist, Botified writes an example config and exits.
Edit it, then start the service again. The generated config uses
`service.service_key_env: BOTIFIED_SERVICE_KEY`.

```bash
export BOTIFIED_SERVICE_KEY=dev
botified serve --config botified.yaml --mock-provider
```

In another shell:

```bash
BASE=http://127.0.0.1:17777
AUTH='Authorization: Bearer dev'
```

## Check Runtime State

```bash
curl -s "$BASE/healthz"
curl -s "$BASE/v1/state" -H "$AUTH" \
  | jq '{state, queue_length, tasks, last_error, session_id, timeline_cursor}'
```

`/healthz` only confirms that HTTP is serving. `/v1/state` is the useful client
bootstrap response because it includes the current `session_id` and
`timeline_cursor`. Timeline history is a durable file-backed log under
`runtime.data_dir`; default retention is `timeline.retention_days: 14`.

## Send A Message

```bash
CURSOR=$(curl -s -X POST "$BASE/v1/messages" \
  -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"client_message_id":"demo-1","text":"Reply in one short sentence."}' \
  | jq -r .timeline_cursor)
```

Use `client_message_id` when your caller has its own request id. If omitted,
Botified generates one.

## Read Timeline Events

Fetch a finite snapshot after the accepted input:

```bash
curl -s -D headers.txt "$BASE/v1/timeline?cursor=$CURSOR&follow=false" -H "$AUTH"
NEXT=$(awk 'BEGIN { IGNORECASE=1 } /^x-botified-next-cursor:/ { print $2 }' headers.txt | tr -d '\r')
```

Forward polling is the default cursor mode. `follow=false` returns
`x-botified-next-cursor`; use `limit=N` for pages up to 1000 events. Tail recent
retained history without a cursor, or page older history from a page-start
cursor:

```bash
curl -s -D headers.txt "$BASE/v1/timeline?tail=200" -H "$AUTH"
PAGE_START=$(awk 'BEGIN { IGNORECASE=1 } /^x-botified-page-start-cursor:/ { print $2 }' headers.txt | tr -d '\r')
curl -s -D older-headers.txt "$BASE/v1/timeline?cursor=$PAGE_START&direction=backward&follow=false&limit=200" -H "$AUTH"
```

Tail and backward responses include page start/end cursors,
`x-botified-has-more-before`, and `x-botified-history-boundary`.

Follow retained backlog and live events from a cursor:

```bash
curl -N "$BASE/v1/timeline?cursor=$NEXT&follow=true" -H "$AUTH"
```

The history is durable; `follow=true` is just the live HTTP stream and does not
return `x-botified-next-cursor`. While idle, `follow=true` may emit blank
keepalive lines. Clients must skip blank or whitespace-only lines before parsing
JSON; blank lines are not timeline events and do not carry cursors. After
`410 stale_cursor`, call `GET /v1/state` again and use the returned
`timeline_cursor`. `410` means a well-formed cursor cannot be served because its
instance is unknown, its sequence is future or missing, or the boundary expired
out of the retained window.

## Upload A File And Reference It

```bash
FILE_ID=$(curl -s -X POST "$BASE/v1/files" \
  -H "$AUTH" \
  -F file=@./photo.jpg \
  | jq -r '.files[0].file_id')

curl -s -X POST "$BASE/v1/messages" \
  -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d "{
    \"client_message_id\": \"file-1\",
    \"items\": [
      { \"type\": \"text\", \"text\": \"Describe the image I uploaded.\" },
      { \"type\": \"file\", \"file_id\": \"$FILE_ID\" }
    ]
  }"
```

Uploaded files are metadata references. Botified does not automatically inject
file contents into the model; the user message tells the agent what to do.

## Download A Published File

When the agent publishes a file, the timeline includes the file id and download
metadata. Download it through the service:

```bash
curl -L "$BASE/v1/files/$FILE_ID" -H "$AUTH" -o output.bin
```

## Live Text Preview

Timeline remains the authoritative event stream. If the service config enables
`llm_text_preview.enabled: true`, clients may open the optional live-only SSE
preview for draft model text:

```bash
curl -N "$BASE/v1/llm-text-preview" -H "$AUTH"
```

The preview has no cursor, no replay, and is not written to session files.
