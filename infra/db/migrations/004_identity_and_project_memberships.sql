alter table users
  add column if not exists oidc_issuer text,
  add column if not exists oidc_subject text,
  add column if not exists email_verified boolean not null default false;

update users
set role = 'operator'
where role <> 'operator';

alter table users
  drop constraint if exists users_role_check;

alter table users
  add constraint users_role_check check (role = 'operator');

create unique index if not exists users_oidc_issuer_subject_unique
  on users (oidc_issuer, oidc_subject)
  where oidc_issuer is not null and oidc_subject is not null;

create table if not exists project_memberships (
  project_id text not null references projects(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null check (role in ('admin', 'member', 'viewer')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (project_id, user_id)
);

create index if not exists project_memberships_user_project_idx
  on project_memberships (user_id, project_id);
