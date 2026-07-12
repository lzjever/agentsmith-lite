-- Legacy aliases are read only by the one-time credential importer. New endpoint
-- writes use credential_id exclusively, and successful imports clear this column.
alter table model_endpoints
  alter column api_key_secret_ref drop not null;
