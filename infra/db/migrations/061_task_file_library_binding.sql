-- Phase 2 intentionally discards incompatible local Task runtime data.
delete from task_idempotency_records
where operation in ('create','retry','duplicate','message','message-edit','message-delete','abort-turn','work-stop','cancel','edit','archive','delete');

delete from postgres_json_docs
where collection in ('sandbox_runtime_state','sandbox_run_state');

delete from task_interaction_changes;
delete from task_messages;
delete from agent_task_artifacts;
delete from agent_tasks;

update project_resource_usage
set active_tasks = 0,
    updated_at = now()
where active_tasks <> 0;

alter table file_libraries
  add constraint file_libraries_id_workspace_project_unique
  unique (id, workspace_id, project_id);

alter table agent_tasks
  add column file_library_id text;

alter table agent_tasks
  add constraint agent_tasks_file_library_scope_fkey
  foreign key (file_library_id, workspace_id, project_id)
  references file_libraries(id, workspace_id, project_id)
  on delete restrict;

alter table agent_tasks
  add constraint agent_tasks_file_library_tombstone_check check (
    (deleted_at is null and file_library_id is not null) or
    (deleted_at is not null and file_library_id is null)
  );

create unique index agent_tasks_file_library_active_unique
  on agent_tasks(file_library_id)
  where deleted_at is null;

create function enforce_agent_task_file_library_immutable() returns trigger
language plpgsql as $$
begin
  if old.deleted_at is null and new.deleted_at is null
     and new.file_library_id is distinct from old.file_library_id then
    raise exception 'Task File Library binding is immutable' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger agent_tasks_file_library_immutable
before update of file_library_id, deleted_at on agent_tasks
for each row execute function enforce_agent_task_file_library_immutable();

alter table task_messages drop constraint if exists task_messages_terminal_outcome_check;
alter table task_messages drop constraint if exists task_messages_delivery_status_check;
alter table task_messages add constraint task_messages_delivery_status_check
  check (delivery_status in ('pending','dispatching','accepted','failed'));
drop index if exists task_messages_target_task_id_idx;

alter table task_messages drop column if exists target_task_id;
alter table agent_tasks drop column if exists source_task_id;
alter table agent_tasks drop column if exists input_paths;

alter table task_interaction_changes drop constraint if exists task_interaction_changes_kind_check;
alter table task_interaction_changes add constraint task_interaction_changes_kind_check check (
  interaction_kind in ('user_message','assistant_message','tool','background_task','task_question','task_notice','task_result','subagent_result','file','system_error')
);
