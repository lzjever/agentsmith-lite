alter table user_notifications add column if not exists dedupe_key text;
create unique index if not exists user_notifications_dedupe_key_unique on user_notifications (dedupe_key);
