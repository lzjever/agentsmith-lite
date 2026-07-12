# Development

## Commands

```bash
npm run typecheck
npm test
```

`npm test` runs focused unit, service, and API behavior tests. Use `scripts/deploy/render.sh` and `scripts/deploy/apply.sh` for app deployment.

## Package Boundaries

- `packages/contracts`: product API and shared data types.
- `packages/domain`: small domain validation/errors/IDs.
- `packages/ports`: storage and runtime interfaces.
- `packages/adapters-postgres`: migration contract plus in-memory test adapter.
- `packages/application`: auth, workspace/project, endpoint, chat, file path validation, task services.
- `packages/sandbox-controller`: dry-run app/sandbox manifest builders.
- `packages/botified-runtime`: config generator, event projection, serve wrapper.
- `packages/openai-compatible-client`: OpenAI-compatible validation and P0 mock client.
- `packages/api-entry-node`: Node HTTP API.
