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
    'task.create','task.edit','task.archive','task.delete','task.message.create','task.message.edit','task.message.delete','task.turn.abort',
    'artifact.project',
    'sandbox.started','sandbox.failed','sandbox.released',
    'file.upload','file.delete','file_library.delete','file.quota',
    'alert.resolve','alert.dismiss','alert.rule.create','alert.rule.update','alert.rule.delete','alert.acknowledge','alert.silence'
  ));
