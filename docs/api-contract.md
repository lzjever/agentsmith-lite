# API Contract

The generated snapshot is `packages/contracts/api-contract.snapshot.json`.

Current P0 routes:

- `GET /api/health`
- `GET /api/bootstrap`
- `POST /api/auth/bootstrap`
- `POST /api/auth/login`
- `GET /api/me`
- `GET /api/dashboard`
- `GET /api/workspaces`
- `POST /api/workspaces`
- `POST /api/workspaces/{workspaceId}/projects`
- `GET /api/projects/{projectId}/endpoints`
- `POST /api/projects/{projectId}/endpoints`
- `POST /api/projects/{projectId}/chat`
- `POST /api/projects/{projectId}/files/validate`
- `GET /api/projects/{projectId}/tasks`
- `POST /api/projects/{projectId}/tasks`
- `POST /api/tasks/{taskId}/cancel`

Mutating routes require the session cookie and `x-csrf-token`.

