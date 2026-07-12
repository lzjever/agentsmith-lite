alter table project_memberships
  drop constraint if exists project_memberships_role_check;

alter table project_memberships
  add constraint project_memberships_role_check check (role in ('owner', 'admin', 'member', 'viewer'));

insert into project_memberships (project_id, user_id, role, created_at, updated_at)
select id, owner_user_id, 'owner', created_at, updated_at
from projects
on conflict (project_id, user_id) do update
  set role = 'owner',
      updated_at = excluded.updated_at;
