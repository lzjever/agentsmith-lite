delete from user_notifications
where resource_kind in ('chat_thread', 'chat_message');

delete from project_audit_events
where action like 'chat.thread.%'
   or action like 'chat.message.%';

drop table if exists project_chat_messages;
drop table if exists project_chat_threads;

alter table project_audit_events
  drop constraint if exists project_audit_events_action_check;

alter table project_audit_events
  add constraint project_audit_events_action_check check (action in (
    'project.settings.update','project.archive','project.unarchive','project.owner.transfer','project.delete',
    'policy.update',
    'credential.create','credential.rotate','credential.delete',
    'endpoint.create','endpoint.update','endpoint.delete','endpoint.health_check','endpoint.model_discover',
    'membership.add','membership.change','membership.remove',
    'provider.request',
    'task.create','task.edit','task.archive','task.delete','task.message.create','task.message.edit','task.message.delete',
    'task.cancel','task.completed','task.failed','task.expired','task.cleaned',
    'artifact.project',
    'sandbox.started','sandbox.failed','sandbox.release_requested','sandbox.released',
    'file.upload','file.delete','file.quota',
    'alert.resolve','alert.dismiss','alert.rule.create','alert.rule.update','alert.rule.delete','alert.acknowledge','alert.silence'
  ));

alter table project_audit_events
  drop constraint if exists project_audit_events_resource_kind_check;

alter table project_audit_events
  add constraint project_audit_events_resource_kind_check check (
    resource_kind in ('project','credential','endpoint','member','task','artifact','provider','file','file_quota','sandbox','alert')
  );

alter table user_notifications
  drop constraint if exists user_notifications_resource_kind_check;

alter table user_notifications
  add constraint user_notifications_resource_kind_check check (
    resource_kind is null or resource_kind in ('project','credential','endpoint','member','task','artifact','provider','file','file_quota','sandbox','alert')
  );
