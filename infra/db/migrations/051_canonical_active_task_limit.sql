update project_resource_policies policy
set active_tasks_limit = project.task_concurrency_limit,
    updated_at = greatest(policy.updated_at, project.updated_at)
from projects project
where policy.project_id = project.id
  and policy.active_tasks_limit is null;

update projects project
set task_concurrency_limit = policy.active_tasks_limit,
    updated_at = greatest(project.updated_at, policy.updated_at)
from project_resource_policies policy
where project.id = policy.project_id
  and project.task_concurrency_limit is distinct from policy.active_tasks_limit;

alter table project_resource_policies
  alter column active_tasks_limit set not null;
