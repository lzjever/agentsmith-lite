alter table project_context_entries
  add column if not exists version integer not null default 1;

alter table project_context_entries
  add constraint project_context_entries_version_positive check (version > 0);
