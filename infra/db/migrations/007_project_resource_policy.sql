create table if not exists project_resource_policies (
  project_id text primary key references projects(id) on delete cascade,
  active_tasks_limit integer,
  provider_requests_limit bigint,
  provider_tokens_limit bigint,
  provider_cost_limit double precision,
  project_file_bytes_limit bigint,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists project_resource_usage (
  project_id text primary key references projects(id) on delete cascade,
  active_tasks integer not null default 0,
  provider_requests bigint not null default 0,
  provider_tokens bigint not null default 0,
  provider_cost double precision not null default 0,
  project_file_bytes bigint not null default 0,
  updated_at timestamptz not null
);

create table if not exists project_alerts (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  type text not null,
  status text not null check (status = 'active'),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (project_id, type, status)
);

create table if not exists project_audit_events (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  actor_id text references users(id) on delete set null,
  action text not null,
  status text not null check (status in ('accepted', 'rejected')),
  resource_id text,
  created_at timestamptz not null
);

insert into project_resource_policies (project_id, active_tasks_limit, created_at, updated_at)
select id, task_concurrency_limit, created_at, updated_at from projects
on conflict (project_id) do nothing;

insert into project_resource_usage (project_id, active_tasks, updated_at)
select p.id, count(t.id) filter (where t.status in ('queued', 'starting', 'running', 'stopping')), now()
from projects p left join agent_tasks t on t.project_id = p.id
group by p.id
on conflict (project_id) do nothing;
