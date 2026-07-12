alter table agent_tasks add column if not exists finalization_intent_status text;
alter table agent_tasks add column if not exists finalization_intent_at timestamptz;

create table if not exists project_provider_settlements (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  task_id text references agent_tasks(id) on delete set null,
  endpoint_id text not null references model_endpoints(id) on delete restrict,
  status text not null check (status in ('reserved','dispatched','delivered','settled','unknown','failed')),
  reserved_at timestamptz not null,
  expires_at timestamptz not null,
  dispatched_at timestamptz,
  delivered_at timestamptz,
  settled_at timestamptz,
  provider_tokens bigint,
  provider_cost double precision,
  updated_at timestamptz not null
);
create index if not exists project_provider_settlements_expiry_idx on project_provider_settlements (status, expires_at);
create index if not exists project_provider_settlements_terminal_idx on project_provider_settlements (status, updated_at);
