do $$
begin
  if exists (select 1 from sandbox_runs where state <> 'released') then
    raise exception 'migration 081 requires every existing Sandbox Run to be released first'
      using hint = 'Release all existing Sandbox Runs before retrying migration 081.';
  end if;
end
$$;

alter table sandbox_runs
  add column current_llm_message_id text null
  references task_messages(id) on delete set null;
