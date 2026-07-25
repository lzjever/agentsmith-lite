alter table task_idempotency_records
  add column if not exists file_deletion_phase text,
  add column if not exists file_deletion_quarantine_device text,
  add column if not exists file_deletion_quarantine_inode text,
  add column if not exists file_deletion_entry_type text,
  add column if not exists file_deletion_bytes bigint;

alter table task_idempotency_records
  drop constraint if exists task_idempotency_records_file_deletion_check;

alter table task_idempotency_records
  add constraint task_idempotency_records_file_deletion_check check (
    (
      file_deletion_phase is null
      and file_deletion_quarantine_device is null
      and file_deletion_quarantine_inode is null
      and file_deletion_entry_type is null
      and file_deletion_bytes is null
    )
    or (
      operation = 'project.file.delete'
      and file_deletion_phase is not null
      and file_deletion_phase in ('isolated', 'removed')
      and file_deletion_quarantine_device is not null
      and file_deletion_quarantine_device ~ '^[0-9]+$'
      and file_deletion_quarantine_inode is not null
      and file_deletion_quarantine_inode ~ '^[0-9]+$'
      and file_deletion_entry_type is not null
      and file_deletion_entry_type in ('file', 'directory', 'symlink', 'unsupported')
      and file_deletion_bytes is not null
      and file_deletion_bytes >= 0
      and file_deletion_bytes <= 9007199254740991
    )
  );
