-- Phase 3 is an intentional local-development cutover. Task-owned runtime
-- history may be discarded, while identities, configuration, File Libraries,
-- and Library files remain.

do $$
declare
  alias_backed_count bigint;
  alias_free_count bigint;
  alias_backed_samples text;
  alias_free_samples text;
begin
  select count(*) into alias_backed_count
  from model_endpoints
  where credential_id is null
    and nullif(btrim(api_key_secret_ref), '') is not null;

  select count(*) into alias_free_count
  from model_endpoints
  where credential_id is null
    and nullif(btrim(api_key_secret_ref), '') is null;

  if alias_backed_count + alias_free_count > 0 then
    select coalesce(string_agg(sample_id, ', ' order by sample_id), 'none')
    into alias_backed_samples
    from (
      select left(regexp_replace(id, '[^A-Za-z0-9._:-]', '?', 'g'), 128) as sample_id
      from model_endpoints
      where credential_id is null
        and nullif(btrim(api_key_secret_ref), '') is not null
      order by id
      limit 5
    ) samples;

    select coalesce(string_agg(sample_id, ', ' order by sample_id), 'none')
    into alias_free_samples
    from (
      select left(regexp_replace(id, '[^A-Za-z0-9._:-]', '?', 'g'), 128) as sample_id
      from model_endpoints
      where credential_id is null
        and nullif(btrim(api_key_secret_ref), '') is null
      order by id
      limit 5
    ) samples;

    raise exception using
      errcode = '23514',
      message = format(
        'Migration 066 requires every model endpoint to bind credential_id before retry: alias-backed=%s (sample IDs: %s), alias-free=%s (sample IDs: %s)',
        alias_backed_count,
        alias_backed_samples,
        alias_free_count,
        alias_free_samples
      );
  end if;
end;
$$;

drop trigger if exists sandbox_usage_settlements_immutable on sandbox_usage_settlements;
delete from sandbox_usage_settlements;
delete from project_provider_settlements where task_id is not null;
delete from task_idempotency_records where operation in (
  'create','message','message-edit','message-delete','abort-turn','work-stop',
  'release-sandbox','edit','archive','delete',
  'retry','duplicate','cancel','follow-up','follow-up-edit','follow-up-delete'
);
delete from task_interaction_changes;
delete from task_messages;
delete from agent_task_artifacts;
delete from postgres_json_docs where collection in ('sandbox_runtime_state', 'sandbox_run_state');
drop table if exists task_follow_ups;
delete from agent_tasks;

update project_resource_usage usage
set active_tasks = 0,
    provider_requests = (
      select count(*) from project_provider_settlements settlement
      where settlement.project_id = usage.project_id and settlement.status <> 'failed'
    ),
    provider_tokens = (
      select coalesce(sum(case when settlement.status = 'settled' then coalesce(settlement.provider_tokens,0) else settlement.reserved_tokens end),0)
      from project_provider_settlements settlement
      where settlement.project_id = usage.project_id and settlement.status <> 'failed'
    ),
    provider_cost = (
      select coalesce(sum(case when settlement.status = 'settled' then coalesce(settlement.provider_cost,0) else settlement.reserved_cost end),0)
      from project_provider_settlements settlement
      where settlement.project_id = usage.project_id and settlement.status <> 'failed'
    ),
    updated_at = now();

alter table task_messages drop column if exists target_task_id;
alter table model_endpoints alter column credential_id set not null;
alter table model_endpoints drop column if exists api_key_secret_ref;

drop function if exists reject_sandbox_usage_settlement_change();
create function reject_sandbox_usage_settlement_change() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and exists (
    select 1 from projects
    where id = old.project_id and lifecycle_status = 'deleting'
  ) then
    return old;
  end if;
  raise exception 'sandbox usage settlements are immutable';
end;
$$;
create trigger sandbox_usage_settlements_immutable
before update or delete on sandbox_usage_settlements
for each row execute function reject_sandbox_usage_settlement_change();

alter table sandbox_usage_settlements
  drop constraint if exists sandbox_usage_settlements_release_reason_check;
alter table sandbox_usage_settlements
  add constraint sandbox_usage_settlements_release_reason_check
  check (release_reason in ('requested','failed','cleanup'));

alter table agent_tasks
  add column current_run_id text;

alter table agent_tasks
  drop constraint if exists agent_tasks_file_library_tombstone_check;

drop index if exists agent_tasks_file_library_active_unique;
create unique index agent_tasks_file_library_active_unique
  on agent_tasks(file_library_id)
  where file_library_id is not null;

alter table agent_tasks
  drop column status,
  drop column run_id,
  drop column execution_mode,
  drop column active_reservation,
  drop column terminal_reason,
  drop column terminalized_at,
  drop column start_delivery_key,
  drop column start_request_hash,
  drop column start_claim_token,
  drop column start_receipt,
  drop column start_timeline_cursor,
  drop column start_intent_status,
  drop column start_claimed_at,
  drop column start_lease_expires_at,
  drop column start_attempt_count,
  drop column start_next_retry_at,
  drop column start_safe_error,
  drop column artifact_projection_status,
  drop column artifact_projection_error,
  drop column artifact_projection_claim_token,
  drop column artifact_projection_lease_expires_at,
  drop column artifact_projection_attempt_count,
  drop column artifact_projection_next_retry_at,
  drop column cleanup_status,
  drop column cleanup_error,
  drop column cleanup_claim_token,
  drop column cleanup_lease_expires_at,
  drop column cleanup_attempt_count,
  drop column cleanup_next_retry_at,
  drop column cleanup_completed_at,
  drop column sandbox,
  drop column finalization_intent_status,
  drop column finalization_intent_at;

