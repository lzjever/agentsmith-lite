create index workspace_memberships_directory_idx
  on workspace_memberships(workspace_id, created_at, user_id collate "C");

create index workspace_memberships_role_directory_idx
  on workspace_memberships(workspace_id, role, created_at, user_id collate "C");

create index project_memberships_directory_idx
  on project_memberships(project_id, created_at, user_id collate "C");

create index project_memberships_role_directory_idx
  on project_memberships(project_id, role, created_at, user_id collate "C");
