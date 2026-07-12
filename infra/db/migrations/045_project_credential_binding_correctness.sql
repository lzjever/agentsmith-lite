create unique index if not exists project_credentials_id_project_id_idx
  on project_credentials (id, project_id);

alter table model_endpoints
  add constraint model_endpoints_credential_project_fkey
  foreign key (credential_id, project_id)
  references project_credentials (id, project_id)
  on delete restrict
  not valid;
