alter table project_chat_threads
  add column if not exists deleted_at timestamptz;

create index if not exists project_chat_threads_project_activity_idx
  on project_chat_threads (project_id, pinned_at desc nulls last, updated_at desc, id desc)
  where deleted_at is null;

create index if not exists project_chat_threads_project_title_idx
  on project_chat_threads (project_id, lower(title))
  where deleted_at is null and title is not null;

alter table agent_task_artifacts
  add constraint agent_task_artifacts_preview_text_size_check
  check (preview_text is null or octet_length(preview_text) <= 8192);
