-- Phase 3 turns every non-deleted Task into a reusable conversation. Preserve
-- durable content while removing Phase 2's Task-terminal delivery gates.

delete from task_idempotency_records where operation = 'cancel';

insert into task_messages (
  id, task_id, actor_id, content, delivery_key, request_hash, claim_token,
  receipt, timeline_cursor, delivery_status, claimed_at, lease_expires_at,
  attempt_count, next_retry_at, safe_error, created_at, updated_at, deleted_at
)
select
  task.id,
  task.id,
  task.created_by_user_id,
  task.prompt,
  'delivery_message_' || task.id,
  task.start_request_hash,
  null,
  case
    when task.start_receipt->>'accepted' = 'true' and task.start_request_hash is not null then
      jsonb_set(
        jsonb_set(task.start_receipt, '{deliveryKey}', to_jsonb('delivery_message_' || task.id)),
        '{requestHash}', to_jsonb(task.start_request_hash)
      )
    else null
  end,
  task.start_timeline_cursor,
  case
    when task.start_receipt->>'accepted' = 'true' and task.start_request_hash is not null then 'accepted'
    else 'failed'
  end,
  null,
  null,
  greatest(task.start_attempt_count, 0),
  null,
  case
    when task.start_receipt->>'accepted' = 'true' and task.start_request_hash is not null then null
    else 'Legacy initial delivery could not be confirmed safely'
  end,
  task.created_at,
  task.updated_at,
  null
from agent_tasks task
where task.deleted_at is null
  and not exists (
    select 1
    from task_messages message
    where message.id = task.id
      and message.task_id = task.id
  );

-- Accepted receipts remain durable, but their local idempotency identity is
-- normalized to the stable message identity. An unresolved Phase 2 claim is
-- failed closed because querying or resending it under a new key could duplicate
-- user work.
update task_messages
set delivery_key = 'delivery_message_' || id,
    receipt = case
      when delivery_status = 'accepted' and receipt is not null and request_hash is not null then
        jsonb_set(
          jsonb_set(receipt, '{deliveryKey}', to_jsonb('delivery_message_' || id)),
          '{requestHash}', to_jsonb(request_hash)
        )
      else receipt
    end,
    delivery_status = case when delivery_status = 'dispatching' then 'failed' else delivery_status end,
    claim_token = case when delivery_status = 'dispatching' then null else claim_token end,
    claimed_at = case when delivery_status = 'dispatching' then null else claimed_at end,
    lease_expires_at = case when delivery_status = 'dispatching' then null else lease_expires_at end,
    next_retry_at = case when delivery_status = 'dispatching' then null else next_retry_at end,
    safe_error = case
      when delivery_status = 'dispatching' then 'Legacy delivery claim could not be reconciled safely'
      else safe_error
    end
where deleted_at is null;

with sandbox_state as (
  select
    task.id as task_id,
    run.document is not null
      and coalesce(run.document->>'cleanupStatus', '') <> 'cleaned'
      and coalesce(run.document->>'phase', '') <> 'cleaned' as active
  from agent_tasks task
  left join postgres_json_docs run
    on run.collection = 'sandbox_run_state'
   and run.id = task.run_id
  where task.deleted_at is null
)
update agent_tasks task
set status = 'queued',
    terminal_reason = null,
    terminalized_at = null,
    active_reservation = sandbox_state.active,
    finalization_intent_status = null,
    finalization_intent_at = null,
    start_delivery_key = null,
    start_request_hash = null,
    start_claim_token = null,
    start_receipt = null,
    start_timeline_cursor = null,
    start_intent_status = null,
    start_claimed_at = null,
    start_lease_expires_at = null,
    start_next_retry_at = null,
    start_safe_error = null,
    updated_at = greatest(task.updated_at, now())
from sandbox_state
where task.id = sandbox_state.task_id;

update project_resource_usage usage
set active_tasks = (
      select count(*)::integer
      from agent_tasks task
      where task.project_id = usage.project_id
        and task.deleted_at is null
        and task.active_reservation = true
    ),
    updated_at = now();
