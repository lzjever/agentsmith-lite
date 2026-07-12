alter table user_notifications
  add column if not exists body text,
  add column if not exists project_id text,
  add column if not exists resource_kind text,
  add column if not exists resource_id text;

alter table user_notifications drop constraint if exists user_notifications_resource_kind_check;
alter table user_notifications
  add constraint user_notifications_resource_kind_check check (
    resource_kind is null or resource_kind in ('project', 'endpoint', 'member', 'task', 'artifact', 'provider', 'file_quota', 'sandbox')
  );
