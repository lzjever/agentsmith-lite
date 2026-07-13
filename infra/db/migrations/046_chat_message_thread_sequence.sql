alter table project_chat_messages
  drop constraint if exists project_chat_messages_sequence_key;

alter table project_chat_messages
  add constraint project_chat_messages_thread_sequence_key
  unique (thread_id, sequence);
