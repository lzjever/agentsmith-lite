alter table users
  drop constraint if exists users_role_check;

alter table users
  drop column if exists role;
