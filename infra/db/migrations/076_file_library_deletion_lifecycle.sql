alter table file_libraries
  add column lifecycle_status text not null default 'active',
  add column deletion_operation_id text,
  add column deletion_phase text,
  add column deletion_quarantine_device text,
  add column deletion_quarantine_inode text,
  add column deletion_entry_type text,
  add column deletion_bytes bigint,
  add column deletion_claim_token text,
  add column deletion_claim_expires_at timestamptz;

alter table file_libraries
  add constraint file_libraries_lifecycle_status_check
    check (lifecycle_status in ('active', 'deleting')),
  add constraint file_libraries_deletion_operation_check
    check (
      (
        lifecycle_status = 'active'
        and deletion_operation_id is null
        and deletion_phase is null
        and deletion_quarantine_device is null
        and deletion_quarantine_inode is null
        and deletion_entry_type is null
        and deletion_bytes is null
        and deletion_claim_token is null
        and deletion_claim_expires_at is null
      )
      or (
        lifecycle_status = 'deleting'
        and deletion_operation_id = 'file-library-delete:' || id
        and (
          (
            deletion_phase is null
            and deletion_quarantine_device is null
            and deletion_quarantine_inode is null
            and deletion_entry_type is null
            and deletion_bytes is null
          )
          or (
            deletion_phase in ('isolated', 'removed')
            and deletion_quarantine_device ~ '^[0-9]+$'
            and deletion_quarantine_inode ~ '^[0-9]+$'
            and deletion_entry_type in ('file', 'directory', 'symlink', 'unsupported')
            and deletion_bytes between 0 and 9007199254740991
          )
        )
        and (
          (
            deletion_claim_token is null
            and deletion_claim_expires_at is null
          )
          or (
            deletion_claim_token is not null
            and deletion_claim_expires_at is not null
          )
        )
      )
    );

create unique index file_libraries_deletion_operation_unique
  on file_libraries(deletion_operation_id)
  where deletion_operation_id is not null;

create index file_libraries_deletion_claim_expiry
  on file_libraries(deletion_claim_expires_at)
  where lifecycle_status = 'deleting' and deletion_claim_token is not null;

alter table project_audit_events
  drop constraint if exists project_audit_events_action_check;

alter table project_audit_events
  add constraint project_audit_events_action_check check (action in (
    'project.settings.update','project.archive','project.unarchive','project.owner.transfer','project.delete',
    'policy.update',
    'credential.create','credential.rotate','credential.delete',
    'endpoint.create','endpoint.update','endpoint.delete','endpoint.health_check','endpoint.model_discover',
    'membership.add','membership.change','membership.remove',
    'provider.request',
    'task.create','task.edit','task.archive','task.delete','task.message.create','task.message.edit','task.message.delete',
    'artifact.project',
    'sandbox.started','sandbox.failed','sandbox.released',
    'file.upload','file.delete','file_library.delete','file.quota',
    'alert.resolve','alert.dismiss','alert.rule.create','alert.rule.update','alert.rule.delete','alert.acknowledge','alert.silence'
  ));
