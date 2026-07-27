alter table task_idempotency_records
  add column if not exists expected_run_id text,
  add column if not exists interaction_id text,
  add column if not exists downstream_command_key text,
  add column if not exists downstream_target_id text;

delete from task_idempotency_records
where operation in ('abort-turn','work-stop');

alter table task_idempotency_records
  drop constraint if exists task_idempotency_exact_control_envelope_check;

alter table task_idempotency_records
  add constraint task_idempotency_exact_control_envelope_check check (
    operation not in ('abort-turn','work-stop')
    or (
      expected_run_id is not null
      and downstream_command_key is not null
      and downstream_target_id is not null
      and (
        operation='abort-turn' and interaction_id is null
        or operation='work-stop' and interaction_id is not null
      )
    )
  );

create index if not exists task_idempotency_exact_control_pending_idx
  on task_idempotency_records (expected_run_id, created_at)
  where operation in ('abort-turn','work-stop') and status='in_progress';
