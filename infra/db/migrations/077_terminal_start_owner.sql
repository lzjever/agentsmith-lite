alter table task_idempotency_records
  add column if not exists terminal_task_id text references agent_tasks(id) on delete cascade;

update task_idempotency_records as receipt
   set terminal_task_id=run.task_id
  from sandbox_runs as run
 where receipt.operation='terminal-start'
   and receipt.resource_id=run.run_id
   and receipt.terminal_task_id is null;

update task_idempotency_records as receipt
   set status='completed',
       response_status=200,
       response_body=jsonb_build_object(
         'outcome','completed',
         'keyDisposition','retire',
         'runId',run.run_id
       ),
       updated_at=greatest(receipt.updated_at,now())
  from agent_tasks as task
  join sandbox_runs as run on run.run_id=task.current_run_id
 where receipt.operation='terminal-start'
   and receipt.status='in_progress'
   and receipt.terminal_task_id=task.id
   and receipt.resource_id=run.run_id
   and run.state='active';

update task_idempotency_records as receipt
   set status='completed',
       response_status=502,
       response_body=jsonb_build_object(
         'outcome','completed',
         'keyDisposition','retire',
         'runId',run.run_id,
         'error',jsonb_build_object(
           'code','sandbox_start_failed',
           'message','Sandbox could not be started',
           'retryable',true,
           'details',null,
           'presentation',null
         )
       ),
       updated_at=greatest(receipt.updated_at,now())
  from agent_tasks as task
  join sandbox_runs as run on run.run_id=task.current_run_id
 where receipt.operation='terminal-start'
   and receipt.status='in_progress'
   and receipt.terminal_task_id=task.id
   and receipt.resource_id=run.run_id
   and run.state in ('release_requested','failed','released');

with ranked as (
  select receipt.actor_id,receipt.project_id,receipt.operation,receipt.idempotency_key,
         receipt.terminal_task_id,
         task.current_run_id,
         run.state as run_state,
         row_number() over (
           partition by receipt.terminal_task_id
           order by
             case when receipt.resource_id=task.current_run_id and run.state='starting' then 0 else 1 end,
             receipt.created_at,
             receipt.idempotency_key collate "C"
         ) as owner_rank
    from task_idempotency_records as receipt
    left join agent_tasks as task on task.id=receipt.terminal_task_id
    left join sandbox_runs as run on run.run_id=receipt.resource_id
   where receipt.operation='terminal-start' and receipt.status='in_progress'
)
update task_idempotency_records as receipt
   set status='completed',
       response_status=409,
       response_body=jsonb_build_object(
         'outcome','rejected_before_acceptance',
         'keyDisposition','retire',
         'error',case
           when ranked.terminal_task_id is not null
             then 'Terminal start is already in progress for this Task'
           else 'Terminal start ownership could not be recovered'
         end,
         'code',case
           when ranked.terminal_task_id is not null
             then 'terminal_start_already_in_progress'
           else 'terminal_start_owner_unavailable'
         end
       ),
       updated_at=greatest(receipt.updated_at,now())
  from ranked
 where receipt.actor_id=ranked.actor_id
   and receipt.project_id=ranked.project_id
   and receipt.operation=ranked.operation
   and receipt.idempotency_key=ranked.idempotency_key
   and (
     ranked.terminal_task_id is null
     or ranked.current_run_id is null
     or ranked.run_state is distinct from 'starting'
     or receipt.resource_id is distinct from ranked.current_run_id
     or ranked.owner_rank>1
   );

drop index if exists task_idempotency_terminal_start_owner_unique;
create unique index task_idempotency_terminal_start_owner_unique
  on task_idempotency_records (terminal_task_id)
  where operation='terminal-start' and status='in_progress';
