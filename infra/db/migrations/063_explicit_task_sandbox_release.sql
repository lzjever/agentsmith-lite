-- Phase 4 removes deadline-driven sandbox reclamation. A live Task keeps its
-- reservation unless its identity-matched run is durably confirmed cleaned.

update postgres_json_docs
set document = document - 'expiresAt' - 'idleExpiresAt',
    updated_at = now()
where collection = 'sandbox_run_state'
  and (document ? 'expiresAt' or document ? 'idleExpiresAt');

alter table project_audit_events drop constraint if exists project_audit_events_action_check;
alter table project_audit_events add constraint project_audit_events_action_check check (action in (
  'project.settings.update','project.archive','project.unarchive','project.owner.transfer','project.delete',
  'policy.update','credential.create','credential.rotate','credential.delete',
  'endpoint.create','endpoint.update','endpoint.delete','endpoint.health_check','endpoint.model_discover',
  'membership.add','membership.change','membership.remove','provider.request',
  'chat.thread.create','chat.thread.update','chat.thread.delete','chat.message.send','chat.message.retry','chat.message.stop','chat.message.edit','chat.message.delete','chat.message.branch',
  'task.create','task.edit','task.archive','task.delete','task.message.create','task.message.edit','task.message.delete','task.cancel','task.completed','task.failed','task.expired','task.cleaned',
  'artifact.project','sandbox.failed','sandbox.release_requested','sandbox.released','file.upload','file.delete','file.quota',
  'alert.resolve','alert.dismiss','alert.rule.create','alert.rule.update','alert.rule.delete','alert.acknowledge','alert.silence'
));

update agent_tasks task
set active_reservation = case
      when task.execution_mode = 'live' then not exists (
        select 1
        from postgres_json_docs run
        where run.collection = 'sandbox_run_state'
          and run.id = task.run_id
          and run.document->>'taskId' = task.id
          and run.document->>'runId' = task.run_id
          and run.document->>'projectId' = task.project_id
          and run.document->>'workspaceId' = task.workspace_id
          and (
            run.document->>'cleanupStatus' = 'cleaned'
            or run.document->>'phase' = 'cleaned'
          )
      )
      else false
    end,
    updated_at = greatest(task.updated_at, now())
where task.deleted_at is null;

update project_resource_usage usage
set active_tasks = (
      select count(*)::integer
      from agent_tasks task
      where task.project_id = usage.project_id
        and task.deleted_at is null
        and task.active_reservation = true
    ),
    updated_at = now();

-- A prior deletion attempt may have persisted "deleting" before discovering
-- sandbox uncertainty. Restore the whole affected workspace surface so its
-- owner can explicitly release each sandbox and retry deletion.
with uncertain_projects as (
  select project.id, project.workspace_id
  from projects project
  where exists (
      select 1
      from agent_tasks task
      where task.project_id = project.id
        and task.deleted_at is null
        and task.execution_mode = 'live'
        and task.active_reservation = true
    )
    or exists (
      select 1
      from postgres_json_docs run
      where run.collection = 'sandbox_run_state'
        and run.document->>'projectId' = project.id
        and coalesce(run.document->>'cleanupStatus', '') <> 'cleaned'
        and coalesce(run.document->>'phase', '') <> 'cleaned'
    )
)
update projects project
set lifecycle_status = 'active',
    updated_at = greatest(project.updated_at, now())
where project.lifecycle_status = 'deleting'
  and project.id in (select id from uncertain_projects);

with uncertain_workspaces as (
  select distinct project.workspace_id
  from projects project
  where exists (
      select 1
      from agent_tasks task
      where task.project_id = project.id
        and task.deleted_at is null
        and task.execution_mode = 'live'
        and task.active_reservation = true
    )
    or exists (
      select 1
      from postgres_json_docs run
      where run.collection = 'sandbox_run_state'
        and run.document->>'projectId' = project.id
        and coalesce(run.document->>'cleanupStatus', '') <> 'cleaned'
        and coalesce(run.document->>'phase', '') <> 'cleaned'
    )
  union
  select distinct run.document->>'workspaceId'
  from postgres_json_docs run
  where run.collection = 'sandbox_run_state'
    and run.document->>'workspaceId' is not null
    and coalesce(run.document->>'cleanupStatus', '') <> 'cleaned'
    and coalesce(run.document->>'phase', '') <> 'cleaned'
)
update workspaces workspace
set lifecycle_status = 'active',
    updated_at = greatest(workspace.updated_at, now())
where workspace.lifecycle_status = 'deleting'
  and workspace.id in (select workspace_id from uncertain_workspaces);
