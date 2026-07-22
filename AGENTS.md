# Agent Instructions For `agentsmith-lite`

## Focus

This repo owns product code only:

- Node API and server-side business logic;
- Keycloak/OIDC client, session, CSRF, and API permission checks;
- Web UI as a thin product API client;
- OpenAI-compatible endpoint management and calls;
- File Libraries, durable Task sessions, artifacts, explicit Sandbox release, usage, and light audit;
- compatible vendored Botified fork, AgentSmith-owned loopback Bash executor, runner image, and runtime config;
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

## Development Loop

- Run the API and Next development servers directly for normal frontend, API, and business-logic work. Prefer in-place changes, hot reload, and focused checks.
- Agent teams may work in parallel, but agents must not spawn subagents or start concurrent test/build tasks. Tests default to small, single-process runs scheduled serially by the coordinator. Do not run Postgres, image builds, containers, or heavy K8s tasks in parallel.
- Leave the local runtime running for manual testing unless the task itself requires stopping it.
- Do not rebuild images or redeploy the full K8s application by default after ordinary source changes.
- Validate against local K8s only when a change crosses the K8s runtime boundary, such as pods, PVCs, RBAC, JuiceFS, sandbox containers, or explicit resource release.
- Build images, import them into k3s, and perform a complete deployment only for relevant deployment changes, explicit stage acceptance, handoff, or release.
- Playwright may target the development servers or an existing deployment when explicitly selected for the current change. It must not become a default gate.
- Fail fast and fix in place. Do not use repeated packaging and redeployment as a substitute for focused business-logic testing.
- Do not generate build reports, test evidence, acceptance reports, or workflow artifacts for this loop.

## Testing

- Use small unit/contract/behavior tests for the core logic you change.
- Do not run source TSX/JSDOM tests for ordinary UI work. Use them only when core server behavior cannot be verified another way.
- When one is necessary, run exactly one serial process in an explicit `systemd-run --user --scope` with an explicit working directory: `systemd-run --user --scope --working-directory="$PWD" -p MemoryMax=768M -p MemorySwapMax=0 -p TasksMax=32 env NODE_OPTIONS=--max-old-space-size=384 node --test --import tsx <test-file>`.
- Test runners must not start persistent dev services or invoke `tsx` or `npm exec` outside that constrained scope. Do not overlap browser, build, or K8s work with it.
- Never retry an OOM-killed command unchanged; change the approach first.
- TDD is welcome for core behavior: write the smallest failing test, implement, keep it green.
- Choose precise, narrow verification for the current change, selected deliberately by the developer.
- Do not run broad unrelated suites by default.
- e2e and visual checks are manual diagnostics only; run them only when the user explicitly asks.
- Do not create a default product-wide verification path. If a check is useful, keep it tied to the current business path.

## Product Boundaries

- All business logic belongs on the server.
- The product is English-only. Do not add i18n libraries, translation catalogs, locale-aware routing, locale URL prefixes, or speculative localization abstractions.
- Web UI only calls product APIs and must not carry agent business logic.
- AgentSmith server interacts with Botified exclusively through Botified service APIs.
- One Task maps to one durable Botified session and one exclusively bound File Library. Agent turns and Sandbox Runs are replaceable activity within that Task.
- A healthy Sandbox is released only after an authorized user explicitly confirms release. Do not add idle TTL, process-aware reclamation, maximum lifetime, or automatic release policy.
- No LLMUP, Codex runner core, JVS, WebDAV, file mount/sync daemon, AFSCP, or ASBCP.

## Substrate Boundary

This repo consumes `substrate.env` and `substrate.secrets.env`; it does not install K8s, Keycloak, PostgreSQL, S3-compatible storage, or JuiceFS CSI.

App runtime may consume product secrets such as `POSTGRES_APP_URL`, `APP_SESSION_SECRET`, and `OIDC_CLIENT_SECRET`. Raw S3 credentials, JuiceFS metadata URLs, and Keycloak admin secrets must not enter Web UI or Botified runtime.
