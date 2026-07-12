alter table project_credentials
  add column if not exists type text not null default 'api_key',
  add column if not exists base_url text,
  add column if not exists key_id text,
  add column if not exists nonce bytea,
  add column if not exists ciphertext bytea,
  add column if not exists auth_tag bytea,
  add column if not exists version integer not null default 1,
  add column if not exists last_rotated_at timestamptz;

alter table project_credentials
  alter column secret_ref drop not null;

alter table project_credentials
  add constraint project_credentials_type_check check (type = 'api_key');

alter table model_endpoints
  add column if not exists credential_id text references project_credentials(id) on delete restrict;

create index if not exists model_endpoints_credential_id_idx on model_endpoints (credential_id);
