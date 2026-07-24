delete from project_audit_events
where action in ('task.historical_terminal','sandbox.release_requested');

update project_audit_events
set detail = detail - 'historicalAction'
where detail ? 'historicalAction';

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
    'file.upload','file.delete','file.quota',
    'alert.resolve','alert.dismiss','alert.rule.create','alert.rule.update','alert.rule.delete','alert.acknowledge','alert.silence'
  ));

drop index if exists project_audit_events_page_idx;
drop index if exists project_audit_events_actor_page_idx;
drop index if exists project_audit_events_subject_page_idx;
drop index if exists project_audit_events_resource_idx;
drop index if exists project_audit_events_resource_lookup_idx;

create index project_audit_events_page_idx
  on project_audit_events(project_id,created_at desc,id collate "C" desc);
create index project_audit_events_actor_page_idx
  on project_audit_events(project_id,actor_id,created_at desc,id collate "C" desc);
create index project_audit_events_subject_page_idx
  on project_audit_events(project_id,subject_user_id,created_at desc,id collate "C" desc);
create index project_audit_events_resource_lookup_idx
  on project_audit_events(project_id,resource_id,resource_kind,created_at desc,id collate "C" desc);
