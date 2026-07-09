# Agent Instructions For `agentsmith-lite`

## Focus

This repo owns product code only:

- Node API and server-side business logic;
- Keycloak/OIDC client, session, CSRF, and API permission checks;
- Web UI as a thin product API client;
- OpenAI-compatible endpoint management and calls;
- project files, task events, artifacts, cancel, TTL, and reap;
- Botified client, runner image, runtime config;
- sandbox manifest rendering/reconciliation;
- app image, app offline bundle, and deploy helpers.

Work should move the local single-node K8s product loop forward. Do not spend cycles building governance systems.

## Keep Work Product-Led

Keep only code, docs, scripts, and tests that help the product run or help a
developer fix a concrete product path. Delete process-only material instead of
renaming it.

- Do not build process artifacts, matrices, archives, or workflow systems around the work.
- Do not add generic test/script/stage/document concepts detached from product behavior.
- Do not test tests, generated screenshots, prose wording, or command wrappers.
- Runtime diagnostics, product API errors, and Botified/sandbox logs are product behavior when they help operate the core loop.

Developer-selected checks should be narrow, named after the product path they
exercise, print concise stdout/stderr, and exit non-zero on failure.

## Testing

- Use small unit/contract/behavior tests for the core logic you change.
- TDD is welcome for core behavior: write the smallest failing test, implement, keep it green.
- Choose precise, narrow verification for the current change, selected deliberately by the developer.
- Do not run broad unrelated suites by default.
- e2e and visual checks are manual diagnostics only; run them only when the user explicitly asks.
- Do not create a default product-wide verification path. If a check is useful, keep it tied to the current business path.

## Product Boundaries

- All business logic belongs on the server.
- Web UI and future product TUI only call product APIs.
- TUI may import generated product API types or a thin HTTP client only; it must not carry agent business logic.
- TUI must not import `application`, `ports`, `sandbox-controller`, `botified-runtime`, `openai-compatible-client`, `adapters-postgres`, or K8s clients.
- TUI must not call `/api/operator/*`.
- No LLMUP, Codex runner core, JVS, WebDAV, file mount/sync daemon, AFSCP, or ASBCP.

## Substrate Boundary

This repo consumes `substrate.env` and `substrate.secrets.env`; it does not install K8s, Keycloak, PostgreSQL, S3-compatible storage, or JuiceFS CSI.

App runtime may consume product secrets such as `POSTGRES_APP_URL`, `APP_SESSION_SECRET`, and `OIDC_CLIENT_SECRET`. Raw S3 credentials, JuiceFS metadata URLs, and Keycloak admin secrets must not enter Web/UI/TUI/Botified runtime.
