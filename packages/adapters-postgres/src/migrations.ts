export interface PostgresMigration {
  id: string;
  sql: string;
}

export const POSTGRES_MIGRATIONS: PostgresMigration[] = [
  {
    id: "001_initial_product_schema",
    sql: `
create table if not exists users (
  id text primary key,
  email text not null unique,
  role text not null,
  password_hash text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists auth_sessions (
  id text primary key,
  user_id text not null references users(id),
  csrf_token text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null
);

create table if not exists workspaces (
  id text primary key,
  name text not null,
  owner_user_id text not null references users(id),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (owner_user_id, name)
);

create table if not exists projects (
  id text primary key,
  workspace_id text not null references workspaces(id),
  name text not null,
  owner_user_id text not null references users(id),
  root_path text not null,
  task_concurrency_limit integer not null default 2,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (workspace_id, name)
);

create table if not exists model_endpoints (
  id text primary key,
  project_id text not null references projects(id),
  name text not null,
  protocol text not null check (protocol = 'openai_chat_completions'),
  base_url text not null,
  model text not null,
  api_key_secret_ref text not null,
  capabilities jsonb not null default '[]'::jsonb,
  request_timeout_secs integer not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists agent_tasks (
  id text primary key,
  workspace_id text not null references workspaces(id),
  project_id text not null references projects(id),
  endpoint_id text not null references model_endpoints(id),
  prompt text not null,
  status text not null,
  run_id text not null,
  sandbox jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists agent_task_events (
  id text primary key,
  task_id text not null references agent_tasks(id),
  kind text not null,
  cursor text not null,
  botified_seq integer not null,
  botified_type text not null,
  session_id text not null,
  payload jsonb not null,
  created_at timestamptz not null,
  unique (task_id, botified_seq)
);

create table if not exists agent_task_artifacts (
  id text primary key,
  task_id text not null references agent_tasks(id),
  file_id text not null,
  name text not null,
  bytes integer not null,
  created_at timestamptz not null,
  unique (task_id, file_id)
);

create table if not exists postgres_json_docs (
  collection text not null,
  id text not null,
  document jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

create table if not exists runtime_leases (
  name text primary key,
  holder text not null,
  fencing_token bigint not null,
  expires_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
);
`
  }
];

