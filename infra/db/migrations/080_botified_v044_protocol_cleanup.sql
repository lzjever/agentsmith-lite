delete from task_idempotency_records
where operation in ('abort-turn','work-stop');

drop index if exists task_idempotency_exact_control_pending_idx;

alter table task_idempotency_records
  drop constraint if exists task_idempotency_exact_control_envelope_check,
  drop column if exists expected_run_id,
  drop column if exists interaction_id,
  drop column if exists downstream_command_key,
  drop column if exists downstream_target_id;

update task_messages
set delivery_status = 'failed',
    lease_expires_at = null,
    safe_error = 'Message delivery outcome is unknown; it was not sent again.',
    updated_at = now()
where delivery_status='dispatching';

drop index if exists task_messages_delivery_key_idx;
drop index if exists task_messages_delivery_due_idx;

alter table task_messages
  drop column if exists delivery_key,
  drop column if exists request_hash,
  drop column if exists receipt,
  drop column if exists timeline_cursor,
  drop column if exists attempt_count,
  drop column if exists next_retry_at;

create index task_messages_delivery_due_idx
  on task_messages (delivery_status,lease_expires_at,created_at,id)
  where delivery_status in ('pending','dispatching') and deleted_at is null;
