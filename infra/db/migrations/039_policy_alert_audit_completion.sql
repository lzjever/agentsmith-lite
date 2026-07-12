alter table project_provider_settlements add column actor_id text references users(id) on delete set null;
alter table project_provider_settlements add column reserved_tokens bigint not null default 0 check (reserved_tokens >= 0);
alter table project_provider_settlements add column reserved_cost double precision not null default 0 check (reserved_cost >= 0);

create table project_endpoint_policy_windows (
  project_id text not null references projects(id) on delete cascade,
  endpoint_id text not null references model_endpoints(id) on delete cascade,
  metric text not null check (metric in ('providerRequests','providerTokens','providerCost')),
  limit_value double precision not null check (limit_value >= 0),
  window_seconds integer not null check (window_seconds between 60 and 2592000),
  primary key (project_id, endpoint_id, metric)
);

alter table project_alert_rules add column name text;
alter table project_alert_rules add column metric text;
alter table project_alert_rules add column condition text;
alter table project_alert_rules add column threshold double precision;
alter table project_alert_rules add column window_seconds integer;
alter table project_alert_rules add column scope_kind text;
alter table project_alert_rules add column endpoint_id text references model_endpoints(id) on delete cascade;
update project_alert_rules set name=replace(alert_type,'_',' '), metric=case alert_type when 'active_tasks_limit' then 'active_tasks' when 'provider_requests_limit' then 'provider_requests' when 'provider_tokens_limit' then 'provider_tokens' when 'provider_cost_limit' then 'provider_cost' when 'project_file_bytes_limit' then 'project_file_bytes' else 'failure_count' end, condition='greater_than_or_equal', threshold=1, scope_kind='project';
alter table project_alert_rules alter column name set not null;
alter table project_alert_rules alter column metric set not null;
alter table project_alert_rules alter column condition set not null;
alter table project_alert_rules alter column threshold set not null;
alter table project_alert_rules alter column scope_kind set not null;
alter table project_alert_rules add constraint project_alert_rules_metric_check check (metric in ('active_tasks','provider_requests','provider_tokens','provider_cost','project_file_bytes','failure_count'));
alter table project_alert_rules add constraint project_alert_rules_condition_check check (condition='greater_than_or_equal');
alter table project_alert_rules add constraint project_alert_rules_threshold_check check (threshold >= 0);
alter table project_alert_rules add constraint project_alert_rules_window_check check (window_seconds is null or window_seconds between 60 and 2592000);
alter table project_alert_rules add constraint project_alert_rules_scope_check check ((scope_kind='project' and endpoint_id is null) or (scope_kind='endpoint' and endpoint_id is not null));

alter table project_alerts add column rule_id text references project_alert_rules(id) on delete set null;
alter table project_alerts add column metric text;
alter table project_alerts add column metric_value double precision;
alter table project_alerts add column threshold double precision;
alter table project_alerts add column endpoint_id text references model_endpoints(id) on delete set null;
alter table project_alerts add column acknowledged_at timestamptz;
alter table project_alerts add column acknowledged_by text references users(id) on delete set null;
alter table project_alerts add column silenced_until timestamptz;
drop index project_alerts_one_active_per_type_unique;
create unique index project_alerts_one_active_per_rule_scope_unique on project_alerts(project_id,type,coalesce(rule_id,''),coalesce(endpoint_id,'')) where status='active';

alter table project_audit_events add column detail jsonb not null default '{}'::jsonb;
alter table project_audit_events drop constraint project_audit_events_action_check;
alter table project_audit_events add constraint project_audit_events_action_check check (action in ('policy.update','endpoint.create','endpoint.update','endpoint.delete','membership.add','membership.change','membership.remove','provider.request','chat.thread.create','chat.thread.update','chat.thread.delete','chat.message.edit','chat.message.delete','chat.message.branch','task.create','task.edit','task.archive','task.delete','task.follow_up.create','task.follow_up.edit','task.follow_up.delete','task.cancel','task.completed','task.failed','task.expired','task.cleaned','artifact.project','sandbox.failed','file.quota','alert.resolve','alert.dismiss','alert.rule.create','alert.rule.update','alert.rule.delete','alert.acknowledge','alert.silence'));
create index project_audit_events_page_idx on project_audit_events(project_id, created_at desc, id desc);
create index project_provider_settlements_usage_idx on project_provider_settlements(project_id, endpoint_id, actor_id, settled_at) where status='settled';
