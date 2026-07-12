alter table agent_tasks
  add column if not exists title text,
  add column if not exists input_paths jsonb not null default '[]'::jsonb,
  add column if not exists active_reservation boolean not null default false,
  add column if not exists archived_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists terminal_reason text,
  add column if not exists start_delivery_key text,
  add column if not exists start_request_hash text,
  add column if not exists start_claim_token text,
  add column if not exists start_receipt jsonb,
  add column if not exists start_timeline_cursor text;
update agent_tasks
set title = left(regexp_replace(prompt, E'[\\n\\r]+', ' ', 'g'), 160)
where title is null;
alter table agent_tasks alter column title set not null;
update agent_tasks
set active_reservation = true
where status in ('queued','starting','running','stopping');
update agent_tasks
set terminal_reason = case status
  when 'completed' then case when execution_mode = 'dry-run' then 'not_executed' else 'completed' end
  when 'failed' then 'failed'
  when 'cancelled' then 'cancelled'
  when 'expired' then 'expired'
  when 'cleaned' then 'cleaned_legacy'
  else terminal_reason
end
where terminal_reason is null;
alter table agent_tasks drop constraint if exists agent_tasks_terminal_reason_check;
alter table agent_tasks add constraint agent_tasks_terminal_reason_check check (terminal_reason is null or terminal_reason in ('completed','failed','cancelled','expired','not_executed','cleaned_legacy'));
create unique index if not exists agent_tasks_start_delivery_key_idx on agent_tasks (start_delivery_key) where start_delivery_key is not null;
alter table task_follow_ups add column if not exists delivery_key text, add column if not exists request_hash text, add column if not exists claim_token text, add column if not exists receipt jsonb, add column if not exists timeline_cursor text;
create unique index if not exists task_follow_ups_delivery_key_idx on task_follow_ups (delivery_key) where delivery_key is not null;
