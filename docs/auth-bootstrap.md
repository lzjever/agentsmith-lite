# Auth Bootstrap

P0 auth mode is built-in admin.

Local defaults:

- email: `admin@agentsmith-lite.local`
- password: `admin-password`

Deployment should provide:

- `BUILTIN_ADMIN_INITIAL_PASSWORD`
- `APP_SESSION_SECRET`

`POST /api/auth/bootstrap` creates the stable admin user once when the request password matches the configured bootstrap password. `POST /api/auth/login` returns a session and CSRF token.

