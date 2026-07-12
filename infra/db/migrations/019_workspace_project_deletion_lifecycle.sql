alter table workspaces add column if not exists lifecycle_status text not null default 'active'
  check (lifecycle_status in ('active', 'deleting'));
alter table projects add column if not exists lifecycle_status text not null default 'active'
  check (lifecycle_status in ('active', 'deleting'));

create index if not exists projects_workspace_lifecycle_idx on projects (workspace_id, lifecycle_status, id);
