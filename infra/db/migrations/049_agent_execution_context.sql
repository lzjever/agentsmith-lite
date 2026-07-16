alter table agent_tasks
  add column if not exists agent_context text not null default '';

alter table project_context_entries
  add column if not exists content_type text not null default 'text';

alter table project_context_entries
  add constraint project_context_entries_content_type_check
  check (content_type in ('text', 'json', 'markdown', 'yaml'));
