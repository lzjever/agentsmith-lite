delete from user_notifications notification
where notification.resource_kind = 'alert'
  and notification.resource_id is not null
  and not exists (
    select 1
    from project_alerts alert
    where alert.id = notification.resource_id
  );

alter table project_alerts add column subject_actor_id text;

update project_alerts
set status = 'resolved',
    resolved_at = coalesce(resolved_at, updated_at, created_at)
where status = 'active'
  and rule_id is null
  and endpoint_id is not null
  and type in ('provider_requests_limit','provider_tokens_limit','provider_cost_limit');

alter table project_alerts add constraint project_alerts_subject_actor_check check (
  subject_actor_id is null
  or (
    rule_id is null
    and endpoint_id is not null
    and type in ('provider_requests_limit','provider_tokens_limit','provider_cost_limit')
  )
);

drop index project_alerts_one_active_per_rule_scope_unique;
create unique index project_alerts_one_active_per_rule_scope_unique
  on project_alerts(
    project_id,
    type,
    coalesce(rule_id,''),
    coalesce(endpoint_id,''),
    coalesce(subject_actor_id,'')
  )
  where status = 'active';
