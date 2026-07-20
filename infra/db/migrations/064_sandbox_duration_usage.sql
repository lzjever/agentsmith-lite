alter table project_audit_events add column if not exists subject_user_id text;
create index if not exists project_audit_events_subject_page_idx
  on project_audit_events(project_id, subject_user_id, created_at desc, id desc);

alter table project_audit_events drop constraint if exists project_audit_events_action_check;
alter table project_audit_events add constraint project_audit_events_action_check check (action in (
  'project.settings.update','project.archive','project.unarchive','project.owner.transfer','project.delete',
  'policy.update','credential.create','credential.rotate','credential.delete',
  'endpoint.create','endpoint.update','endpoint.delete','endpoint.health_check','endpoint.model_discover',
  'membership.add','membership.change','membership.remove','provider.request',
  'chat.thread.create','chat.thread.update','chat.thread.delete','chat.message.send','chat.message.retry','chat.message.stop','chat.message.edit','chat.message.delete','chat.message.branch',
  'task.create','task.edit','task.archive','task.delete','task.message.create','task.message.edit','task.message.delete','task.cancel','task.completed','task.failed','task.expired','task.cleaned',
  'artifact.project','sandbox.started','sandbox.failed','sandbox.release_requested','sandbox.released','file.upload','file.delete','file.quota',
  'alert.resolve','alert.dismiss','alert.rule.create','alert.rule.update','alert.rule.delete','alert.acknowledge','alert.silence'
));

-- Existing local runs predate immutable attribution. Active runs that had
-- crossed readiness use their last persisted transition as a conservative
-- accrual start; startup-only runs remain unstarted and accrue zero.
update postgres_json_docs run
set document = run.document || jsonb_build_object(
      'fileLibraryId', task.file_library_id,
      'startedByUserId', coalesce(task.created_by_user_id, project.owner_user_id),
      'startedAt', case
        when run.document ? 'startedAt' then run.document->'startedAt'
        when run.document->>'phase' in ('running','stopping','expired')
          or (run.document ? 'terminalFailure' and run.document->'terminalFailure' <> 'null'::jsonb)
          then to_jsonb(run.document->>'updatedAt')
        else 'null'::jsonb
      end,
      'releaseReason', case when run.document->>'releaseReason'='expired' then to_jsonb('legacy_cleaned'::text) else run.document->'releaseReason' end,
      'resourceSnapshot', jsonb_build_object(
        'cpuRequestMillis', (case
          when run.document#>>'{resourceLimits,cpuRequest}' ~ '^[0-9]+([.][0-9]+)?m$' then trim(trailing 'm' from run.document#>>'{resourceLimits,cpuRequest}')::numeric
          else (run.document#>>'{resourceLimits,cpuRequest}')::numeric * 1000
        end)::text,
        'memoryRequestBytes', (case
          when run.document#>>'{resourceLimits,memoryRequest}' ~ '^[0-9]+Mi$' then trim(trailing 'Mi' from run.document#>>'{resourceLimits,memoryRequest}')::bigint * 1048576
          when run.document#>>'{resourceLimits,memoryRequest}' ~ '^[0-9]+Gi$' then trim(trailing 'Gi' from run.document#>>'{resourceLimits,memoryRequest}')::bigint * 1073741824
          when run.document#>>'{resourceLimits,memoryRequest}' ~ '^[0-9]+Ki$' then trim(trailing 'Ki' from run.document#>>'{resourceLimits,memoryRequest}')::bigint * 1024
          else (run.document#>>'{resourceLimits,memoryRequest}')::bigint
        end)::text,
        'cpuLimitMillis', (case
          when run.document#>>'{resourceLimits,cpuLimit}' ~ '^[0-9]+([.][0-9]+)?m$' then trim(trailing 'm' from run.document#>>'{resourceLimits,cpuLimit}')::numeric
          else (run.document#>>'{resourceLimits,cpuLimit}')::numeric * 1000
        end)::text,
        'memoryLimitBytes', (case
          when run.document#>>'{resourceLimits,memoryLimit}' ~ '^[0-9]+Mi$' then trim(trailing 'Mi' from run.document#>>'{resourceLimits,memoryLimit}')::bigint * 1048576
          when run.document#>>'{resourceLimits,memoryLimit}' ~ '^[0-9]+Gi$' then trim(trailing 'Gi' from run.document#>>'{resourceLimits,memoryLimit}')::bigint * 1073741824
          when run.document#>>'{resourceLimits,memoryLimit}' ~ '^[0-9]+Ki$' then trim(trailing 'Ki' from run.document#>>'{resourceLimits,memoryLimit}')::bigint * 1024
          else (run.document#>>'{resourceLimits,memoryLimit}')::bigint
        end)::text
      )
    ),
    updated_at = now()
from agent_tasks task
join projects project on project.id = task.project_id
where run.collection = 'sandbox_run_state'
  and task.run_id = run.id
  and task.file_library_id is not null
  and run.document->>'taskId' = task.id;

create table sandbox_usage_settlements (
  run_id text primary key,
  workspace_id text not null,
  project_id text not null,
  task_id text not null,
  file_library_id text not null,
  started_by_user_id text not null,
  started_at timestamptz,
  released_at timestamptz not null,
  duration_seconds double precision not null check (duration_seconds >= 0),
  cpu_request_millis numeric(30,0) not null check (cpu_request_millis >= 0),
  memory_request_bytes bigint not null check (memory_request_bytes >= 0),
  cpu_limit_millis numeric(30,0) not null check (cpu_limit_millis >= 0),
  memory_limit_bytes bigint not null check (memory_limit_bytes >= 0),
  release_reason text not null check (release_reason in ('requested','failed','cleanup','legacy_cleaned'))
);
create index sandbox_usage_settlements_project_user_idx
  on sandbox_usage_settlements(project_id, started_by_user_id, released_at desc, run_id desc);

insert into sandbox_usage_settlements (
  run_id,workspace_id,project_id,task_id,file_library_id,started_by_user_id,
  started_at,released_at,duration_seconds,cpu_request_millis,memory_request_bytes,cpu_limit_millis,memory_limit_bytes,release_reason
)
select run.id,run.document->>'workspaceId',run.document->>'projectId',run.document->>'taskId',
       run.document->>'fileLibraryId',run.document->>'startedByUserId',
       null,(run.document->>'updatedAt')::timestamptz,0,
       (run.document#>>'{resourceSnapshot,cpuRequestMillis}')::numeric,
       (run.document#>>'{resourceSnapshot,memoryRequestBytes}')::bigint,
       (run.document#>>'{resourceSnapshot,cpuLimitMillis}')::numeric,
       (run.document#>>'{resourceSnapshot,memoryLimitBytes}')::bigint,
       'legacy_cleaned'
from postgres_json_docs run
where run.collection='sandbox_run_state'
  and (run.document->>'cleanupStatus'='cleaned' or run.document->>'phase'='cleaned')
on conflict (run_id) do nothing;

update project_audit_events event
set subject_user_id = coalesce(task.created_by_user_id, project.owner_user_id)
from agent_tasks task
join projects project on project.id=task.project_id
where event.resource_kind='sandbox'
  and event.resource_id=task.id
  and event.subject_user_id is null;

create function reject_sandbox_usage_settlement_change() returns trigger language plpgsql as $$
begin
  raise exception 'sandbox usage settlements are immutable';
end;
$$;
create trigger sandbox_usage_settlements_immutable
before update or delete on sandbox_usage_settlements
for each row execute function reject_sandbox_usage_settlement_change();
