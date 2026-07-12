alter table project_chat_threads
  alter column endpoint_id drop not null;

alter table project_chat_threads
  drop constraint if exists project_chat_threads_endpoint_id_fkey;

alter table project_chat_threads
  add constraint project_chat_threads_endpoint_id_fkey
  foreign key (endpoint_id) references model_endpoints(id) on delete set null;

alter table project_provider_settlements
  alter column endpoint_id drop not null;

alter table project_provider_settlements
  drop constraint if exists project_provider_settlements_endpoint_id_fkey;

alter table project_provider_settlements
  add constraint project_provider_settlements_endpoint_id_fkey
  foreign key (endpoint_id) references model_endpoints(id) on delete set null;
