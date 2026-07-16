alter table agent_tasks
  add column if not exists created_by_user_id text references users(id) on delete set null;

alter table task_messages
  add column if not exists actor_id text references users(id) on delete set null;

update agent_tasks task
set created_by_user_id = (
  select event.actor_id
  from project_audit_events event
  where event.project_id = task.project_id
    and event.resource_id = task.id
    and event.action = 'task.create'
    and event.status = 'accepted'
    and event.actor_id is not null
  order by event.created_at, event.id
  limit 1
)
where task.created_by_user_id is null
  and exists (
    select 1
    from project_audit_events event
    where event.project_id = task.project_id
      and event.resource_id = task.id
      and event.action = 'task.create'
      and event.status = 'accepted'
      and event.actor_id is not null
  );

update task_messages message
set actor_id = (
  select event.actor_id
  from project_audit_events event
  join agent_tasks task on task.id = message.task_id
  where event.project_id = task.project_id
    and event.resource_id = message.task_id
    and event.action = 'task.message.create'
    and event.status = 'accepted'
    and event.detail->>'messageId' = message.id
    and event.actor_id is not null
  order by event.created_at, event.id
  limit 1
)
where message.actor_id is null;

update project_resource_usage usage
set active_tasks = (
      select count(*)::integer
      from agent_tasks task
      where task.project_id = usage.project_id
        and task.active_reservation = true
        and task.terminal_reason is null
    ),
    updated_at = now();
