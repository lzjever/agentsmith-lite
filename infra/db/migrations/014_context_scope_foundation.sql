alter table project_context_entries add column if not exists workspace_id text references workspaces(id) on delete cascade;
alter table project_context_entries add column if not exists owner_user_id text references users(id) on delete cascade;
alter table project_context_entries add column if not exists context_key text;
update project_context_entries set workspace_id=(select workspace_id from projects where projects.id=project_context_entries.project_id), context_key=name where workspace_id is null or context_key is null;
alter table project_context_entries alter column workspace_id set not null, alter column context_key set not null;
alter table project_context_entries drop constraint if exists project_context_entries_scope_check;
alter table project_context_entries add constraint project_context_entries_scope_check check (scope in ('workspace_shared','workspace_personal','project_shared','project_personal'));
create unique index if not exists project_context_entries_scope_owner_key_idx on project_context_entries (workspace_id, coalesce(project_id,''), scope, coalesce(owner_user_id,''), context_key);
