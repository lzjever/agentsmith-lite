alter table sandbox_runs
  add column startup_config_map_name text,
  add column startup_config_hash text,
  add column startup_pod_uid text,
  add column startup_pod_ip text;

alter table sandbox_runs
  add constraint sandbox_runs_startup_config_identity_check check (
    (startup_config_map_name is null and startup_config_hash is null)
    or
    (
      startup_config_map_name is not null
      and length(startup_config_map_name) > 0
      and startup_config_hash is not null
      and length(startup_config_hash) > 0
    )
  ),
  add constraint sandbox_runs_startup_pod_identity_check check (
    (startup_pod_uid is null and startup_pod_ip is null)
    or
    (
      startup_pod_uid is not null
      and length(startup_pod_uid) > 0
      and (startup_pod_ip is null or length(startup_pod_ip) > 0)
    )
  );
