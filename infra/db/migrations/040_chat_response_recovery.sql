alter table project_chat_messages
  add column if not exists pending_assistant_id text,
  add column if not exists pending_assistant_content text,
  add column if not exists pending_assistant_created_at timestamptz;

alter table project_chat_messages
  drop constraint if exists project_chat_messages_delivery_status_check;

alter table project_chat_messages
  add constraint project_chat_messages_delivery_status_check
  check (delivery_status in ('pending', 'response_pending', 'completed', 'failed', 'stopped'));

create unique index if not exists project_chat_messages_pending_assistant_id_idx
  on project_chat_messages (pending_assistant_id)
  where pending_assistant_id is not null;
