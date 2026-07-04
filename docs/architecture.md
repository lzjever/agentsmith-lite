# Architecture

AgentSmith Lite is a clean app repo, not a release wrapper around the old system. The P0 implementation has:

- Node API serving product routes and static Web assets.
- Server-side services for auth, workspace/project records, endpoint config, chat stub, path validation, and task state.
- Postgres adapter ports plus an in-memory adapter for P0/dev/test.
- A sandbox controller package that renders namespaced pod/service/secret/configmap/RBAC/network-policy manifests in dry-run form.
- A Botified runtime package that generates hardened per-task config, projects timeline events, and starts only `botified serve`.

The Web UI is a presentation client. It does not call model providers, Botified services, Kubernetes, databases, object storage, or filesystem APIs directly.

