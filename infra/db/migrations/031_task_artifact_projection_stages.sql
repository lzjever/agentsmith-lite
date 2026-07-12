alter table agent_tasks
  add column if not exists artifact_projection_status text not null default 'pending',
  add column if not exists artifact_projection_error text,
  add column if not exists artifact_projection_claim_token text,
  add column if not exists artifact_projection_lease_expires_at timestamptz,
  add column if not exists artifact_projection_attempt_count integer not null default 0,
  add column if not exists artifact_projection_next_retry_at timestamptz,
  add column if not exists cleanup_status text not null default 'pending',
  add column if not exists cleanup_error text,
  add column if not exists cleanup_claim_token text,
  add column if not exists cleanup_lease_expires_at timestamptz,
  add column if not exists cleanup_attempt_count integer not null default 0,
  add column if not exists cleanup_next_retry_at timestamptz,
  add column if not exists cleanup_completed_at timestamptz;
alter table agent_tasks drop constraint if exists agent_tasks_artifact_projection_status_check;
alter table agent_tasks add constraint agent_tasks_artifact_projection_status_check check (artifact_projection_status in ('pending','draining','drained','failed'));
alter table agent_tasks drop constraint if exists agent_tasks_cleanup_status_check;
alter table agent_tasks add constraint agent_tasks_cleanup_status_check check (cleanup_status in ('pending','running','completed','failed'));
update agent_tasks
set artifact_projection_status = 'drained',
    cleanup_status = 'completed',
    cleanup_completed_at = updated_at
where terminal_reason is not null
  and artifact_projection_status = 'pending'
  and cleanup_status = 'pending';
create index if not exists agent_tasks_artifact_projection_due_idx on agent_tasks (artifact_projection_next_retry_at, artifact_projection_lease_expires_at, updated_at) where artifact_projection_status in ('draining','failed');
create index if not exists agent_tasks_cleanup_due_idx on agent_tasks (cleanup_next_retry_at, cleanup_lease_expires_at, updated_at) where cleanup_status in ('pending','running','failed');
