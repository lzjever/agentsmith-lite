alter table agent_tasks add column if not exists terminalized_at timestamptz;
update agent_tasks set terminalized_at = updated_at where terminal_reason is not null and terminalized_at is null;
alter table agent_tasks drop constraint if exists agent_tasks_terminal_reason_status_check;
alter table agent_tasks add constraint agent_tasks_terminal_reason_status_check check (
  terminal_reason is null or (
    terminalized_at is not null and (
      (terminal_reason in ('completed','not_executed') and status = 'completed') or
      (terminal_reason = 'failed' and status = 'failed') or
      (terminal_reason = 'cancelled' and status = 'cancelled') or
      (terminal_reason = 'expired' and status = 'expired') or
      (terminal_reason = 'cleaned_legacy' and status = 'cleaned')
    )
  )
);
alter table task_follow_ups drop constraint if exists task_follow_ups_terminal_outcome_check;
alter table task_follow_ups add constraint task_follow_ups_terminal_outcome_check check (
  (delivery_status <> 'accepted' or follow_up_task_id is null) and
  (delivery_status <> 'successor_created' or follow_up_task_id is not null)
);
create index if not exists agent_tasks_terminalized_at_idx on agent_tasks (project_id, terminalized_at) where terminalized_at is not null;
create index if not exists agent_tasks_project_list_idx on agent_tasks (project_id, archived_at, updated_at desc, id desc) where deleted_at is null;
create index if not exists agent_tasks_project_status_idx on agent_tasks (project_id, status, updated_at desc, id desc) where deleted_at is null;
create index if not exists agent_task_events_transcript_idx on agent_task_events (task_id, botified_seq, created_at, id);
