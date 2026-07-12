alter table users add column if not exists picture_url text;

alter table task_idempotency_records
  drop constraint if exists task_idempotency_records_project_id_fkey;
