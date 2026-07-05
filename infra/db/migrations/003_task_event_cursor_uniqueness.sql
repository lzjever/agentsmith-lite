delete from agent_task_events e
using agent_task_events k
where e.task_id = k.task_id
  and e.cursor = k.cursor
  and (
    e.created_at > k.created_at
    or (e.created_at = k.created_at and e.id > k.id)
  );

alter table agent_task_events
  drop constraint if exists agent_task_events_task_id_botified_seq_key;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'agent_task_events'::regclass
      and conname = 'agent_task_events_task_id_cursor_key'
  ) then
    execute 'alter table agent_task_events add constraint agent_task_events_task_id_cursor_key unique (task_id, cursor)';
  end if;
end $$;
