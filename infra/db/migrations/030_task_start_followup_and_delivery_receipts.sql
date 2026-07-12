alter table agent_tasks add column if not exists start_intent_status text, add column if not exists start_claimed_at timestamptz, add column if not exists start_lease_expires_at timestamptz, add column if not exists start_attempt_count integer not null default 0, add column if not exists start_next_retry_at timestamptz, add column if not exists start_safe_error text;
alter table agent_tasks drop constraint if exists agent_tasks_start_intent_status_check;
alter table agent_tasks add constraint agent_tasks_start_intent_status_check check (start_intent_status is null or start_intent_status in ('pending','dispatching','dispatched','failed'));
alter table task_follow_ups add column if not exists delivery_status text not null default 'pending', add column if not exists claimed_at timestamptz, add column if not exists lease_expires_at timestamptz, add column if not exists attempt_count integer not null default 0, add column if not exists next_retry_at timestamptz, add column if not exists safe_error text, add column if not exists updated_at timestamptz, add column if not exists deleted_at timestamptz;
update task_follow_ups set updated_at = created_at where updated_at is null;
alter table task_follow_ups alter column updated_at set not null;
alter table task_follow_ups drop constraint if exists task_follow_ups_delivery_status_check;
alter table task_follow_ups add constraint task_follow_ups_delivery_status_check check (delivery_status in ('pending','dispatching','terminal_pending','accepted','successor_created','failed'));
create index if not exists agent_tasks_start_intent_due_idx on agent_tasks (start_next_retry_at, start_lease_expires_at, created_at) where start_intent_status in ('pending','dispatching');
create index if not exists task_follow_ups_delivery_due_idx on task_follow_ups (next_retry_at, lease_expires_at, created_at) where delivery_status in ('pending','dispatching','terminal_pending') and deleted_at is null;

create table if not exists task_idempotency_records (
  actor_id text not null references users(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  operation text not null,
  idempotency_key text not null,
  request_hash text not null,
  resource_id text not null,
  status text not null check (status in ('in_progress','completed')),
  claim_token text not null,
  lease_expires_at timestamptz not null,
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (actor_id, project_id, operation, idempotency_key),
  check ((status = 'completed') = (response_status is not null and response_body is not null))
);
create index if not exists task_idempotency_records_lease_idx on task_idempotency_records (lease_expires_at) where status = 'in_progress';
