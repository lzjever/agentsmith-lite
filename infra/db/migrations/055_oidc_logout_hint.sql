alter table auth_sessions
  add column if not exists oidc_id_token text;
