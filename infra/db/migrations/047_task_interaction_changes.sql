do $$
begin
  if to_regclass('public.task_follow_ups') is not null and to_regclass('public.task_messages') is null then
    alter table task_follow_ups rename to task_messages;
  end if;
end $$;

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='task_messages' and column_name='prompt') then
    alter table task_messages rename column prompt to content;
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='task_messages' and column_name='follow_up_task_id') then
    alter table task_messages rename column follow_up_task_id to target_task_id;
  end if;
end $$;

drop index if exists task_follow_ups_delivery_key_idx;
drop index if exists task_follow_ups_delivery_due_idx;
drop index if exists task_follow_ups_follow_up_task_id_idx;
create unique index task_messages_delivery_key_idx on task_messages (delivery_key) where delivery_key is not null;
create index task_messages_delivery_due_idx on task_messages (next_retry_at, lease_expires_at, created_at)
  where delivery_status in ('pending','dispatching','terminal_pending') and deleted_at is null;
create index task_messages_target_task_id_idx on task_messages (target_task_id) where target_task_id is not null;

alter table task_messages drop constraint if exists task_follow_ups_delivery_status_check;
alter table task_messages drop constraint if exists task_follow_ups_terminal_outcome_check;
alter table task_messages add constraint task_messages_delivery_status_check
  check (delivery_status in ('pending','dispatching','terminal_pending','accepted','successor_created','failed'));
alter table task_messages add constraint task_messages_terminal_outcome_check check (
  (delivery_status <> 'accepted' or target_task_id is null) and
  (delivery_status <> 'successor_created' or target_task_id is not null)
);

alter table agent_tasks
  add column interaction_source_cursor text,
  add column interaction_history_status text not null default 'gap',
  add column interaction_last_synced_at timestamptz;
alter table agent_tasks add constraint agent_tasks_interaction_history_status_check
  check (interaction_history_status in ('complete','gap'));

create table task_interaction_changes (
  task_id text not null references agent_tasks(id) on delete cascade,
  change_seq bigint not null,
  source_kind text not null,
  source_id text not null,
  source_revision integer not null,
  interaction_id text not null,
  revision integer not null,
  position bigint not null,
  interaction_kind text not null,
  interaction jsonb not null,
  tool_call_id text,
  work_task_id text,
  callback_id text,
  occurred_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (task_id, change_seq),
  constraint task_interaction_changes_source_kind_check check (source_kind in ('botified','product')),
  constraint task_interaction_changes_source_identity_check check (length(source_id) > 0 and source_revision >= 0 and (source_kind <> 'botified' or source_revision = 0)),
  constraint task_interaction_changes_sequence_check check (change_seq > 0 and revision > 0 and position >= 0),
  constraint task_interaction_changes_kind_check check (interaction_kind in ('user_message','assistant_message','tool','background_task','task_question','task_notice','task_result','subagent_result','file','execution_boundary','system_error')),
  constraint task_interaction_changes_item_check check (
    jsonb_typeof(interaction) = 'object' and
    interaction @> jsonb_build_object('id',interaction_id,'taskId',task_id,'revision',revision,'position',position,'kind',interaction_kind)
  ),
  constraint task_interaction_changes_source_unique unique (task_id, source_kind, source_id, source_revision),
  constraint task_interaction_changes_revision_unique unique (task_id, interaction_id, revision)
);

create index task_interaction_changes_latest_idx
  on task_interaction_changes (task_id, interaction_id, revision desc, change_seq desc);
create index task_interaction_changes_history_idx
  on task_interaction_changes (task_id, position desc, interaction_id desc, change_seq desc);
create index task_interaction_changes_tool_call_idx
  on task_interaction_changes (task_id, tool_call_id, change_seq desc) where tool_call_id is not null;
create index task_interaction_changes_work_task_idx
  on task_interaction_changes (task_id, work_task_id, change_seq desc) where work_task_id is not null;
create index task_interaction_changes_callback_idx
  on task_interaction_changes (task_id, callback_id, change_seq desc) where callback_id is not null;

alter table project_audit_events drop constraint if exists project_audit_events_action_check;
update project_audit_events set action='task.message.create' where action='task.follow_up.create';
update project_audit_events set action='task.message.edit' where action='task.follow_up.edit';
update project_audit_events set action='task.message.delete' where action='task.follow_up.delete';
update project_audit_events set detail=(detail-'followUpId')||jsonb_build_object('messageId',detail->'followUpId') where detail ? 'followUpId';
update task_idempotency_records set operation='message' where operation='follow-up';
update task_idempotency_records set operation='message-edit' where operation='follow-up-edit';
update task_idempotency_records set operation='message-delete' where operation='follow-up-delete';
alter table project_audit_events add constraint project_audit_events_action_check check (action in (
  'project.settings.update','project.archive','project.unarchive','project.owner.transfer','project.delete',
  'policy.update','credential.create','credential.rotate','credential.delete',
  'endpoint.create','endpoint.update','endpoint.delete','endpoint.health_check','endpoint.model_discover',
  'membership.add','membership.change','membership.remove','provider.request',
  'chat.thread.create','chat.thread.update','chat.thread.delete','chat.message.send','chat.message.retry','chat.message.stop','chat.message.edit','chat.message.delete','chat.message.branch',
  'task.create','task.edit','task.archive','task.delete','task.message.create','task.message.edit','task.message.delete','task.cancel','task.completed','task.failed','task.expired','task.cleaned',
  'artifact.project','sandbox.failed','file.upload','file.delete','file.quota',
  'alert.resolve','alert.dismiss','alert.rule.create','alert.rule.update','alert.rule.delete','alert.acknowledge','alert.silence'
));

drop table agent_task_events;
