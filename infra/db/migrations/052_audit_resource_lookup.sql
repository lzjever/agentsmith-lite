create index project_audit_events_resource_idx
  on project_audit_events(project_id, resource_id, resource_kind, created_at desc, id desc);
