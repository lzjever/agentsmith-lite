alter table project_chat_threads
  add column if not exists owner_user_id text references users(id);

update project_chat_threads thread
set owner_user_id = project.owner_user_id
from projects project
where thread.project_id = project.id
  and thread.owner_user_id is null;

alter table project_chat_threads
  alter column owner_user_id set not null;

create index if not exists project_chat_threads_owner_updated_idx
  on project_chat_threads (project_id, owner_user_id, starred_at desc nulls last, pinned_at desc nulls last, updated_at desc, id desc)
  where deleted_at is null;
