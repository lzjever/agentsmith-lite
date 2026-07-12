alter table user_profile_preferences
  add column if not exists bio text,
  add column if not exists job_title text,
  add column if not exists company text,
  add column if not exists greeting_preference text,
  add column if not exists interests text[] not null default '{}';

alter table workspaces drop constraint if exists workspaces_lifecycle_status_check;
alter table workspaces add constraint workspaces_lifecycle_status_check check (lifecycle_status in ('active', 'archived', 'deleting'));
alter table projects drop constraint if exists projects_lifecycle_status_check;
alter table projects add constraint projects_lifecycle_status_check check (lifecycle_status in ('active', 'archived', 'deleting'));
