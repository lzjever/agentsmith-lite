alter table agent_task_artifacts
  add column if not exists sha256 text;
