# Architecture

AgentSmith Lite is a clean app repo, not a release wrapper around the old system. The P0 implementation has:

- Node API serving product routes and static Web assets.
- Server-side services for auth, workspace/project records, endpoint config, chat stub, path validation, and task state.
- App-owned Postgres is the default product store. SQL migrations live in `infra/db/migrations/*.sql`, are applied with `POSTGRES_APP_URL npm run db:migrate`, and are recorded in the `agentsmith_migrations` ledger.
- The Postgres-backed `ProductStore` covers product records, typed JSON document collections, and fenced runtime leases. The in-memory adapter is only a tests/local fallback when `POSTGRES_APP_URL` is absent.
- A sandbox controller package that renders namespaced pod/service/secret/configmap/RBAC/network-policy manifests in dry-run form.
- A Botified runtime package that generates hardened per-task config, projects timeline events, and starts only `botified serve`.

The Web UI is a presentation client. It does not call model providers, Botified services, Kubernetes, databases, object storage, or filesystem APIs directly.

The API store factory is environment controlled: `POSTGRES_APP_URL` selects the real Postgres adapter, while unset local/test runs use memory. Substrate-only metadata such as JuiceFS state is not read by product migrations or the app store.
