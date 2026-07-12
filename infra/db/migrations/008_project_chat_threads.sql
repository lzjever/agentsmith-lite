create table if not exists project_chat_threads (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  endpoint_id text not null references model_endpoints(id) on delete restrict,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists project_chat_threads_project_updated_idx
  on project_chat_threads (project_id, updated_at desc, id desc);

create table if not exists project_chat_messages (
  sequence bigserial unique,
  id text primary key,
  thread_id text not null references project_chat_threads(id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant')),
  content text not null,
  created_at timestamptz not null
);

create index if not exists project_chat_messages_thread_created_idx
  on project_chat_messages (thread_id, created_at, id);
