alter table project_chat_threads
  add column if not exists starred_at timestamptz;

alter table project_chat_messages
  add column if not exists version integer not null default 1,
  add column if not exists delivery_status text not null default 'completed',
  add column if not exists updated_at timestamptz;

update project_chat_messages
set updated_at = created_at
where updated_at is null;

alter table project_chat_messages
  alter column updated_at set not null;

alter table project_chat_messages
  drop constraint if exists project_chat_messages_delivery_status_check;

alter table project_chat_messages
  add constraint project_chat_messages_delivery_status_check
  check (delivery_status in ('pending', 'completed', 'failed', 'stopped'));

create index if not exists project_chat_threads_project_retained_order_idx
  on project_chat_threads (project_id, starred_at desc nulls last, pinned_at desc nulls last, updated_at desc, id desc)
  where deleted_at is null;
