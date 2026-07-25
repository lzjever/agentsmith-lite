create index project_credentials_directory_idx
  on project_credentials(project_id, created_at desc, id collate "C" desc);

create index model_endpoints_directory_idx
  on model_endpoints(project_id, created_at desc, id collate "C" desc);

create index model_endpoints_task_ready_directory_idx
  on model_endpoints(project_id, created_at desc, id collate "C" desc)
  where credential_id <> ''
    and health_status = 'healthy'
    and capabilities @> '["text","tool_calls"]'::jsonb;
