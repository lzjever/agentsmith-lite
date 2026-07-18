create unique index if not exists model_endpoints_project_name_unique
  on model_endpoints (project_id, lower(btrim(name)));
