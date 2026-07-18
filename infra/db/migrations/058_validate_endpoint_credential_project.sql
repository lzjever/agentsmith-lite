update model_endpoints endpoint
set credential_id = null,
    health_status = 'unknown',
    health_checked_at = null,
    health_error_category = null,
    updated_at = clock_timestamp()
where endpoint.credential_id is not null
  and not exists (
    select 1
    from project_credentials credential
    where credential.id = endpoint.credential_id
      and credential.project_id = endpoint.project_id
  );

alter table model_endpoints
  validate constraint model_endpoints_credential_project_fkey;
