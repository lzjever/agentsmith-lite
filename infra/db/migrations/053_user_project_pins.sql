create table user_project_pins (
  project_id text not null,
  user_id text not null,
  pinned_at timestamptz not null,
  primary key (project_id, user_id),
  foreign key (project_id, user_id) references project_memberships(project_id, user_id) on delete cascade
);

create index user_project_pins_user_order_idx
  on user_project_pins(user_id, pinned_at desc, project_id);
