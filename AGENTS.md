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

## Delete Governance Overhead

Aggressively remove existing and new governance overhead:

- evidence/report/rehearsal/release/gate/matrix systems;
- default `*-report.json` outputs and report-only fields;
- diagnostic document generation;
- umbrella validation concepts and pass/fail summaries detached from real product paths;
- default release validation gates or broad product health proofs;
- tests that test the testing or release machinery;
- tests that assert docs prose;
- generated archives or indexes that are not needed to run the product.

Scripts should do the work, print concise stdout/stderr, and fail with a non-zero exit code. Do not add report generation as a substitute for fixing the failing code path.

## Testing

- Use small unit/contract/behavior tests for the core logic you change.
- TDD is welcome for core behavior: write the smallest failing test, implement, keep it green.
- Choose the minimum verification for the current change; do not treat checks as a default release gate or general acceptance proof.
- Do not run broad unrelated suites by default.
- e2e and visual checks are manual diagnostics only. Run them only when the user explicitly asks or a specific UI/cross-component risk justifies it.
- Do not test tests, screenshots, report shape, or governance commands.

## Product Boundaries

- All business logic belongs on the server.
- Web UI and future product TUI only call product APIs.
- TUI may import generated product API types or a thin HTTP client only.
- TUI must not import `application`, `ports`, `sandbox-controller`, `botified-runtime`, `openai-compatible-client`, `adapters-postgres`, or K8s clients.
- TUI must not call `/api/operator/*`.
- No LLMUP, Codex runner core, JVS, WebDAV, file mount/sync daemon, AFSCP, or ASBCP.

## Substrate Boundary

This repo consumes `substrate.env` and `substrate.secrets.env`; it does not install K8s, Keycloak, PostgreSQL, S3-compatible storage, or JuiceFS CSI.

App runtime may consume product secrets such as `POSTGRES_APP_URL`, `APP_SESSION_SECRET`, and `OIDC_CLIENT_SECRET`. Raw S3 credentials, JuiceFS metadata URLs, and Keycloak admin secrets must not enter Web/UI/TUI/Botified runtime.
