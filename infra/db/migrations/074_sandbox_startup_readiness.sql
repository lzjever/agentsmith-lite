alter table sandbox_runs add column startup_ready_at timestamptz;
alter table sandbox_runs add column startup_action_deadline_at timestamptz;

update sandbox_runs
set startup_ready_at = updated_at
where state = 'active'
  and startup_ready_at is null;

update user_notifications notification
set title = 'Sandbox capacity reached',
    body = case
      when notification.body = project.name || ': Task capacity reached.'
        then project.name || ': Sandbox capacity reached.'
      when alert.threshold is null
        and notification.body = project.name || ': Active tasks ' || alert.metric_value::text || '.'
        then project.name || ': Active sandboxes ' || alert.metric_value::text || '.'
      when alert.threshold is not null
        and notification.body = project.name || ': Active tasks ' || alert.metric_value::text || ' of ' || alert.threshold::text || '.'
        then project.name || ': Active sandboxes ' || alert.metric_value::text || ' of ' || alert.threshold::text || '.'
      else notification.body
    end
from project_alerts alert, projects project
where notification.type = 'project_alert'
  and notification.resource_kind = 'alert'
  and notification.resource_id = alert.id
  and alert.project_id = project.id
  and alert.type = 'active_tasks_limit'
  and notification.title = 'Task capacity reached'
  and (
    notification.body = project.name || ': Task capacity reached.'
    or (
      alert.metric = 'active_tasks'
      and alert.metric_value is not null
      and (
        (
          alert.threshold is null
          and notification.body = project.name || ': Active tasks ' || alert.metric_value::text || '.'
        )
        or (
          alert.threshold is not null
          and notification.body = project.name || ': Active tasks ' || alert.metric_value::text || ' of ' || alert.threshold::text || '.'
        )
      )
    )
  );
