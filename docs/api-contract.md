# API Semantics

Operator sandbox routes are admin-only. Mutating routes require the session cookie and `x-csrf-token`. `GET /api/operator/sandbox/status` accepts an optional `runId` query parameter to scope the response to one sandbox run.

Endpoint create requests accept `apiKeySecretRef` values in `secret/<slug>` form, where the slug uses lowercase letters, digits, and hyphens only. Endpoint `baseUrl` must be HTTPS and must not include credentials, query, or hash. The server stores the ref, but endpoint create/list responses, dashboard responses, and chat `endpointSnapshot` responses do not expose `apiKeySecretRef`; public endpoint payloads expose only `hasCredentialRef`.

`POST /api/projects/{projectId}/chat` accepts `{ endpointId, messages }`, where `messages` is an array of `{ role, content }` with role `system`, `user`, or `assistant`. The server verifies project access, loads the endpoint, resolves the endpoint secret ref to both API key and allowed base URL, verifies the endpoint base URL matches that server-side credential binding after normalization, and calls the OpenAI-compatible Chat Completions provider from the server. The response is `{ message, endpointSnapshot }`; `message` is the assistant message mapped from `choices[0].message.content`.
