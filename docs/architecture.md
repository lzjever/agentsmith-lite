# Architecture

AgentSmith Lite is a clean app repo, not a release wrapper around the old system. The P0 implementation has:

- Node API serving product routes and static Web assets.
- Server-side services for auth, workspace/project records, endpoint config, a direct OpenAI-compatible Chat Completions adapter, path validation, and task state.
- App-owned Postgres is the default product store. SQL migrations live in `infra/db/migrations/*.sql`, are applied with `POSTGRES_APP_URL npm run db:migrate`, and are recorded in the `agentsmith_migrations` ledger.
- The Postgres-backed `ProductStore` covers product records, typed JSON document collections, and fenced runtime leases. The in-memory adapter is only a tests/local fallback when `POSTGRES_APP_URL` is absent.
- A sandbox controller package that renders namespaced sandbox manifests, reconciles the six lifecycle resources in tests, and includes a low-dependency in-cluster Kubernetes port/action applier used by TaskService live startup.
- A Botified runtime package that generates hardened per-task config, projects timeline events, and starts only `botified serve`.

The Web UI is a presentation client. It does not call model providers, Botified services, Kubernetes, databases, object storage, or filesystem APIs directly.

Chat requests go from the browser to `/api/projects/{projectId}/chat`, then the Node service resolves the endpoint secret ref to a server-configured API key and allowed base URL. The endpoint base URL must match that binding before the server calls the OpenAI-compatible `/chat/completions` endpoint.

The API store factory is environment controlled: `POSTGRES_APP_URL` selects the real Postgres adapter, while unset local/test runs use memory. Live sandbox mode fails fast without `POSTGRES_APP_URL`; only local dry-run/test flows may use the in-memory fallback. Substrate-only metadata such as JuiceFS state is not read by product migrations or the app store.
