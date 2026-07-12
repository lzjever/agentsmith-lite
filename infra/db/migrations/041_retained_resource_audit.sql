alter table project_audit_events drop constraint if exists project_audit_events_action_check;
alter table project_audit_events drop constraint if exists project_audit_events_project_id_fkey;
alter table project_audit_events add constraint project_audit_events_action_check check (action in (
  'project.settings.update','project.archive','project.unarchive','project.owner.transfer','project.delete','policy.update',
  'credential.create','credential.rotate','credential.delete',
  'endpoint.create','endpoint.update','endpoint.delete','endpoint.health_check','endpoint.model_discover',
  'membership.add','membership.change','membership.remove','provider.request',
  'chat.thread.create','chat.thread.update','chat.thread.delete','chat.message.send','chat.message.retry','chat.message.stop','chat.message.edit','chat.message.delete','chat.message.branch',
  'task.create','task.edit','task.archive','task.delete','task.follow_up.create','task.follow_up.edit','task.follow_up.delete','task.cancel','task.completed','task.failed','task.expired','task.cleaned',
  'artifact.project','sandbox.failed','file.upload','file.delete','file.quota',
  'alert.resolve','alert.dismiss','alert.rule.create','alert.rule.update','alert.rule.delete','alert.acknowledge','alert.silence'
));

alter table project_audit_events drop constraint if exists project_audit_events_resource_kind_check;
alter table project_audit_events add constraint project_audit_events_resource_kind_check check (
  resource_kind in ('project','credential','endpoint','member','task','artifact','provider','file','file_quota','sandbox','alert')
);

alter table user_notifications drop constraint if exists user_notifications_resource_kind_check;
alter table user_notifications add constraint user_notifications_resource_kind_check check (
  resource_kind is null or resource_kind in ('project','credential','endpoint','member','task','artifact','provider','file','file_quota','sandbox','alert')
);
