alter table agent_tasks
  add constraint agent_tasks_finalization_intent_status_check
  check (finalization_intent_status is null or finalization_intent_status in ('completed', 'failed', 'expired', 'cleaned'));
