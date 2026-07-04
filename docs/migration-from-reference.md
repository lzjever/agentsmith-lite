# Migration From Reference

This P0 skeleton is a clean implementation rather than a bulk copy of the old app.

Copied or vendored:

- `.reference/botified` runtime-relevant source into `third_party/botified` from pinned commit `988f65d31652008ca4ea320ec99ec5c6d03e7890`.

Rebuilt clean:

- Node API routes and services.
- Web UI.
- Postgres ports and in-memory adapter.
- Sandbox manifest renderer.
- Botified config generator and event projection.
- Direct server-side OpenAI-compatible Chat Completions calls for product chat.
- Deploy/offline script skeletons.

Deleted/deferred:

- old release/governance command paths;
- old external control-plane clients;
- old provider translation runtime, including LLMUP/provider registry style translation layers;
- live terminal runtime;
- Botified TUI as AgentSmith Lite product behavior.

AgentSmith Lite does not introduce an LLMUP layer, OpenAI SDK wrapper, provider registry, streaming path, tool-call adapter, or retry framework for product chat. The P0 path is a single server-side adapter that posts `{ model, messages }` to the endpoint's OpenAI-compatible `/chat/completions` URL.
