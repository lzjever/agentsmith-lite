# API Contract

The checked-in snapshot is `packages/contracts/api-contract.snapshot.json`. It is the contract for public AgentSmith Lite product API routes plus admin-only operator API routes used by deployment/operator scripts. It excludes static web assets and private upstream Botified, OpenAI-compatible provider, Kubernetes, and Postgres surfaces.

Current product API routes:

- `GET /api/health`
- `GET /api/bootstrap`
- `POST /api/auth/bootstrap`
- `POST /api/auth/login`
- `GET /api/auth/oidc/start`
- `GET /api/auth/oidc/callback`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/dashboard`
- `GET /api/workspaces`
- `POST /api/workspaces`
- `POST /api/workspaces/{workspaceId}/projects`
- `GET /api/projects/{projectId}/endpoints`
- `POST /api/projects/{projectId}/endpoints`
- `POST /api/projects/{projectId}/chat`
- `GET /api/projects/{projectId}/files`
- `POST /api/projects/{projectId}/files`
- `GET /api/projects/{projectId}/files/download`
- `DELETE /api/projects/{projectId}/files`
- `POST /api/projects/{projectId}/files/validate`
- `GET /api/projects/{projectId}/tasks`
- `POST /api/projects/{projectId}/tasks`
- `GET /api/tasks/{taskId}/events`
- `GET /api/tasks/{taskId}/artifacts`
- `GET /api/tasks/{taskId}/artifacts/{artifactId}/download`
- `POST /api/tasks/{taskId}/cancel`

Current operator API routes:

- `GET /api/operator/sandbox/status`
- `POST /api/operator/sandbox/reap`

Operator routes are admin-only. Mutating routes require the session cookie and `x-csrf-token`. `GET /api/operator/sandbox/status` accepts an optional `runId` query parameter to scope the status response to one sandbox run; omitting it preserves the global operator status response.

Endpoint create requests accept `apiKeySecretRef` values in `secret/<slug>` form, where the slug uses lowercase letters, digits, and hyphens only. Endpoint `baseUrl` must be HTTPS and must not include credentials, query, or hash. The server stores the ref, but endpoint create/list responses, dashboard responses, and chat `endpointSnapshot` responses do not expose `apiKeySecretRef`; public endpoint payloads expose only `hasCredentialRef`.

`POST /api/projects/{projectId}/chat` accepts `{ endpointId, messages }`, where `messages` is an array of `{ role, content }` with role `system`, `user`, or `assistant`. The server verifies project access, loads the endpoint, resolves the endpoint secret ref to both API key and allowed base URL, verifies the endpoint base URL matches that server-side credential binding after normalization, and calls the OpenAI-compatible Chat Completions provider from the server. The response is `{ message, endpointSnapshot }`; `message` is the assistant message mapped from `choices[0].message.content`.