alter table file_libraries
  add constraint file_libraries_workspace_project_id_unique
  unique (workspace_id, project_id, id);

create table sandbox_runs (
  run_id text primary key,
  workspace_id text not null references workspaces(id),
  project_id text not null references projects(id),
  task_id text not null references agent_tasks(id),
  file_library_id text not null references file_libraries(id),
  started_by_user_id text not null references users(id),
  state text not null check (state in ('starting','active','release_requested','failed','released')),
  namespace text not null,
  image text not null,
  pvc_name text not null,
  project_sub_path text not null,
  file_library_root_sub_path text not null,
  botified_port integer not null check (botified_port > 0 and botified_port < 65536),
  resource_names jsonb not null,
  service_key_secret_ref jsonb not null,
  directories jsonb not null,
  resource_limits jsonb not null,
  resource_snapshot jsonb not null,
  model_ca jsonb,
  timeline_cursor text,
  terminal_failure jsonb,
  failure_code text check (failure_code in ('startup_failed','runtime_unreachable','runner_failed','cleanup_failed')),
  failure_cause text,
  fencing_token bigint not null check (fencing_token >= 1),
  resume_unfinished boolean not null default false,
  startup_claim_token text,
  startup_lease_expires_at timestamptz,
  cleanup_claimed_at timestamptz,
  cleanup_attempts integer not null default 0 check (cleanup_attempts >= 0),
  last_cleanup_at timestamptz,
  last_cleanup_error jsonb,
  release_reason text check (release_reason in ('requested','failed','cleanup')),
  started_at timestamptz,
  release_requested_at timestamptz,
  failed_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint sandbox_runs_scope_fkey
    foreign key (workspace_id, project_id, file_library_id)
    references file_libraries(workspace_id, project_id, id),
  constraint sandbox_runs_state_timestamps_check check (
    (state <> 'active' or started_at is not null)
    and (state <> 'release_requested' or release_requested_at is not null)
    and (state <> 'failed' or (failed_at is not null and failure_cause is not null))
    and (state <> 'released' or released_at is not null)
  )
);

create unique index sandbox_runs_one_unreleased_per_task
  on sandbox_runs(task_id)
  where state <> 'released';
create index sandbox_runs_project_user_updated_idx
  on sandbox_runs(project_id, started_by_user_id, updated_at desc, run_id desc);

alter table agent_tasks
  add constraint agent_tasks_current_run_id_fkey
  foreign key (current_run_id) references sandbox_runs(run_id);

alter table project_alerts drop constraint if exists project_alerts_type_check;
alter table project_alert_rules drop constraint if exists project_alert_rules_alert_type_check;
alter table project_audit_events drop constraint if exists project_audit_events_action_check;

alter table project_alert_rules
  add column retired_was_enabled boolean;

update project_alerts
set type = 'historical_task_failure',
    status = case when status = 'active' then 'resolved' else status end,
    resolved_at = case
      when status = 'active' then coalesce(resolved_at, updated_at, created_at)
      else resolved_at
    end
where type = 'task_failure';

update project_alert_rules
set alert_type = 'historical_task_failure',
    retired_was_enabled = enabled,
    enabled = false
where alert_type = 'task_failure';

update project_audit_events
set action = 'task.historical_terminal',
    detail = (detail - 'historicalAction') || jsonb_build_object('historicalAction', action)
where action in ('task.cancel','task.completed','task.failed','task.expired','task.cleaned');

alter table project_audit_events add constraint project_audit_events_action_check check (action in (
  'project.settings.update','project.archive','project.unarchive','project.owner.transfer','project.delete',
  'policy.update',
  'credential.create','credential.rotate','credential.delete',
  'endpoint.create','endpoint.update','endpoint.delete','endpoint.health_check','endpoint.model_discover',
  'membership.add','membership.change','membership.remove',
  'provider.request',
  'task.create','task.edit','task.archive','task.delete','task.message.create','task.message.edit','task.message.delete',
  'task.historical_terminal',
  'artifact.project',
  'sandbox.started','sandbox.failed','sandbox.release_requested','sandbox.released',
  'file.upload','file.delete','file.quota',
  'alert.resolve','alert.dismiss','alert.rule.create','alert.rule.update','alert.rule.delete','alert.acknowledge','alert.silence'
));

alter table project_alerts add constraint project_alerts_type_check check (type in (
  'active_tasks_limit','provider_requests_limit','provider_tokens_limit','provider_cost_limit',
  'project_file_bytes_limit','endpoint_failure','provider_failure','sandbox_failure',
  'historical_task_failure'
));
alter table project_alerts add constraint project_alerts_historical_status_check check (
  type <> 'historical_task_failure' or status <> 'active'
);

alter table project_alert_rules add constraint project_alert_rules_alert_type_check check (alert_type in (
  'active_tasks_limit','provider_requests_limit','provider_tokens_limit','provider_cost_limit',
  'project_file_bytes_limit','endpoint_failure','provider_failure','sandbox_failure',
  'historical_task_failure'
));
alter table project_alert_rules add constraint project_alert_rules_retired_state_check check (
  (
    alert_type = 'historical_task_failure'
    and enabled = false
    and retired_was_enabled is not null
  )
  or (
    alert_type <> 'historical_task_failure'
    and retired_was_enabled is null
  )
);
