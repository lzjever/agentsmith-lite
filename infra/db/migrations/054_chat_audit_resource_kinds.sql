alter table project_audit_events drop constraint if exists project_audit_events_resource_kind_check;

update project_audit_events
set resource_kind = case
  when action like 'chat.thread.%' then 'chat_thread'
  when action like 'chat.message.%' then 'chat_message'
  else resource_kind
end
where action like 'chat.thread.%' or action like 'chat.message.%';

alter table project_audit_events add constraint project_audit_events_resource_kind_check check (
  resource_kind in ('project','credential','endpoint','member','chat_thread','chat_message','task','artifact','provider','file','file_quota','sandbox','alert')
);
