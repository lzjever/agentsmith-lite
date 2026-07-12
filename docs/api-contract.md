# API Semantics

Mutating routes require the session cookie and `x-csrf-token`. Project resources, task detail, events, artifacts, and cancel require project membership; there is no global control-plane API.

Project credential create and rotate requests accept a plaintext provider secret only for that write. The server encrypts it before storage and returns metadata, mask/fingerprint, and rotation information only. Endpoint create and update requests bind an existing project credential through `credentialId`. Endpoint `baseUrl` must be HTTPS and must not include credentials, query, or hash; it must normalize to the bound credential base URL. Public credential, endpoint, dashboard, and chat snapshot payloads never expose provider plaintext.

`POST /api/v1/projects/{projectId}/chat` accepts `{ endpointId, messages }`, where `messages` is an array of `{ role, content }` with role `system`, `user`, or `assistant`. The server verifies project access, loads the endpoint and its bound encrypted project credential, validates the normalized base URL binding, and decrypts the provider key only for the server-side OpenAI-compatible Chat Completions call. The response is `{ message, endpointSnapshot }`; `message` is the assistant message mapped from `choices[0].message.content`.
