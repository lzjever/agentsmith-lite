create table if not exists workspace_memberships (
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (workspace_id, user_id)
);

insert into workspace_memberships (workspace_id, user_id, role, created_at, updated_at)
select id, owner_user_id, 'owner', created_at, updated_at from workspaces
on conflict (workspace_id, user_id) do update set role = 'owner', updated_at = excluded.updated_at;

create index if not exists workspace_memberships_user_workspace_idx on workspace_memberships (user_id, workspace_id);
