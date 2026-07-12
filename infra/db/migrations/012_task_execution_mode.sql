alter table agent_tasks
  add column if not exists execution_mode text;

update agent_tasks
set execution_mode = 'dry-run'
where execution_mode is null;

alter table agent_tasks
  alter column execution_mode set default 'dry-run',
  alter column execution_mode set not null;

alter table agent_tasks
  drop constraint if exists agent_tasks_execution_mode_check;

alter table agent_tasks
  add constraint agent_tasks_execution_mode_check
  check (execution_mode in ('dry-run', 'live'));
