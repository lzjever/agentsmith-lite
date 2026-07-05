# Development

## Commands

```bash
npm run typecheck
npm test
npm run check:forbidden-surfaces
npm run e2e:smoke
npm run e2e:operator-lifecycle
npm run visual:screenshot
```

`npm test` runs focused unit/service/API/boundary tests. The independent smoke, operator lifecycle e2e, and browser visual checks are manual commands; operator lifecycle and visual are not default release gates.

## Package Boundaries

- `packages/contracts`: product API and shared data types.
- `packages/domain`: small domain validation/errors/IDs.
- `packages/ports`: storage and runtime interfaces.
- `packages/adapters-postgres`: migration contract plus in-memory test adapter.
- `packages/application`: auth, workspace/project, endpoint, chat, file path validation, task services.
- `packages/sandbox-controller`: dry-run app/sandbox manifest builders.
- `packages/botified-runtime`: config generator, event projection, serve wrapper.
- `packages/openai-compatible-client`: OpenAI-compatible validation and P0 mock client.
- `packages/api-entry-node`: Node HTTP API and static Web serving.

The Web UI under `src/web` must call only `/api/*`.
