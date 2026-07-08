# Auth Bootstrap

Built-in admin remains available when `AUTH_MODE=builtin_admin`.

Local defaults:

- email: `admin@agentsmith-lite.local`
- password: `admin-password`

Deployment should provide:

- `BUILTIN_ADMIN_INITIAL_PASSWORD`
- `APP_SESSION_SECRET`

`POST /api/auth/bootstrap` creates the stable admin user once when the request password matches the configured bootstrap password. `POST /api/auth/login` returns a session and CSRF token.

When `AUTH_MODE=oidc`, the server owns OIDC start/callback handling and sets the same `asl_session` HttpOnly cookie after a verified external principal login. Built-in bootstrap/login routes fail closed in OIDC mode.
