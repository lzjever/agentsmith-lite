alter table projects
  add constraint projects_id_workspace_unique unique (id, workspace_id);

create table file_libraries (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id text not null,
  name text not null check (length(btrim(name)) between 1 and 160),
  root_sub_path text not null,
  created_by_user_id text not null references users(id),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (project_id, root_sub_path),
  foreign key (project_id, workspace_id) references projects(id, workspace_id) on delete cascade
);

create unique index file_libraries_project_name_unique
  on file_libraries (project_id, lower(btrim(name)));
