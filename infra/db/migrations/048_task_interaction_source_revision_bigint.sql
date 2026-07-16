alter table task_interaction_changes
  alter column source_revision type bigint using source_revision::bigint;
