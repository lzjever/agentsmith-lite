alter table project_context_entries
  alter column project_id drop not null;

update project_context_entries
set owner_user_id = user_id
where scope in ('workspace_personal', 'project_personal')
  and owner_user_id is null;

alter table project_context_entries
  drop constraint if exists project_context_entries_scope_shape_check;

alter table project_context_entries
  add constraint project_context_entries_scope_shape_check
  check (
    (scope = 'workspace_shared' and project_id is null and owner_user_id is null)
    or (scope = 'workspace_personal' and project_id is null and owner_user_id is not null)
    or (scope = 'project_shared' and project_id is not null and owner_user_id is null)
    or (scope = 'project_personal' and project_id is not null and owner_user_id is not null)
  );
