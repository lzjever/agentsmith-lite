alter table agent_tasks
  add column if not exists source_task_id text references agent_tasks(id) on delete restrict;

create index if not exists agent_tasks_source_task_id_idx on agent_tasks (source_task_id);

alter table task_follow_ups
  add column if not exists follow_up_task_id text references agent_tasks(id) on delete restrict;

create index if not exists task_follow_ups_follow_up_task_id_idx on task_follow_ups (follow_up_task_id);
