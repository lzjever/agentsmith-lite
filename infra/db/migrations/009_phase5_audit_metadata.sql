alter table project_alerts
  add constraint project_alerts_type_check check (type in ('active_tasks_limit', 'provider_requests_limit', 'provider_tokens_limit', 'provider_cost_limit', 'project_file_bytes_limit', 'endpoint_failure', 'provider_failure', 'task_failure', 'sandbox_failure'));

alter table project_audit_events add column resource_kind text;
update project_audit_events
set action = case action
  when 'sandbox.terminal' then 'sandbox.failed'
  when 'task.terminal' then 'task.cleaned'
  when 'task.complete' then 'task.cleaned'
  when 'file.write' then 'file.quota'
  else action
end;
update project_audit_events
set resource_kind = case
  when action like 'endpoint.%' then 'endpoint'
  when action like 'membership.%' then 'member'
  when action = 'provider.request' then 'provider'
  when action like 'task.%' then 'task'
  when action = 'artifact.project' then 'artifact'
  when action = 'sandbox.failed' then 'sandbox'
  when action = 'file.quota' then 'file_quota'
  else 'project'
end;
alter table project_audit_events alter column resource_kind set not null;
alter table project_audit_events
  add constraint project_audit_events_action_check check (action in ('policy.update', 'endpoint.create', 'endpoint.update', 'endpoint.delete', 'membership.add', 'membership.change', 'membership.remove', 'provider.request', 'task.create', 'task.cancel', 'task.completed', 'task.failed', 'task.expired', 'task.cleaned', 'artifact.project', 'sandbox.failed', 'file.quota')),
  add constraint project_audit_events_resource_kind_check check (resource_kind in ('project', 'endpoint', 'member', 'task', 'artifact', 'provider', 'file_quota', 'sandbox'));
