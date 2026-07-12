alter table project_audit_events drop constraint if exists project_audit_events_action_check;
alter table project_audit_events
  add constraint project_audit_events_action_check check (
    action in ('policy.update', 'endpoint.create', 'endpoint.update', 'endpoint.delete', 'membership.add', 'membership.change', 'membership.remove', 'provider.request', 'task.create', 'task.cancel', 'task.completed', 'task.failed', 'task.expired', 'task.cleaned', 'artifact.project', 'sandbox.failed', 'file.quota', 'alert.resolve', 'alert.dismiss')
  );

alter table project_audit_events drop constraint if exists project_audit_events_resource_kind_check;
alter table project_audit_events
  add constraint project_audit_events_resource_kind_check check (
    resource_kind in ('project', 'endpoint', 'member', 'task', 'artifact', 'provider', 'file_quota', 'sandbox', 'alert')
  );

alter table user_notifications drop constraint if exists user_notifications_resource_kind_check;
alter table user_notifications
  add constraint user_notifications_resource_kind_check check (
    resource_kind is null or resource_kind in ('project', 'endpoint', 'member', 'task', 'artifact', 'provider', 'file_quota', 'sandbox', 'alert')
  );
