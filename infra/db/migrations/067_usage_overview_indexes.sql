create index project_provider_settlements_user_period_idx
  on project_provider_settlements(project_id, actor_id, settled_at, endpoint_id)
  where status = 'settled';

drop index sandbox_usage_settlements_project_user_idx;
create index sandbox_usage_settlements_project_user_idx
  on sandbox_usage_settlements(
    project_id,
    started_by_user_id,
    released_at desc,
    run_id collate "C" desc
  );
