do $$
declare
  overloaded_projects text;
begin
  select string_agg(project_id || ':' || rule_count::text, ', ' order by project_id)
    into overloaded_projects
    from (
      select project_id, count(*) as rule_count
      from project_alert_rules
      where alert_type <> 'historical_task_failure'
      group by project_id
      having count(*) > 50
    ) overloaded;
  if overloaded_projects is not null then
    raise exception 'Project alert rule limit exceeded: %', overloaded_projects
      using errcode = '23514';
  end if;
end
$$;

delete from project_alerts where type = 'historical_task_failure';
delete from project_alert_rules where alert_type = 'historical_task_failure';

update project_alert_rules
set window_seconds = case
  when metric in ('active_tasks', 'project_file_bytes') then null
  else coalesce(window_seconds, 3600)
end;

alter table project_alerts drop constraint if exists project_alerts_type_check;
alter table project_alerts drop constraint if exists project_alerts_historical_status_check;
alter table project_alert_rules drop constraint if exists project_alert_rules_alert_type_check;
alter table project_alert_rules drop constraint if exists project_alert_rules_retired_state_check;
alter table project_alert_rules drop constraint if exists project_alert_rules_window_check;

alter table project_alert_rules drop column retired_was_enabled;

alter table project_alerts add constraint project_alerts_type_check check (type in (
  'active_tasks_limit','provider_requests_limit','provider_tokens_limit','provider_cost_limit',
  'project_file_bytes_limit','endpoint_failure','provider_failure','sandbox_failure'
));

alter table project_alert_rules add constraint project_alert_rules_alert_type_check check (alert_type in (
  'active_tasks_limit','provider_requests_limit','provider_tokens_limit','provider_cost_limit',
  'project_file_bytes_limit','endpoint_failure','provider_failure','sandbox_failure'
));
alter table project_alert_rules add constraint project_alert_rules_metric_type_check check (
  (alert_type = 'active_tasks_limit' and metric = 'active_tasks')
  or (alert_type = 'provider_requests_limit' and metric = 'provider_requests')
  or (alert_type = 'provider_tokens_limit' and metric = 'provider_tokens')
  or (alert_type = 'provider_cost_limit' and metric = 'provider_cost')
  or (alert_type = 'project_file_bytes_limit' and metric = 'project_file_bytes')
  or (alert_type in ('endpoint_failure','provider_failure','sandbox_failure') and metric = 'failure_count')
);
alter table project_alert_rules add constraint project_alert_rules_window_check check (
  (metric in ('active_tasks','project_file_bytes') and window_seconds is null)
  or (
    metric in ('provider_requests','provider_tokens','provider_cost','failure_count')
    and window_seconds between 60 and 2592000
  )
);
alter table project_alert_rules add constraint project_alert_rules_scope_type_check check (
  alert_type not in ('active_tasks_limit','project_file_bytes_limit') or scope_kind = 'project'
);

create index project_alert_rules_project_page_idx
  on project_alert_rules(project_id, created_at, id collate "C");
create index project_alerts_active_page_idx
  on project_alerts(project_id, created_at desc, id collate "C" desc)
  where status = 'active';
create index project_alerts_history_page_idx
  on project_alerts(project_id, created_at desc, id collate "C" desc)
  where status in ('resolved','dismissed');
