alter table project_alerts drop constraint if exists project_alerts_status_check;
alter table project_alerts drop constraint if exists project_alerts_project_id_type_status_key;

alter table project_alerts
  add column if not exists delivery_status text not null default 'not_configured',
  add column if not exists resolved_at timestamptz,
  add column if not exists dismissed_at timestamptz;

alter table project_alerts
  add constraint project_alerts_status_check check (status in ('active', 'resolved', 'dismissed')),
  add constraint project_alerts_delivery_status_check check (delivery_status in ('not_configured', 'pending', 'delivered', 'failed'));

create unique index if not exists project_alerts_one_active_per_type_unique
  on project_alerts (project_id, type)
  where status = 'active';
