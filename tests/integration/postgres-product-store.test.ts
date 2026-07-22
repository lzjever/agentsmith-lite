import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, beforeEach, describe, it } from "node:test";
import pg from "pg";
import type { ModelEndpoint, Project, ProjectContextEntry, ProjectMembership, StoredUser, TaskAssistantMessageInteraction, Workspace } from "../../packages/contracts/src/api.js";
import type { PersistedAgentTask, PersistedTaskArtifact } from "../../packages/ports/src/store.js";
import { PostgresProductStore } from "../../packages/adapters-postgres/src/postgresProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { SandboxRunState } from "../../packages/sandbox-controller/src/reconciler.js";
import { readPostgresTestUrl } from "./postgres-test-database.js";

type TaskFixture = Omit<PersistedAgentTask, "fileLibraryId"> & { fileLibraryId?: string | null };

async function createTaskWithLibrary(store: PostgresProductStore, input: TaskFixture, reserveActive = false) {
  const project = await store.findProject(input.projectId);
  assert.ok(project);
  const fileLibraryId = input.fileLibraryId ?? `library_${input.id}`;
  return store.createTaskAtomically({
    task: { ...input, fileLibraryId },
    newFileLibrary: {
      id: fileLibraryId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      name: `Library ${input.id}`,
      rootSubPath: `libraries/${fileLibraryId}/home`,
      createdByUserId: project.ownerUserId,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt
    },
    reserveActive
  });
}

const postgresUrl = readPostgresTestUrl();
const postgresDescribe = postgresUrl ? describe : describe.skip;

postgresDescribe("postgres product store", () => {
  assert.ok(postgresUrl);
  const store = new PostgresProductStore(postgresUrl);

  beforeEach(async () => {
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      await client.query(`
        truncate table
          sandbox_usage_settlements,
          agent_task_artifacts,
          task_interaction_changes,
          task_messages,
          agent_tasks,
          model_endpoints,
          projects,
          workspaces,
          auth_sessions,
          users,
          postgres_json_docs,
          runtime_leases
        cascade
      `);
    } finally {
      await client.end();
    }
  });

  after(async () => {
    await store.close();
  });

  it("atomically enforces workspace and project membership consistency", async () => {
    const timestamp = "2026-07-15T00:00:00.000Z";
    await store.createUser({ id:"user_membership_owner",email:"membership-owner@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp });
    await store.createUser({ id:"user_membership_target",email:"membership-target@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp });
    await store.createWorkspace({ id:"ws_membership",name:"Membership",ownerUserId:"user_membership_owner",createdAt:timestamp,updatedAt:timestamp });
    await store.createProject({ id:"proj_membership_one",workspaceId:"ws_membership",name:"One",ownerUserId:"user_membership_owner",rootPath:"workspaces/ws_membership/projects/proj_membership_one",taskConcurrencyLimit:1,createdAt:timestamp,updatedAt:timestamp });
    await store.createProject({ id:"proj_membership_two",workspaceId:"ws_membership",name:"Two",ownerUserId:"user_membership_owner",rootPath:"workspaces/ws_membership/projects/proj_membership_two",taskConcurrencyLimit:1,createdAt:timestamp,updatedAt:timestamp });
    const membership = {projectId:"proj_membership_one",userId:"user_membership_target",role:"member" as const,createdAt:timestamp,updatedAt:timestamp};

    assert.equal(await store.upsertProjectMembershipForWorkspaceMember(membership),null);
    await store.upsertWorkspaceMembership({workspaceId:"ws_membership",userId:"user_membership_target",role:"member",createdAt:timestamp,updatedAt:timestamp});
    assert.equal((await store.upsertProjectMembershipForWorkspaceMember(membership))?.role,"member");
    await store.upsertProjectMembershipForWorkspaceMember({...membership,projectId:"proj_membership_two",role:"viewer"});
    const changedAt=new Date(Date.parse(timestamp)+1).toISOString();
    assert.equal((await store.updateManagedProjectMembershipRole("proj_membership_one","user_membership_target","viewer",changedAt,timestamp) as {role:string}).role,"viewer");
    assert.equal(await store.updateManagedProjectMembershipRole("proj_membership_one","user_membership_target","member",new Date(Date.parse(changedAt)+1).toISOString(),timestamp),"conflict");
    assert.equal(await store.deleteManagedProjectMembership("proj_membership_one","user_membership_target",timestamp),"conflict");
    await store.createUserNotification({id:"notification_project_membership_target",userId:"user_membership_target",type:"project_alert",title:"Target",body:null,projectId:"proj_membership_one",resourceKind:"alert",resourceId:"alert_project_target",linkPath:"/target",readAt:null,createdAt:timestamp});
    await store.createUserNotification({id:"notification_project_membership_owner",userId:"user_membership_owner",type:"project_alert",title:"Owner",body:null,projectId:"proj_membership_one",resourceKind:"alert",resourceId:"alert_project_owner",linkPath:"/owner",readAt:null,createdAt:timestamp});
    assert.equal(await store.deleteManagedProjectMembership("proj_membership_one","user_membership_target",changedAt),"deleted");
    assert.deepEqual(await store.listUserNotifications("user_membership_target"),[]);
    assert.deepEqual((await store.listUserNotifications("user_membership_owner")).map((item)=>item.id),["notification_project_membership_owner"]);
    assert.equal((await store.upsertProjectMembershipForWorkspaceMember(membership))?.role,"member");

    assert.equal(await store.revokeWorkspaceMembership("ws_membership","user_membership_owner",timestamp),"owner");
    assert.equal((await store.findWorkspaceMembership("ws_membership","user_membership_owner"))?.role,"owner");
    assert.equal((await store.findProjectMembership("proj_membership_one","user_membership_owner"))?.role,"owner");
    assert.ok(await store.transferProjectOwner("proj_membership_two","user_membership_owner","user_membership_target",timestamp));
    assert.equal(await store.revokeWorkspaceMembership("ws_membership","user_membership_target",timestamp),"owner");
    assert.equal((await store.findWorkspaceMembership("ws_membership","user_membership_target"))?.role,"member");
    assert.equal((await store.findProjectMembership("proj_membership_one","user_membership_target"))?.role,"member");
    assert.ok(await store.transferProjectOwner("proj_membership_two","user_membership_target","user_membership_owner",timestamp));
    for(const projectId of ["proj_membership_one","proj_membership_two"])await store.createUserNotification({id:`notification_workspace_membership_${projectId}`,userId:"user_membership_target",type:"project_alert",title:"Workspace target",body:null,projectId,resourceKind:"alert",resourceId:`alert_${projectId}`,linkPath:"/target",readAt:null,createdAt:timestamp});
    const revoked=await store.revokeWorkspaceMembership("ws_membership","user_membership_target",timestamp);
    assert.ok(typeof revoked==="object");
    assert.deepEqual([...revoked.revokedProjectIds].sort(),["proj_membership_one","proj_membership_two"]);
    assert.equal(await store.findWorkspaceMembership("ws_membership","user_membership_target"),null);
    assert.equal(await store.findProjectMembership("proj_membership_one","user_membership_target"),null);
    assert.equal(await store.findProjectMembership("proj_membership_two","user_membership_target"),null);
    assert.deepEqual(await store.listUserNotifications("user_membership_target"),[]);
    assert.deepEqual((await store.listUserNotifications("user_membership_owner")).map((item)=>item.id),["notification_project_membership_owner"]);
    await store.createUserNotification({id:"notification_late_after_membership_revoke",userId:"user_membership_target",type:"project_alert",title:"Late target",body:"Must remain inaccessible",projectId:"proj_membership_one",resourceKind:"alert",resourceId:"alert_late_target",linkPath:"/target",readAt:null,createdAt:timestamp});
    assert.equal(await store.markUserNotificationRead("notification_late_after_membership_revoke","user_membership_target",timestamp),null);
    assert.equal(await store.markAllUserNotificationsRead("user_membership_target",timestamp),0);
    assert.equal(await store.dismissUserNotification("notification_late_after_membership_revoke","user_membership_target"),false);
    await store.upsertWorkspaceMembership({workspaceId:"ws_membership",userId:"user_membership_target",role:"member",createdAt:timestamp,updatedAt:timestamp});
    assert.equal((await store.upsertProjectMembershipForWorkspaceMember(membership))?.role,"member");
    assert.deepEqual((await store.listUserNotifications("user_membership_target")).map((item)=>[item.id,item.readAt]),[["notification_late_after_membership_revoke",null]]);
  });

  it("keeps project pins user-scoped and removes them with membership", async () => {
    const timestamp="2026-07-15T00:00:00.000Z";
    await store.createUser({id:"user_pin_owner",email:"pin-owner@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp});
    await store.createUser({id:"user_pin_member",email:"pin-member@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp});
    await store.createWorkspace({id:"ws_pin",name:"Pins",ownerUserId:"user_pin_owner",createdAt:timestamp,updatedAt:timestamp});
    await store.createProject({id:"proj_pin",workspaceId:"ws_pin",name:"Pins",ownerUserId:"user_pin_owner",rootPath:"workspaces/ws_pin/projects/proj_pin",taskConcurrencyLimit:1,createdAt:timestamp,updatedAt:timestamp});
    await store.upsertProjectMembership({projectId:"proj_pin",userId:"user_pin_member",role:"member",createdAt:timestamp,updatedAt:timestamp});

    assert.equal(await store.setProjectPin("user_pin_member","proj_pin",timestamp),true);
    assert.deepEqual(await store.listProjectPinsForUser("user_pin_owner"),[]);
    assert.deepEqual(await store.listProjectPinsForUser("user_pin_member"),[{projectId:"proj_pin",pinnedAt:timestamp}]);
    await store.deleteProjectMembership("proj_pin","user_pin_member");
    assert.deepEqual(await store.listProjectPinsForUser("user_pin_member"),[]);
  });


  it("atomically rejects duplicate context keys during creates and renames", async () => {
    const timestamp = "2026-07-15T00:00:00.000Z";
    await store.createUser({ id:"user_context_race",email:"context-race@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp });
    await store.createWorkspace({ id:"ws_context_race",name:"Context race",ownerUserId:"user_context_race",createdAt:timestamp,updatedAt:timestamp });
    const entry = (id: string, contextKey: string): ProjectContextEntry => ({ id,workspaceId:"ws_context_race",projectId:null,ownerUserId:"user_context_race",scope:"workspace_personal",contextKey,content:id,contentType:"text",version:1,createdAt:timestamp,updatedAt:timestamp });

    const creates = await Promise.all([
      store.createProjectContextEntry(entry("ctx_same_one", "same")),
      store.createProjectContextEntry(entry("ctx_same_two", "same"))
    ]);
    assert.equal(creates.filter(Boolean).length, 1);

    const left = (await store.createProjectContextEntry(entry("ctx_left", "left")))!;
    const right = (await store.createProjectContextEntry(entry("ctx_right", "right")))!;
    const renames = await Promise.all([
      store.updateProjectContextEntry({ ...left,contextKey:"merged",version:2,updatedAt:timestamp }, left.version),
      store.updateProjectContextEntry({ ...right,contextKey:"merged",version:2,updatedAt:timestamp }, right.version)
    ]);
    assert.equal(renames.filter(Boolean).length, 1);
    const stored = await store.listProjectContextEntries("ws_context_race", null, "workspace_personal", "user_context_race");
    assert.equal(stored.filter((item) => item.contextKey === "same").length, 1);
    assert.equal(stored.filter((item) => item.contextKey === "merged").length, 1);
    assert.equal(stored.length, 3);
  });

  it("removes project-scoped audit events with a physically deleted project", async () => {
    const timestamp = "2026-07-15T00:00:00.000Z";
    await store.createUser({ id:"user_project_delete",email:"project-delete@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp });
    await store.createWorkspace({ id:"ws_project_delete",name:"Delete",ownerUserId:"user_project_delete",createdAt:timestamp,updatedAt:timestamp });
    await store.createProject({ id:"proj_project_delete",workspaceId:"ws_project_delete",name:"Delete",ownerUserId:"user_project_delete",rootPath:"workspaces/ws_project_delete/projects/proj_project_delete",taskConcurrencyLimit:1,createdAt:timestamp,updatedAt:timestamp });
    await store.appendProjectAuditEvent({id:"audit_project_delete",projectId:"proj_project_delete",actorId:"user_project_delete",action:"project.delete",status:"accepted",resourceKind:"project",resourceId:"proj_project_delete",createdAt:timestamp});
    await store.createUserNotification({id:"notification_project_delete",userId:"user_project_delete",type:"project_alert",title:"Delete project alert",body:null,projectId:"proj_project_delete",resourceKind:"alert",resourceId:"alert_project_delete",linkPath:"/deleted-project",readAt:null,createdAt:timestamp},"notification-project-delete");
    assert.equal((await store.beginProjectDeletion("proj_project_delete",timestamp)).kind,"ready");

    assert.equal(await store.deleteProjectDependenciesAndProject("proj_project_delete"),true);
    assert.equal((await store.findProject("proj_project_delete"))?.lifecycleStatus,"deleting");
    assert.equal(await store.deleteProjectAfterDependencies("proj_project_delete"),true);
    assert.equal(await store.findProject("proj_project_delete"),null);
    assert.deepEqual(await store.listProjectAuditEvents("proj_project_delete"),[]);
    assert.deepEqual(await store.listUserNotifications("user_project_delete"),[]);
  });

  it("reactivates deleting project and workspace retries when sandbox ownership is uncertain",async()=>{
    const timestamp="2026-07-19T00:00:00.000Z",owner="user_delete_retry",workspaceId="ws_delete_retry",projectId="proj_delete_retry";
    await store.createUser({id:owner,email:"delete-retry@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp});
    await store.createWorkspace({id:workspaceId,name:"Retry workspace",ownerUserId:owner,createdAt:timestamp,updatedAt:timestamp});
    await store.createProject({id:projectId,workspaceId,name:"Retry project",ownerUserId:owner,rootPath:`workspaces/${workspaceId}/projects/${projectId}`,taskConcurrencyLimit:1,createdAt:timestamp,updatedAt:timestamp});
    await createTestCredential(store,projectId,"cred_delete_retry",timestamp);
    await store.createEndpoint(endpointRecord("endpoint_delete_retry",projectId,"cred_delete_retry",timestamp));
    const createStartedRun=async(label:string,createdAt:string,startedAt:string)=>{
      const taskId=`task_delete_retry_${label}`,runId=`run_delete_retry_${label}`,fileLibraryId=`library_delete_retry_${label}`;
      const task:TaskFixture={id:taskId,workspaceId,projectId,endpointId:"endpoint_delete_retry",fileLibraryId,createdByUserId:owner,title:`Retry Task ${label}`,prompt:"work",status:"starting",runId,executionMode:"live",sandbox:{namespace:"agentsmith",resources:[]},activeReservation:true,createdAt,updatedAt:createdAt};
      const run=sandboxRun({workspaceId,projectId,taskId,runId,fileLibraryId,startedByUserId:owner,createdAt,updatedAt:createdAt,projectSubPath:`workspaces/${workspaceId}/projects/${projectId}`,fileLibraryRootSubPath:`libraries/${fileLibraryId}/home`});
      assert.equal((await store.createTaskAtomically({task:{...task,fileLibraryId},newFileLibrary:{id:fileLibraryId,workspaceId,projectId,name:`Library ${taskId}`,rootSubPath:`libraries/${fileLibraryId}/home`,createdByUserId:owner,createdAt,updatedAt:createdAt},reserveActive:true,sandboxRun:run})).kind,"created");
      const started=await store.confirmSandboxRunStarted({runId,expectedFencingToken:run.fencingToken,startedAt,auditEvent:{id:`audit_sandbox_started_${runId}`,projectId,actorId:null,subjectUserId:owner,action:"sandbox.started",status:"accepted",resourceKind:"sandbox",resourceId:taskId,detail:{taskId,runId},createdAt:startedAt}});
      assert.equal(started.kind,"started");
      if(started.kind!=="started")throw new Error(`Failed to start deletion retry run ${runId}`);
      return started.run;
    };
    const releaseRun=async(run:SandboxRunState,releasedAt:string)=>{
      assert.ok(run.startedAt);
      const cleaned={...run,phase:"cleaned" as const,cleanupStatus:"cleaned" as const,releaseReason:"requested" as const,fencingToken:run.fencingToken+1,updatedAt:releasedAt};
      const settlement={runId:cleaned.runId,workspaceId,projectId,taskId:cleaned.taskId,fileLibraryId:cleaned.fileLibraryId,startedByUserId:owner,startedAt:cleaned.startedAt,releasedAt,durationSeconds:(Date.parse(releasedAt)-Date.parse(run.startedAt))/1000,resources:cleaned.resourceSnapshot,releaseReason:"requested" as const};
      const auditEvent={id:`audit_sandbox_released_${run.runId}`,projectId,actorId:null,subjectUserId:owner,action:"sandbox.released" as const,status:"accepted" as const,resourceKind:"sandbox" as const,resourceId:run.taskId,detail:{taskId:run.taskId,runId:run.runId,releaseReason:"requested" as const},createdAt:releasedAt};
      assert.equal(await store.completeSandboxRunRelease({runId:run.runId,expectedFencingToken:run.fencingToken,run:cleaned,settlement,auditEvent}),"applied");
      return cleaned;
    };

    const projectRun=await createStartedRun("project","2026-07-19T00:00:10.000Z","2026-07-19T00:00:20.000Z");
    const cleanedProjectRun=await releaseRun(projectRun,"2026-07-19T00:00:30.000Z");
    assert.equal((await store.findTask(projectRun.taskId))?.activeReservation,false);
    assert.equal((await store.findProjectResourceUsage(projectId))?.activeTasks,0);
    assert.equal((await store.beginProjectDeletion(projectId,"2026-07-19T00:00:40.000Z",owner)).kind,"ready");
    await store.jsonDocs.delete("sandbox_run_state",projectRun.runId);
    assert.equal((await store.beginProjectDeletion(projectId,"2026-07-19T00:01:00.000Z",owner)).kind,"sandbox_not_released");
    assert.equal((await store.findProject(projectId))?.lifecycleStatus,"active");
    await store.sandboxRuns.put(cleanedProjectRun);
    assert.equal((await store.updateProjectName(projectId,"Writable retry","2026-07-19T00:02:00.000Z","Retry project"))?.name,"Writable retry");

    const workspaceRun=await createStartedRun("workspace","2026-07-19T00:02:30.000Z","2026-07-19T00:02:40.000Z");
    const cleanedWorkspaceRun=await releaseRun(workspaceRun,"2026-07-19T00:02:50.000Z");
    assert.equal((await store.findTask(workspaceRun.taskId))?.activeReservation,false);
    assert.equal((await store.findProjectResourceUsage(projectId))?.activeTasks,0);
    assert.equal((await store.beginProjectDeletion(projectId,"2026-07-19T00:03:00.000Z",owner)).kind,"ready");
    assert.equal((await store.beginProjectDeletion(projectId,"2026-07-19T00:04:00.000Z",owner)).kind,"ready");
    assert.equal((await store.beginWorkspaceDeletion(workspaceId,"2026-07-19T00:05:00.000Z",owner)).kind,"ready");
    await store.jsonDocs.delete("sandbox_run_state",workspaceRun.runId);
    assert.equal((await store.beginWorkspaceDeletion(workspaceId,"2026-07-19T00:06:00.000Z",owner)).kind,"sandbox_not_released");
    assert.equal((await store.findWorkspace(workspaceId))?.lifecycleStatus,"active");
    assert.equal((await store.findProject(projectId))?.lifecycleStatus,"active");
    await store.sandboxRuns.put(cleanedWorkspaceRun);
    assert.equal((await store.updateWorkspaceName(workspaceId,"Writable workspace","2026-07-19T00:07:00.000Z","Retry workspace"))?.name,"Writable workspace");

    assert.equal((await store.beginWorkspaceDeletion(workspaceId,"2026-07-19T00:08:00.000Z",owner)).kind,"ready");
    assert.equal((await store.beginWorkspaceDeletion(workspaceId,"2026-07-19T00:09:00.000Z",owner)).kind,"ready");
  });

  it("filters project audit events by exact resource before pagination", async () => {
    const timestamp = "2026-07-15T00:00:00.000Z";
    await store.createUser({ id:"user_audit_resource",email:"audit-resource@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp });
    await store.createWorkspace({ id:"ws_audit_resource",name:"Audit resource",ownerUserId:"user_audit_resource",createdAt:timestamp,updatedAt:timestamp });
    await store.createProject({ id:"proj_audit_resource",workspaceId:"ws_audit_resource",name:"Audit resource",ownerUserId:"user_audit_resource",rootPath:"workspaces/ws_audit_resource/projects/proj_audit_resource",taskConcurrencyLimit:1,createdAt:timestamp,updatedAt:timestamp });
    await store.appendProjectAuditEvent({id:"audit_resource_target",projectId:"proj_audit_resource",actorId:"user_audit_resource",action:"alert.resolve",status:"accepted",resourceKind:"alert",resourceId:"alert_target",createdAt:timestamp});
    await store.appendProjectAuditEvent({id:"audit_resource_other",projectId:"proj_audit_resource",actorId:null,action:"alert.resolve",status:"accepted",resourceKind:"alert",resourceId:"alert_other",createdAt:"2026-07-15T00:00:01.000Z"});

    const page = await store.queryProjectAuditEvents("proj_audit_resource", { limit:1,actorId:"user_audit_resource",resourceKind:"alert",resourceId:"alert_target" });

    assert.deepEqual(page.items.map((event) => event.id), ["audit_resource_target"]);
    assert.equal(page.nextCursor, null);
    assert.deepEqual((await store.queryProjectAuditEvents("proj_audit_resource", { limit:10,actorId:null })).items.map((event)=>event.id),["audit_resource_other"]);
  });

  it("initializes a new task interaction snapshot with complete history", async () => {
    const timestamp = "2026-07-13T00:00:00.000Z";
    await store.createUser({ id: "user_interaction_sync", email: "interaction-sync@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_interaction_sync", name: "Interaction sync", ownerUserId: "user_interaction_sync", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_interaction_sync", workspaceId: "ws_interaction_sync", name: "Interaction sync", ownerUserId: "user_interaction_sync", rootPath: "workspaces/ws_interaction_sync/projects/proj_interaction_sync", taskConcurrencyLimit: 1, createdAt: timestamp, updatedAt: timestamp });
    await createTestCredential(store, "proj_interaction_sync", "cred_interaction_sync", timestamp);
    await store.createEndpoint(endpointRecord("endpoint_interaction_sync", "proj_interaction_sync", "cred_interaction_sync", timestamp));
    await createTaskWithLibrary(store, { id: "task_interaction_sync", workspaceId: "ws_interaction_sync", projectId: "proj_interaction_sync", endpointId: "endpoint_interaction_sync", prompt: "hello", status: "starting", runId: "run_interaction_sync", executionMode: "live", sandbox: { namespace: "agentsmith", resources: [] }, createdAt: timestamp, updatedAt: timestamp });

    const snapshot = await store.readTaskInteractionSnapshot("task_interaction_sync", null, 10);
    assert.equal(snapshot?.sourceCursor, null);
    assert.equal(snapshot?.historyStatus, "complete");
    assert.equal(snapshot?.lastSyncedAt, null);
  });

  it("atomically enforces active task capacity across concurrent store requests", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    await store.createUser({ id: "user_policy", email: "policy@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_policy", name: "Policy", ownerUserId: "user_policy", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_policy", workspaceId: "ws_policy", name: "Policy", ownerUserId: "user_policy", rootPath: "workspaces/ws_policy/projects/proj_policy", taskConcurrencyLimit: 1, createdAt: timestamp, updatedAt: timestamp });
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });

    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
      services.policies.reserveTask("proj_policy", "user_policy", `task-${index}`)
    ));

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await store.findProjectResourceUsage("proj_policy"))?.activeTasks, 1);
  });

  it("atomically enforces the matching active-task and file-byte deltas without blocking releases", async () => {
    const timestamp = "2026-07-12T00:00:00.000Z";
    await store.createUser({ id: "user_quota", email: "quota@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_quota", name: "Quota", ownerUserId: "user_quota", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_quota", workspaceId: "ws_quota", name: "Quota", ownerUserId: "user_quota", rootPath: "workspaces/ws_quota/projects/proj_quota", taskConcurrencyLimit: 1, createdAt: timestamp, updatedAt: timestamp });
    await createTestCredential(store, "proj_quota", "cred_quota", timestamp);
    await store.createEndpoint(endpointRecord("endpoint_quota", "proj_quota", "cred_quota", timestamp));
    await createTaskWithLibrary(store, { id: "task_quota", workspaceId: "ws_quota", projectId: "proj_quota", endpointId: "endpoint_quota", prompt: "quota", status: "completed", runId: "run_quota", executionMode: "dry-run", sandbox: { namespace: "agentsmith", resources: [] }, createdAt: timestamp, updatedAt: timestamp });
    await store.appendTaskArtifacts([{ id: "artifact_quota", taskId: "task_quota", fileId: "file_quota", name: "result.txt", bytes: 2, mediaType: "text/plain", previewText: null, createdAt: timestamp }]);

    await store.patchProjectResourcePolicy("proj_quota", { projectFileBytesLimit: 0 }, timestamp);
    assert.equal(await adjustFileBytes(store, "proj_quota", 1, timestamp), null);
    assert.equal((await store.findProjectResourceUsage("proj_quota"))?.projectFileBytes, 0);
    assert.equal((await store.setProjectFileBytes("proj_quota", 9, timestamp))?.projectFileBytes, 9);
    assert.equal((await store.setProjectFileBytes("proj_quota", 0, timestamp))?.projectFileBytes, 0);

    await store.patchProjectResourcePolicy("proj_quota", { projectFileBytesLimit: 1 }, timestamp);
    assert.equal((await adjustFileBytes(store, "proj_quota", 1, timestamp))?.projectFileBytes, 1);
    assert.equal(await adjustFileBytes(store, "proj_quota", 1, timestamp), null);
    assert.equal((await store.findProjectResourceUsage("proj_quota"))?.projectFileBytes, 1);
    assert.equal((await adjustFileBytes(store, "proj_quota", -1, timestamp))?.projectFileBytes, 0);

    const concurrent = await Promise.all([adjustFileBytes(store, "proj_quota", 1, timestamp), adjustFileBytes(store, "proj_quota", 1, timestamp)]);
    assert.equal(concurrent.filter(Boolean).length, 1);
    assert.equal((await store.findProjectResourceUsage("proj_quota"))?.projectFileBytes, 1);

    await store.patchProjectResourcePolicy("proj_quota", { activeTasksLimit: 0 }, timestamp);
    assert.equal(await adjustActiveTasks(store, "proj_quota", 1, timestamp), null);
    await store.patchProjectResourcePolicy("proj_quota", { activeTasksLimit: 1 }, timestamp);
    assert.equal((await adjustActiveTasks(store, "proj_quota", 1, timestamp))?.activeTasks, 1);
    await store.patchProjectResourcePolicy("proj_quota", { activeTasksLimit: 0 }, timestamp);
    assert.equal((await adjustActiveTasks(store, "proj_quota", -1, timestamp))?.activeTasks, 0);

    await store.upsertProjectMembership({ projectId: "proj_quota", userId: "user_quota", role: "owner", createdAt: timestamp, updatedAt: timestamp });
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    await services.alertRules.create("user_quota", "proj_quota", { alertType: "project_file_bytes_limit" });
    await services.policies.raiseAlert("proj_quota", "project_file_bytes_limit");
    const [alert] = await services.policies.alerts("user_quota", "proj_quota");
    await services.policies.transitionAlert("user_quota", "proj_quota", alert!.id, "resolved");
    assert.equal((await store.listProjectAuditEvents("proj_quota")).some((event) => event.action === "alert.resolve" && event.resourceKind === "alert"), true);
  });

  it("atomically blocks endpoint deletion for tasks and unlinks settlement history", async () => {
    const timestamp = "2026-07-12T00:00:00.000Z";
    await store.createUser({ id: "user_endpoint_delete", email: "endpoint-delete@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_endpoint_delete", name: "Endpoint delete", ownerUserId: "user_endpoint_delete", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_endpoint_delete", workspaceId: "ws_endpoint_delete", name: "Endpoint delete", ownerUserId: "user_endpoint_delete", rootPath: "workspaces/ws_endpoint_delete/projects/proj_endpoint_delete", taskConcurrencyLimit: 2, createdAt: timestamp, updatedAt: timestamp });
    await createTestCredential(store, "proj_endpoint_delete", "cred_endpoint_delete", timestamp);

    const blockedEndpoint = endpointRecord("endpoint_delete_blocked", "proj_endpoint_delete", "cred_endpoint_delete", timestamp);
    await store.createEndpoint(blockedEndpoint);
    await settleProvider(store, "settlement_endpoint_delete_blocked", blockedEndpoint.projectId, blockedEndpoint.id, timestamp);
    await createTaskWithLibrary(store, {
      id: "task_endpoint_delete_blocked",
      workspaceId: "ws_endpoint_delete",
      projectId: blockedEndpoint.projectId,
      endpointId: blockedEndpoint.id,
      prompt: "Retain endpoint",
      status: "completed",
      runId: "run_endpoint_delete_blocked",
      executionMode: "dry-run",
      sandbox: { namespace: "agentsmith", resources: [] },
      createdAt: timestamp,
      updatedAt: timestamp
    });

    assert.equal(await store.deleteEndpoint(blockedEndpoint.id), "referenced_by_tasks");
    assert.equal((await store.findEndpoint(blockedEndpoint.id))?.id, blockedEndpoint.id);
    assert.equal((await store.listSettledProjectProviderSettlements(blockedEndpoint.projectId, "2026-07-01T00:00:00.000Z")).find((item) => item.id === "settlement_endpoint_delete_blocked")?.endpointId, blockedEndpoint.id);

    const deletedEndpoint = endpointRecord("endpoint_delete_history", "proj_endpoint_delete", "cred_endpoint_delete", timestamp);
    await store.createEndpoint(deletedEndpoint);
    await settleProvider(store, "settlement_endpoint_delete_history", deletedEndpoint.projectId, deletedEndpoint.id, timestamp);
    await store.upsertActiveProjectAlert({ id: "alert_endpoint_delete_generic", projectId: deletedEndpoint.projectId, type: "endpoint_failure", status: "active", deliveryStatus: "not_configured", endpointId: null, createdAt: timestamp, updatedAt: timestamp, resolvedAt: null, dismissedAt: null });
    await store.upsertActiveProjectAlert({ id: "alert_endpoint_delete_scoped", projectId: deletedEndpoint.projectId, type: "endpoint_failure", status: "active", deliveryStatus: "not_configured", endpointId: deletedEndpoint.id, createdAt: timestamp, updatedAt: timestamp, resolvedAt: null, dismissedAt: null });

    assert.equal(await store.deleteEndpoint(deletedEndpoint.id), "deleted");
    assert.equal(await store.findEndpoint(deletedEndpoint.id), null);
    assert.equal((await store.listSettledProjectProviderSettlements(deletedEndpoint.projectId, "2026-07-01T00:00:00.000Z")).find((item) => item.id === "settlement_endpoint_delete_history")?.endpointId, null);
    const endpointAlerts = await store.listProjectAlerts(deletedEndpoint.projectId);
    assert.equal(endpointAlerts.find((alert) => alert.id === "alert_endpoint_delete_generic")?.status, "active");
    assert.deepEqual(
      endpointAlerts.filter((alert) => alert.id === "alert_endpoint_delete_scoped").map((alert) => [alert.status, alert.endpointId, Boolean(alert.resolvedAt)]),
      [["resolved", null, true]]
    );
    assert.equal(await store.deleteEndpoint("endpoint_delete_missing"), "not_found");
  });

  it("keeps resolved project alerts as history while allowing one new active event per type", async () => {
    const timestamp = "2026-07-12T00:00:00.000Z";
    await store.createUser({ id: "user_alert_history", email: "alert-history@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_alert_history", name: "Alert history", ownerUserId: "user_alert_history", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_alert_history", workspaceId: "ws_alert_history", name: "Alert history", ownerUserId: "user_alert_history", rootPath: "workspaces/ws_alert_history/projects/proj_alert_history", taskConcurrencyLimit: 1, createdAt: timestamp, updatedAt: timestamp });
    const first = await store.upsertActiveProjectAlert({ id: "alert_history_1", projectId: "proj_alert_history", type: "task_failure", status: "active", deliveryStatus: "pending", createdAt: timestamp, updatedAt: timestamp, resolvedAt: null, dismissedAt: null });
    assert.equal((await store.updateProjectAlertDeliveryStatus(first.projectId, first.id, "delivered", "2026-07-12T00:01:00.000Z"))?.deliveryStatus, "delivered");
    assert.equal((await store.transitionProjectAlert(first.projectId, first.id, "resolved", "2026-07-12T00:02:00.000Z"))?.status, "resolved");
    await store.upsertActiveProjectAlert({ id: "alert_history_2", projectId: first.projectId, type: first.type, status: "active", deliveryStatus: "not_configured", createdAt: "2026-07-12T00:03:00.000Z", updatedAt: "2026-07-12T00:03:00.000Z", resolvedAt: null, dismissedAt: null });
    assert.deepEqual((await store.listProjectAlerts(first.projectId)).map((alert) => [alert.id, alert.status]), [["alert_history_2", "active"], ["alert_history_1", "resolved"]]);
  });

  it("imports a legacy endpoint alias into a credential binding and clears the alias", async () => {
    const timestamp = "2026-07-11T00:00:00.000Z";
    await store.createUser({ id: "user_legacy_credential", email: "legacy-credential@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_legacy_credential", name: "Legacy credential", ownerUserId: "user_legacy_credential", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_legacy_credential", workspaceId: "ws_legacy_credential", name: "Legacy credential", ownerUserId: "user_legacy_credential", rootPath: "workspaces/ws_legacy_credential/projects/proj_legacy_credential", taskConcurrencyLimit: 1, createdAt: timestamp, updatedAt: timestamp });

    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      await client.query(
        `insert into model_endpoints (
           id, project_id, name, protocol, base_url, model, api_key_secret_ref,
           capabilities, request_timeout_secs, created_at, updated_at
         ) values ($1, $2, 'Legacy endpoint', 'openai_chat_completions', $3, 'legacy-model', $4, '[]'::jsonb, 30, $5, $5)`,
        ["endpoint_legacy_credential", "proj_legacy_credential", "https://models.example.test/v1", "secret/legacy-model", timestamp]
      );
    } finally {
      await client.end();
    }

    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    await services.credentials.importLegacyAliasesFromEnvironment({
      AGENTSMITH_LITE_MODEL_API_KEY_LEGACY_MODEL: "legacy-provider-secret",
      AGENTSMITH_LITE_MODEL_BASE_URL_LEGACY_MODEL: "https://models.example.test/v1"
    });
    await services.credentials.importLegacyAliasesFromEnvironment({
      AGENTSMITH_LITE_MODEL_API_KEY_LEGACY_MODEL: "legacy-provider-secret",
      AGENTSMITH_LITE_MODEL_BASE_URL_LEGACY_MODEL: "https://models.example.test/v1"
    });

    const endpoint = await store.findEndpoint("endpoint_legacy_credential");
    assert.ok(endpoint?.credentialId);
    assert.equal((await store.listProjectCredentials("proj_legacy_credential")).length, 1);

    const verificationClient = new pg.Client({ connectionString: postgresUrl });
    await verificationClient.connect();
    try {
      const persisted = await verificationClient.query<{ credential_id: string | null; api_key_secret_ref: string | null }>(
        "select credential_id, api_key_secret_ref from model_endpoints where id = $1",
        ["endpoint_legacy_credential"]
      );
      assert.deepEqual(persisted.rows, [{ credential_id: endpoint.credentialId, api_key_secret_ref: null }]);
    } finally {
      await verificationClient.end();
    }
  });

  it("persists profile preferences and lifecycle updates without replacing created timestamps", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    await store.createUser({ id: "user_profile", email: "profile@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_profile", name: "Old", ownerUserId: "user_profile", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_profile", workspaceId: "ws_profile", name: "Old", ownerUserId: "user_profile", rootPath: "workspaces/ws_profile/projects/proj_profile", taskConcurrencyLimit: 1, createdAt: timestamp, updatedAt: timestamp });
    const updatedAt = "2026-07-04T00:01:00.000Z";
    assert.equal((await store.updateWorkspaceName("ws_profile", "New", updatedAt, "Old"))?.createdAt, timestamp);
    assert.equal((await store.updateProjectName("proj_profile", "New", updatedAt, "Old"))?.createdAt, timestamp);
    assert.equal(await store.updateWorkspaceName("ws_profile", "Stale", "2026-07-04T00:01:01.000Z", "Old"), null);
    assert.equal(await store.updateProjectName("proj_profile", "Stale", "2026-07-04T00:01:01.000Z", "Old"), null);
    const profile = { userId: "user_profile", displayName: "Profile", timezone: "UTC", bio: null, jobTitle: null, company: null, greetingPreference: null, interests: [], updatedAt };
    assert.equal((await store.upsertUserProfilePreferences(profile, null))?.displayName, "Profile");
    assert.equal(await store.upsertUserProfilePreferences({ ...profile, displayName: "Duplicate" }, null), null);
    const nextProfile = { ...profile, displayName: "Updated profile", updatedAt: "2026-07-04T00:02:00.000Z" };
    assert.equal((await store.upsertUserProfilePreferences(nextProfile, updatedAt))?.displayName, "Updated profile");
    assert.equal(await store.upsertUserProfilePreferences({ ...nextProfile, displayName: "Stale" }, updatedAt), null);
    assert.deepEqual(await store.findUserProfilePreferences("user_profile"), nextProfile);
  });

  it("persists at most one concurrent task when its active reservation is limited", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    await store.createUser({ id: "user_task_reservation", email: "task-reservation@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_task_reservation", name: "Tasks", ownerUserId: "user_task_reservation", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_task_reservation", workspaceId: "ws_task_reservation", name: "Tasks", ownerUserId: "user_task_reservation", rootPath: "workspaces/ws_task_reservation/projects/proj_task_reservation", taskConcurrencyLimit: 1, createdAt: timestamp, updatedAt: timestamp });
    await createTestCredential(store, "proj_task_reservation", "cred_test", timestamp);
    await store.createEndpoint({ id: "endpoint_reservation", projectId: "proj_task_reservation", name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "m", credentialId: "cred_test", capabilities: ["text"], requestTimeoutSecs: 30, createdAt: timestamp, updatedAt: timestamp });

    const created = await Promise.all(Array.from({ length: 8 }, (_, index) => createTaskWithLibrary(store, {
      id: `task_reservation_${index}`,
      workspaceId: "ws_task_reservation",
      projectId: "proj_task_reservation",
      endpointId: "endpoint_reservation",
      prompt: "task",
      status: "starting",
      runId: `run_reservation_${index}`,
      executionMode: "dry-run",
      sandbox: { namespace: "agentsmith", resources: [] },
      createdAt: timestamp,
      updatedAt: timestamp
    }, true)));

    assert.equal(created.filter((result) => result.kind === "created").length, 1);
    assert.equal((await store.listTasksForProject("proj_task_reservation")).length, 1);
    assert.equal((await store.findProjectResourceUsage("proj_task_reservation"))?.activeTasks, 1);
  });

  it("creates policy state with the project and atomically reserves provider settlements", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    await store.createUser({ id: "user_provider", email: "provider@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_provider", name: "Provider", ownerUserId: "user_provider", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_provider", workspaceId: "ws_provider", name: "Provider", ownerUserId: "user_provider", rootPath: "workspaces/ws_provider/projects/proj_provider", taskConcurrencyLimit: 2, createdAt: timestamp, updatedAt: timestamp });
    await createTestCredential(store, "proj_provider", "cred_provider", timestamp);
    await store.createEndpoint({ id: "endpoint_provider", projectId: "proj_provider", name: "Provider endpoint", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "m", credentialId: "cred_provider", capabilities: ["text"], requestTimeoutSecs: 30, createdAt: timestamp, updatedAt: timestamp });
    await store.patchProjectResourcePolicy("proj_provider", { providerRequestsLimit: 1 }, "2026-07-04T00:01:00.000Z");

    const reservations = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      store.reserveProjectProviderSettlement({ id: `settlement_${index}`, projectId: "proj_provider", taskId: null, endpointId: "endpoint_provider", actorId: "user_provider", reservedTokens: 4096, reservedCost: 1, reservedAt: "2026-07-04T00:01:01.000Z", expiresAt: "2026-07-04T00:06:01.000Z" })
    ));

    assert.equal((await store.findProjectMembership("proj_provider", "user_provider"))?.role, "owner");
    assert.equal((await store.findProjectResourcePolicy("proj_provider"))?.activeTasksLimit, 2);
    assert.equal((await store.findProjectResourceUsage("proj_provider"))?.providerRequests, 1);
    assert.equal(reservations.filter(Boolean).length, 1);
  });

  it("validates new endpoints with project-scoped settlements and rechecks persisted endpoints with endpoint scope", async () => {
    let available = true;
    let validationCalls = 0;
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      providerClient: {
        async completeChat() { throw new Error("not used"); },
        async validateEndpoint() {
          validationCalls += 1;
          return available ? { status: "healthy" as const } : { status: "unavailable" as const, errorCategory: "auth" as const };
        }
      }
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Endpoint validation" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Endpoint validation" });
    const credential = await services.credentials.create(user.id, project.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "provider-secret" });
    const input = { name: "Provider", protocol: "openai_chat_completions" as const, baseUrl: credential.baseUrl, model: "model", credentialId: credential.id, capabilities: ["text" as const], requestTimeoutSecs: 30 };

    const endpoint = await services.endpoints.createEndpoint(user.id, project.id, input);
    available = false;
    await assert.rejects(
      () => services.endpoints.createEndpoint(user.id, project.id, { ...input, name: "Invalid provider" }),
      /Endpoint validation failed: auth/
    );
    assert.deepEqual((await store.listEndpointsForProject(project.id)).map((item) => item.id), [endpoint.id]);

    await services.policies.updatePolicy(user.id, project.id, { endpointWindows: [{ endpointId: endpoint.id, metric: "providerRequests", limit: 1, windowSeconds: 60 }] });
    available = true;
    await services.endpoints.recheckEndpoint(user.id, project.id, endpoint.id);
    await assert.rejects(() => services.endpoints.recheckEndpoint(user.id, project.id, endpoint.id), /Endpoint rolling provider requests limit reached/);

    const settlements = await store.listSettledProjectProviderSettlements(project.id, "1970-01-01T00:00:00.000Z");
    assert.equal(settlements.filter((settlement) => settlement.endpointId === null).length, 2);
    assert.equal(settlements.filter((settlement) => settlement.endpointId === endpoint.id).length, 1);
    assert.equal((await store.findProjectResourceUsage(project.id))?.providerRequests, 3);
    assert.equal(validationCalls, 3);
  });

  it("enforces project endpoint name uniqueness across concurrent creates and renames", async () => {
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      providerClient: {
        async completeChat() { throw new Error("not used"); },
        async validateEndpoint() { return { status: "healthy" as const }; }
      }
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Endpoint names" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Endpoint names" });
    const credential = await services.credentials.create(user.id, project.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "provider-secret" });
    const input = (name: string) => ({ name, protocol: "openai_chat_completions" as const, baseUrl: credential.baseUrl, model: "model", credentialId: credential.id, capabilities: ["text" as const], requestTimeoutSecs: 30 });

    const created = await Promise.allSettled([
      services.endpoints.createEndpoint(user.id, project.id, input("Primary")),
      services.endpoints.createEndpoint(user.id, project.id, input(" primary "))
    ]);
    assert.equal(created.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = created.find((result) => result.status === "rejected");
    assert.match(String(rejected?.status === "rejected" ? rejected.reason : ""), /endpoint already uses that name/i);

    const primary = (await services.endpoints.listEndpoints(user.id, project.id))[0]!;
    const secondary = await services.endpoints.createEndpoint(user.id, project.id, input("Secondary"));
    await assert.rejects(
      () => services.endpoints.updateEndpoint(user.id, project.id, secondary.id, { ...input(primary.name.toUpperCase()), credentialId: credential.id, expectedUpdatedAt:secondary.updatedAt }),
      /endpoint already uses that name/i
    );
  });

  it("rejects endpoint health validated against a credential version that rotated before commit", async () => {
    let validationStarted!: () => void;
    let finishValidation!: () => void;
    const started = new Promise<void>((resolve) => { validationStarted = resolve; });
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      providerClient: {
        async completeChat() { throw new Error("not used"); },
        async validateEndpoint() {
          validationStarted();
          return new Promise<{status:"healthy"}>((resolve) => { finishValidation = () => resolve({ status:"healthy" }); });
        }
      }
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name:"Credential race" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name:"Credential race" });
    const credential = await services.credentials.create(user.id, project.id, { name:"Provider", baseUrl:"https://models.example.test/v1", secret:"first-secret" });

    const creating = services.endpoints.createEndpoint(user.id, project.id, { name:"Provider", protocol:"openai_chat_completions", baseUrl:credential.baseUrl, model:"model", credentialId:credential.id, capabilities:["text"], requestTimeoutSecs:30 });
    await started;
    await services.credentials.rotate(user.id, project.id, credential.id, { secret:"second-secret" });
    finishValidation();

    await assert.rejects(creating, /Credential changed during endpoint validation/);
    assert.deepEqual(await store.listEndpointsForProject(project.id), []);
  });

  it("settles provider token/cost overage and opens the corresponding project alerts", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    await store.createUser({ id: "user_settlement", email: "settlement@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_settlement", name: "Settlement", ownerUserId: "user_settlement", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_settlement", workspaceId: "ws_settlement", name: "Settlement", ownerUserId: "user_settlement", rootPath: "workspaces/ws_settlement/projects/proj_settlement", taskConcurrencyLimit: 2, createdAt: timestamp, updatedAt: timestamp });
    await createTestCredential(store, "proj_settlement", "cred_test", timestamp);
    await store.createEndpoint({ id: "endpoint_settlement", projectId: "proj_settlement", name: "Settlement endpoint", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "m", credentialId: "cred_test", capabilities: ["text"], requestTimeoutSecs: 30, createdAt: timestamp, updatedAt: timestamp });
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    await store.patchProjectResourcePolicy("proj_settlement", { providerTokensLimit: 5, providerCostLimit: 1 }, "2026-07-04T00:01:00.000Z");

    const settlement = await services.policies.reserveProvider("proj_settlement", "user_settlement", "endpoint_settlement", null, { tokens: 5, cost: 1 });
    await services.policies.markProviderDispatched(settlement);
    await services.policies.markProviderDelivered(settlement);
    await services.policies.settleProvider(settlement, { tokens: 7, cost: 2 });
    await services.policies.settleProvider(settlement, { tokens: 70, cost: 20 });

    assert.deepEqual((await store.findProjectResourceUsage("proj_settlement")) && {
      tokens: (await store.findProjectResourceUsage("proj_settlement"))?.providerTokens,
      cost: (await store.findProjectResourceUsage("proj_settlement"))?.providerCost
    }, { tokens: 7, cost: 2 });
    assert.deepEqual((await store.listActiveProjectAlerts("proj_settlement")).map((alert) => alert.type).sort(), ["provider_cost_limit", "provider_tokens_limit"]);
  });

  it("expires active settlements atomically and finalizes one pending task intent once", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    await store.createUser({ id: "user_ledger", email: "ledger@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_ledger", name: "Ledger", ownerUserId: "user_ledger", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_ledger", workspaceId: "ws_ledger", name: "Ledger", ownerUserId: "user_ledger", rootPath: "workspaces/ws_ledger/projects/proj_ledger", taskConcurrencyLimit: 2, createdAt: timestamp, updatedAt: timestamp });
    await createTestCredential(store, "proj_ledger", "cred_test", timestamp);
    await store.createEndpoint({ id: "endpoint_ledger", projectId: "proj_ledger", name: "Ledger endpoint", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "m", credentialId: "cred_test", capabilities: ["text"], requestTimeoutSecs: 30, createdAt: timestamp, updatedAt: timestamp });
    await store.reserveProjectProviderSettlement({ id: "settlement_ledger", projectId: "proj_ledger", taskId: null, endpointId: "endpoint_ledger", actorId: "user_ledger", reservedTokens: 4096, reservedCost: 1, reservedAt: timestamp, expiresAt: "2026-07-04T00:00:01.000Z" });
    await store.reserveProjectProviderSettlement({ id: "settlement_dispatched", projectId: "proj_ledger", taskId: null, endpointId: "endpoint_ledger", actorId: "user_ledger", reservedTokens: 2048, reservedCost: 0.5, reservedAt: timestamp, expiresAt: "2026-07-04T00:00:01.000Z" });
    await store.markProjectProviderSettlementDispatched("settlement_dispatched", timestamp);
    await store.reserveProjectProviderSettlement({ id: "settlement_delivered", projectId: "proj_ledger", taskId: null, endpointId: "endpoint_ledger", actorId: "user_ledger", reservedTokens: 1024, reservedCost: 0.25, reservedAt: timestamp, expiresAt: "2026-07-04T00:00:01.000Z" });
    await store.markProjectProviderSettlementDispatched("settlement_delivered", timestamp);
    await store.markProjectProviderSettlementDelivered("settlement_delivered", timestamp);
    await store.reserveProjectProviderSettlement({ id: "settlement_settled", projectId: "proj_ledger", taskId: null, endpointId: "endpoint_ledger", actorId: "user_ledger", reservedTokens: 512, reservedCost: 0.125, reservedAt: timestamp, expiresAt: "2026-07-04T00:00:01.000Z" });
    await store.markProjectProviderSettlementDispatched("settlement_settled", timestamp);
    await store.settleProjectProviderSettlement("settlement_settled", { tokens: 7, cost: 0.01 }, timestamp);
    assert.deepEqual(await store.measureProjectProviderWindow({projectId:"proj_ledger",endpointId:"endpoint_ledger",actorId:"user_ledger",metric:"providerTokens",since:timestamp}),{current:7175,oldestReservedAt:timestamp});
    assert.equal(await store.expireProjectProviderSettlements("2026-07-04T00:00:02.000Z"), 3);
    const usage = await store.findProjectResourceUsage("proj_ledger");
    assert.equal(usage?.providerRequests, 3);
    assert.equal(usage?.providerTokens, 3079);
    assert.ok(Math.abs((usage?.providerCost ?? 0) - 0.76) < 1e-9);
    assert.ok(await store.settleProjectProviderSettlement("settlement_dispatched", { tokens: 1 }, timestamp));
    assert.ok(await store.settleProjectProviderSettlement("settlement_delivered", { tokens: 1 }, timestamp));
    const lateUsage = await store.findProjectResourceUsage("proj_ledger");
    assert.equal(lateUsage?.providerTokens, 9);
    assert.ok(Math.abs((lateUsage?.providerCost ?? 0) - 0.01) < 1e-9);
    const task: PersistedAgentTask = { id: "task_ledger", workspaceId: "ws_ledger", projectId: "proj_ledger", endpointId: "endpoint_ledger", fileLibraryId: "library_task_ledger", prompt: "task", status: "running", runId: "run_ledger", executionMode: "dry-run", sandbox: { namespace: "agentsmith", resources: [] }, createdAt: timestamp, updatedAt: timestamp };
    await createTaskWithLibrary(store, task, true);
    await Promise.all([store.requestTaskFinalization(task.id, "failed", timestamp), store.requestTaskFinalization(task.id, "completed", timestamp)]);
    await Promise.all([store.finalizeTaskAndReleaseActiveReservation(task.id, "failed", timestamp), store.finalizeTaskAndReleaseActiveReservation(task.id, "completed", timestamp)]);
    assert.equal((await store.findProjectResourceUsage("proj_ledger"))?.activeTasks, 0);
  });

  it("patches nullable project policy limits with column-typed parameters", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    await store.createUser({ id: "user_patch", email: "patch@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_patch", name: "Patch", ownerUserId: "user_patch", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_patch", workspaceId: "ws_patch", name: "Patch", ownerUserId: "user_patch", rootPath: "workspaces/ws_patch/projects/proj_patch", taskConcurrencyLimit: 1, createdAt: timestamp, updatedAt: timestamp });

    const updated = await store.patchProjectResourcePolicy("proj_patch", { providerRequestsLimit: null, providerCostLimit: 3.5 }, "2026-07-04T00:01:00.000Z", timestamp);

    assert.equal(updated?.providerRequestsLimit, null);
    assert.equal(updated?.providerCostLimit, 3.5);
    assert.equal(updated?.activeTasksLimit, 1);
    assert.equal(await store.patchProjectResourcePolicy("proj_patch", { providerCostLimit: 7 }, "2026-07-04T00:02:00.000Z", timestamp),null);
    const rule=await store.createProjectAlertRule({id:"rule_patch",projectId:"proj_patch",alertType:"task_failure",metric:"failure_count",threshold:1,windowSeconds:3600,scope:{kind:"project"},enabled:true,createdAt:timestamp,updatedAt:timestamp});
    assert.ok(await store.updateProjectAlertRule({...rule,threshold:2,updatedAt:"2026-07-04T00:01:00.000Z"},timestamp));
    assert.equal(await store.updateProjectAlertRule({...rule,threshold:3,updatedAt:"2026-07-04T00:02:00.000Z"},timestamp),null);
  });

  it("persists product records with idempotent task event and artifact appends", async () => {
    const user: StoredUser = {
      id: "user_pg",
      email: "User@Example.test",
      emailVerified: false,
      passwordHash: "hash",
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z"
    };
    const workspace: Workspace = {
      id: "ws_pg",
      name: "Ops",
      ownerUserId: user.id,
      lifecycleStatus: "active",
      createdAt: "2026-07-04T00:01:00.000Z",
      updatedAt: "2026-07-04T00:01:00.000Z"
    };
    const project: Project = {
      id: "proj_pg",
      workspaceId: workspace.id,
      name: "Sandbox",
      ownerUserId: user.id,
      rootPath: "workspaces/ws_pg/projects/proj_pg",
      taskConcurrencyLimit: 2,
      lifecycleStatus: "active",
      createdAt: "2026-07-04T00:02:00.000Z",
      updatedAt: "2026-07-04T00:02:00.000Z"
    };
    const membership: ProjectMembership = {
      projectId: project.id,
      userId: user.id,
      role: "member",
      createdAt: "2026-07-04T00:02:30.000Z",
      updatedAt: "2026-07-04T00:02:30.000Z"
    };
    const endpoint: ModelEndpoint = {
      id: "endp_pg",
      projectId: project.id,
      name: "OpenAI compatible",
      protocol: "openai_chat_completions",
      baseUrl: "https://models.example.test/v1",
      model: "gpt-compatible",
      credentialId: "cred_test",
      capabilities: ["text", "tool_calls"],
      requestTimeoutSecs: 30,
      health: { status: "unknown", checkedAt: null, errorCategory: null },
      createdAt: "2026-07-04T00:03:00.000Z",
      updatedAt: "2026-07-04T00:03:00.000Z"
    };
    const task: PersistedAgentTask = {
      id: "task_pg",
      workspaceId: workspace.id,
      projectId: project.id,
      endpointId: endpoint.id,
      fileLibraryId: "library_task_pg",
      prompt: "build",
      status: "starting",
      runId: "run_pg",
      executionMode: "live",
      sandbox: { namespace: "agentsmith", resources: [] },
      createdAt: "2026-07-04T00:04:00.000Z",
      updatedAt: "2026-07-04T00:04:00.000Z"
    };
    const interaction: TaskAssistantMessageInteraction = {
      id: "assistant_pg",
      revision: 1,
      taskId: task.id,
      kind: "assistant_message",
      title: "Assistant",
      body: "hello",
      contentMode: "full",
      position: 1,
      status: "generating",
      occurredAt: "2026-07-04T00:05:00.000Z",
      updatedAt: "2026-07-04T00:05:00.000Z"
    };
    const completedInteraction: TaskAssistantMessageInteraction = {
      ...interaction,
      revision: 2,
      status: "completed",
      updatedAt: "2026-07-04T00:05:01.000Z"
    };
    const artifact: PersistedTaskArtifact = {
      id: "art_pg",
      taskId: task.id,
      fileId: "file_pg",
      name: "readme.md",
      bytes: 12,
      mediaType: null,
      previewText: null,
      createdAt: "2026-07-04T00:06:00.000Z"
    };

    assert.equal(await store.countUsers(), 0);
    assert.deepEqual(await store.createUser(user), {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    });
    assert.equal(await store.countUsers(), 1);
    assert.equal((await store.findUserByEmail("user@example.test"))?.id, user.id);
    assert.deepEqual(await store.createSession({
      id: "sess_pg",
      userId: user.id,
      csrfToken: "csrf_pg",
      oidcIdToken: "postgres-id-token",
      createdAt: "2026-07-04T00:00:00.000Z",
      expiresAt: "2026-07-04T12:00:00.000Z"
    }), {
      id: "sess_pg",
      userId: user.id,
      csrfToken: "csrf_pg",
      oidcIdToken: "postgres-id-token",
      createdAt: "2026-07-04T00:00:00.000Z",
      expiresAt: "2026-07-04T12:00:00.000Z"
    });
    assert.equal((await store.findSession("sess_pg"))?.csrfToken, "csrf_pg");
    assert.equal((await store.findSession("sess_pg"))?.oidcIdToken, "postgres-id-token");
    assert.equal(await store.deleteSession("sess_pg"), true);
    assert.equal(await store.findSession("sess_pg"), null);
    assert.equal(await store.deleteSession("sess_pg"), false);

    await store.createWorkspace(workspace);
    await store.createProject(project);
    await store.upsertProjectMembership(membership);
    await createTestCredential(store, project.id, endpoint.credentialId, endpoint.createdAt);
    await store.createEndpoint(endpoint);
    await createTaskWithLibrary(store, { ...task, createdByUserId:user.id });
    await store.createTaskMessage({ id:"message_pg", taskId:task.id, actorId:user.id, content:"continue", deliveryStatus:"pending", createdAt:task.createdAt, updatedAt:task.updatedAt });
    assert.equal(
      (await store.updateTaskStatusIfStarting(task.id, "running", "2026-07-04T00:07:00.000Z"))?.status,
      "running"
    );
    assert.equal(await store.updateTaskStatusIfStarting(task.id, "running", "2026-07-04T00:07:01.000Z"), null);
    await store.persistTaskInteractionMutation({ taskId:task.id,changes:[{sourceKind:"botified",sourceId:"timeline:1",sourceRevision:0,interaction},{sourceKind:"botified",sourceId:"timeline:1",sourceRevision:0,interaction},{sourceKind:"botified",sourceId:"timeline:2",sourceRevision:0,interaction:completedInteraction}],sourceSync:{expectedSourceCursor:null,sourceCursor:"timeline:2",historyStatus:"complete",lastSyncedAt:completedInteraction.updatedAt} });
    await store.appendTaskArtifacts([artifact, artifact]);
    await assert.rejects(store.persistTaskInteractionMutation({ taskId:task.id,changes:[{sourceKind:"product",sourceId:"conflicting-revision",sourceRevision:1,interaction:completedInteraction}],artifactProjections:[{projectId:project.id,artifact:{...artifact,id:"artifact_rollback",fileId:"file_rollback"},auditEvent:{id:"audit_rollback",projectId:project.id,actorId:null,action:"artifact.project",status:"accepted",resourceKind:"artifact",resourceId:"artifact_rollback",createdAt:"2026-07-04T00:08:00.000Z"},updatedAt:"2026-07-04T00:08:00.000Z"}],lifecycle:{kind:"active",expectedStatus:"running",status:"stopping",updatedAt:"2026-07-04T00:08:00.000Z"},sourceSync:{expectedSourceCursor:"timeline:2",sourceCursor:"timeline:rollback",historyStatus:"gap",lastSyncedAt:"2026-07-04T00:08:00.000Z"} }), /revision is not monotonic/);

    assert.deepEqual(await store.listWorkspacesForUser(user.id), [{ ...workspace, owner: { displayName: null, email: user.email }, memberRole: "owner" }]);
    assert.deepEqual(await store.listProjectsForWorkspace(workspace.id), [project]);
    assert.deepEqual(await store.listProjectsForUser(user.id), [project]);
    const storedMembership = { ...membership, createdAt: project.createdAt };
    assert.deepEqual(await store.findProjectMembership(project.id, user.id), storedMembership);
    assert.deepEqual(await store.listProjectMemberships(project.id), [{ ...storedMembership, displayName: null, email: user.email }]);
    assert.deepEqual(await store.listEndpointsForProject(project.id), [endpoint]);
    const storedTask = await store.findTask(task.id);
    assert.equal(storedTask?.status, "running");
    assert.equal(storedTask?.executionMode, "live");
    assert.equal(storedTask?.createdByUserId, user.id);
    assert.equal((await store.findTaskMessage("message_pg"))?.actorId, user.id);
    assert.deepEqual((await store.listTaskInteractionChanges(task.id,0,10)).map((change)=>[change.changeSeq,change.interaction.revision]), [[1,1],[2,2]]);
    assert.deepEqual((await store.readTaskInteractionSnapshot(task.id,null,10))?.items, [completedInteraction]);
    assert.equal((await store.readTaskInteractionSnapshot(task.id,null,10))?.sourceCursor, "timeline:2");
    assert.deepEqual(await store.listTaskArtifacts(task.id), [artifact]);
  });

  it("round-trips and deduplicates bigint product interaction source revisions", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    await store.createUser({ id:"user_interaction_bigint",email:"interaction-bigint@example.test",emailVerified:false,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp });
    await store.createWorkspace({ id:"ws_interaction_bigint",name:"Interaction bigint",ownerUserId:"user_interaction_bigint",createdAt:timestamp,updatedAt:timestamp });
    await store.createProject({ id:"proj_interaction_bigint",workspaceId:"ws_interaction_bigint",name:"Interaction bigint",ownerUserId:"user_interaction_bigint",rootPath:"workspaces/ws_interaction_bigint/projects/proj_interaction_bigint",taskConcurrencyLimit:1,createdAt:timestamp,updatedAt:timestamp });
    await createTestCredential(store,"proj_interaction_bigint","cred_interaction_bigint",timestamp);
    await store.createEndpoint(endpointRecord("endpoint_interaction_bigint","proj_interaction_bigint","cred_interaction_bigint",timestamp));
    await createTaskWithLibrary(store, { id:"task_interaction_bigint",workspaceId:"ws_interaction_bigint",projectId:"proj_interaction_bigint",endpointId:"endpoint_interaction_bigint",prompt:"hello",status:"running",runId:"run_interaction_bigint",executionMode:"live",sandbox:{namespace:"agentsmith",resources:[]},createdAt:timestamp,updatedAt:timestamp });

    const sourceRevision = 17_840_091_560_973;
    const interaction:TaskAssistantMessageInteraction={ id:"assistant_interaction_bigint",revision:1,taskId:"task_interaction_bigint",kind:"assistant_message",title:"Assistant",body:"hello",contentMode:"full",position:1,status:"completed",occurredAt:timestamp,updatedAt:timestamp };
    const change={ sourceKind:"product" as const,sourceId:"task:task_interaction_bigint:prompt",sourceRevision,interaction };
    const inserted=await store.persistTaskInteractionMutation({ taskId:interaction.taskId,changes:[change] });
    const duplicate=await store.persistTaskInteractionMutation({ taskId:interaction.taskId,changes:[change] });

    assert.equal(sourceRevision>2**31,true);
    assert.deepEqual(inserted.changes.map((item)=>item.sourceRevision),[sourceRevision]);
    assert.deepEqual(duplicate.changes,[]);
    const readback=await store.listTaskInteractionChanges(interaction.taskId,0,10);
    assert.equal(typeof readback[0]?.sourceRevision,"number");
    assert.equal(readback[0]?.sourceRevision,sourceRevision);

    const client=new pg.Client({connectionString:postgresUrl});
    await client.connect();
    try {
      await client.query("update task_interaction_changes set source_revision=$2 where task_id=$1",[interaction.taskId,"9007199254740992"]);
    } finally {
      await client.end();
    }
    await assert.rejects(store.listTaskInteractionChanges(interaction.taskId,0,10),/source revision is invalid/);
  });

  it("atomically binds a legacy OIDC user during concurrent first login", async () => {
    const principal = {
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "legacy-concurrent-user",
      email: "Legacy.Concurrent@Example.Test",
      emailVerified: true
    };
    const userId = oidcUserId(principal.issuer, principal.subject);
    await store.createUser({
      id: userId,
      email: "legacy.concurrent@example.test",
      emailVerified: false,
      passwordHash: "external:oidc",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password"
    });

    const [first, second] = await Promise.all([
      services.auth.loginExternalPrincipal(principal),
      services.auth.loginExternalPrincipal(principal)
    ]);
    const stored = await store.findUserById(userId);

    assert.equal(first.user.id, userId);
    assert.equal(second.user.id, userId);
    assert.equal(await store.countUsers(), 1);
    assert.equal(stored?.oidcIssuer, principal.issuer);
    assert.equal(stored?.oidcSubject, principal.subject);
  });

  it("rejects a legacy OIDC bind when the persisted email differs", async () => {
    const principal = {
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "legacy-email-mismatch",
      email: "login@example.test",
      emailVerified: true
    };
    const userId = oidcUserId(principal.issuer, principal.subject);
    await store.createUser({
      id: userId,
      email: "different@example.test",
      emailVerified: false,
      passwordHash: "external:oidc",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });

    await assert.rejects(() => services.auth.loginExternalPrincipal(principal), /OIDC identity does not match the existing user/);
    const stored = await store.findUserById(userId);
    assert.equal(stored?.oidcIssuer, undefined);
    assert.equal(stored?.oidcSubject, undefined);
    assert.equal(stored?.email, "different@example.test");
  });

  it("does not overwrite a legacy deterministic ID already bound to another OIDC identity", async () => {
    const principal = {
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "new-subject",
      email: "user@example.test",
      emailVerified: true
    };
    const userId = oidcUserId(principal.issuer, principal.subject);
    await store.createUser({
      id: userId,
      email: principal.email,
      oidcIssuer: principal.issuer,
      oidcSubject: "old-subject",
      emailVerified: true,
      passwordHash: "external:oidc",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });

    await assert.rejects(() => services.auth.loginExternalPrincipal(principal), /OIDC identity does not match the existing user/);
    const stored = await store.findUserById(userId);
    assert.equal(stored?.oidcIssuer, principal.issuer);
    assert.equal(stored?.oidcSubject, "old-subject");
  });

  it("implements JSON documents and fenced lease semantics", async () => {
    await store.jsonDocs.put("project_settings", "proj_pg", { concurrency: 2, flags: ["fast"] });
    assert.deepEqual(await store.jsonDocs.get("project_settings", "proj_pg"), { concurrency: 2, flags: ["fast"] });
    await store.jsonDocs.delete("project_settings", "proj_pg");
    assert.equal(await store.jsonDocs.get("project_settings", "proj_pg"), null);

    const first = await store.leases.acquire({
      name: "sandbox:task_pg",
      holder: "api-1",
      ttlMs: 1000,
      now: new Date("2026-07-04T00:00:00.000Z"),
      metadata: { phase: "starting" }
    });
    assert.equal(first.acquired, true);
    assert.equal(first.lease?.fencingToken, 1);

    const blocked = await store.leases.acquire({
      name: "sandbox:task_pg",
      holder: "api-2",
      ttlMs: 1000,
      now: new Date("2026-07-04T00:00:00.500Z")
    });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.lease?.holder, "api-1");

    assert.equal(await store.leases.compareAndSet("sandbox:task_pg", 0, { phase: "running" }), false);
    assert.equal(await store.leases.compareAndSet("sandbox:task_pg", 1, { phase: "running" }), true);
    assert.equal(await store.leases.renew("sandbox:task_pg", 1, 2000, new Date("2026-07-04T00:00:01.000Z")), true);
    assert.deepEqual(await store.leases.listExpired(new Date("2026-07-04T00:00:02.000Z")), []);

    const second = await store.leases.acquire({
      name: "sandbox:task_pg",
      holder: "api-2",
      ttlMs: 1000,
      now: new Date("2026-07-04T00:00:04.000Z")
    });
    assert.equal(second.acquired, true);
    assert.equal(second.lease?.fencingToken, 2);
    assert.equal(await store.leases.release("sandbox:task_pg", 1), false);
    assert.equal(await store.leases.release("sandbox:task_pg", 2), true);

    const run = sandboxRun();
    await store.sandboxRuns.put(run);
    const persistedRun = await store.sandboxRuns.get(run.runId);
    assert.ok(persistedRun);
    assert.deepEqual(persistedRun, run);
    assert.deepEqual((await store.sandboxRuns.listActive()).map((item) => item.runId), [run.runId]);
    assert.equal(
      await store.sandboxRuns.updateWithFencing(run.runId, 0, { ...persistedRun, phase: "running", fencingToken: 2, updatedAt: "2026-07-04T00:00:01.000Z" }),
      null
    );
    const updated = await store.sandboxRuns.updateWithFencing(run.runId, 1, {
      ...persistedRun,
      phase: "running",
      fencingToken: 2,
      updatedAt: "2026-07-04T00:00:01.000Z"
    });
    assert.equal(updated?.phase, "running");
    const cleanupRequested = sandboxRun({
      runId: "run_pg_cleanup_claim",
      taskId: "task_pg_cleanup_claim",
      cleanupStatus: "cleanup_requested",
      releaseReason: "requested",
      updatedAt: "2026-07-04T00:01:00.000Z"
    });
    await store.sandboxRuns.put(cleanupRequested);
    const cleanupClaim = await store.sandboxRuns.claimForCleanup({
      runId: cleanupRequested.runId,
      expectedFencingToken: cleanupRequested.fencingToken,
      claimedAt: "2026-07-04T00:02:00.000Z"
    });
    assert.equal(cleanupClaim?.cleanupStatus, "deleting");
    assert.equal(cleanupClaim?.fencingToken, cleanupRequested.fencingToken + 1);
    assert.equal(cleanupClaim?.updatedAt, "2026-07-04T00:02:00.000Z");
    assert.equal(await store.sandboxRuns.claimForCleanup({
      runId: cleanupRequested.runId,
      expectedFencingToken: cleanupRequested.fencingToken,
      claimedAt: "2026-07-04T00:03:00.000Z"
    }), null);
    const settlementTask:TaskFixture={id:"task_pg_settlement",workspaceId:"ws_pg_settlement",projectId:"proj_pg_settlement",endpointId:"endpoint_pg_settlement",fileLibraryId:"library_task_pg_settlement",createdByUserId:"user_pg_settlement",prompt:"settle",status:"starting",runId:"run_pg_settlement",executionMode:"live",sandbox:{namespace:"agentsmith",resources:[]},activeReservation:true,createdAt:"2026-07-04T00:09:00.000Z",updatedAt:"2026-07-04T00:09:00.000Z"};
    await store.createUser({id:settlementTask.createdByUserId!,email:"settlement@example.test",emailVerified:true,passwordHash:"hash",createdAt:settlementTask.createdAt,updatedAt:settlementTask.updatedAt});
    await store.createWorkspace({id:settlementTask.workspaceId,name:"Settlement",ownerUserId:settlementTask.createdByUserId!,createdAt:settlementTask.createdAt,updatedAt:settlementTask.updatedAt});
    await store.createProject({id:settlementTask.projectId,workspaceId:settlementTask.workspaceId,name:"Settlement",ownerUserId:settlementTask.createdByUserId!,rootPath:`workspaces/${settlementTask.workspaceId}/projects/${settlementTask.projectId}`,taskConcurrencyLimit:1,createdAt:settlementTask.createdAt,updatedAt:settlementTask.updatedAt});
    await createTestCredential(store,settlementTask.projectId,"cred_pg_settlement",settlementTask.createdAt);await store.createEndpoint(endpointRecord(settlementTask.endpointId,settlementTask.projectId,"cred_pg_settlement",settlementTask.createdAt));
    assert.equal((await createTaskWithLibrary(store,settlementTask,true)).kind,"created");
    const settlementResources={cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"};
    const settlementRun=sandboxRun({workspaceId:settlementTask.workspaceId,projectId:settlementTask.projectId,taskId:settlementTask.id,runId:settlementTask.runId,fileLibraryId:settlementTask.fileLibraryId!,startedByUserId:settlementTask.createdByUserId!,startedAt:null,resourceSnapshot:settlementResources,projectSubPath:`workspaces/${settlementTask.workspaceId}/projects/${settlementTask.projectId}`,fileLibraryRootSubPath:`libraries/${settlementTask.fileLibraryId}/home`});await store.sandboxRuns.put(settlementRun);
    const started=await store.confirmSandboxRunStarted({runId:settlementRun.runId,expectedFencingToken:settlementRun.fencingToken,startedAt:"2026-07-04T00:10:00.000Z",auditEvent:{id:"audit_pg_sandbox_started",projectId:settlementRun.projectId,actorId:null,subjectUserId:settlementRun.startedByUserId,action:"sandbox.started",status:"accepted",resourceKind:"sandbox",resourceId:settlementRun.taskId,detail:{taskId:settlementRun.taskId,runId:settlementRun.runId},createdAt:"2026-07-04T00:10:00.000Z"}});assert.notEqual(started.kind,"conflict");if(started.kind==="conflict")return;
    const cleaned={...started.run,phase:"cleaned" as const,cleanupStatus:"cleaned" as const,releaseReason:"requested" as const,fencingToken:started.run.fencingToken+1,updatedAt:"2026-07-04T00:10:05.000Z"};const settlement={runId:cleaned.runId,workspaceId:cleaned.workspaceId,projectId:cleaned.projectId,taskId:cleaned.taskId,fileLibraryId:cleaned.fileLibraryId,startedByUserId:cleaned.startedByUserId,startedAt:cleaned.startedAt,releasedAt:cleaned.updatedAt,durationSeconds:5,resources:cleaned.resourceSnapshot,releaseReason:"requested" as const};const releaseAudit={id:"audit_pg_sandbox_released",projectId:cleaned.projectId,actorId:null,subjectUserId:cleaned.startedByUserId,action:"sandbox.released" as const,status:"accepted" as const,resourceKind:"sandbox" as const,resourceId:cleaned.taskId,detail:{taskId:cleaned.taskId,runId:cleaned.runId,releaseReason:"requested" as const},createdAt:cleaned.updatedAt};
    assert.equal(await store.completeSandboxRunRelease({runId:cleaned.runId,expectedFencingToken:started.run.fencingToken,run:cleaned,settlement,auditEvent:releaseAudit}),"applied");
    const persistedCleaned=await store.sandboxRuns.get(cleaned.runId);assert.ok(persistedCleaned);assert.deepEqual(persistedCleaned,cleaned);
    const persistedSettlements=await store.listSandboxUsageSettlements(cleaned.projectId,cleaned.startedByUserId);assert.equal(persistedSettlements.length,1);const persistedSettlement=persistedSettlements[0]!;assert.deepEqual(persistedSettlement,settlement);assert.deepEqual(persistedSettlement.resources,settlementResources);
    const persistedReleaseAudit=(await store.listProjectAuditEvents(cleaned.projectId)).find((event)=>event.id===releaseAudit.id);assert.deepEqual(persistedReleaseAudit,releaseAudit);
    assert.equal(await store.completeSandboxRunRelease({runId:persistedCleaned.runId,expectedFencingToken:persistedCleaned.fencingToken,run:persistedCleaned,settlement:persistedSettlement,auditEvent:persistedReleaseAudit}),"already_applied");
    assert.equal(await store.completeSandboxRunRelease({runId:persistedCleaned.runId,expectedFencingToken:persistedCleaned.fencingToken,run:persistedCleaned,settlement:{...persistedSettlement,durationSeconds:6},auditEvent:persistedReleaseAudit}),"conflict");

    await store.createTaskMessage({id:"message_pg_interrupted",taskId:settlementTask.id,actorId:settlementTask.createdByUserId!,content:"old pending",deliveryStatus:"pending",createdAt:cleaned.updatedAt,updatedAt:cleaned.updatedAt});
    const releasedTask=await store.findTask(settlementTask.id);assert.ok(releasedTask);assert.equal(releasedTask.activeReservation,false);
    const restartAt="2026-07-04T00:11:00.000Z";
    const restartInput=(suffix:string)=>{const runId=`run_pg_restarted_${suffix}`;const task={...releasedTask,runId,status:"starting" as const,activeReservation:true,updatedAt:restartAt};return{expectedReleasedRunId:cleaned.runId,task,runtimeState:{botifiedBaseUrl:"http://task:3099"},sandboxRun:sandboxRun({workspaceId:task.workspaceId,projectId:task.projectId,taskId:task.id,runId,fileLibraryId:task.fileLibraryId!,startedByUserId:task.createdByUserId!,projectSubPath:cleaned.projectSubPath,fileLibraryRootSubPath:cleaned.fileLibraryRootSubPath,resumeUnfinished:false,updatedAt:restartAt,createdAt:restartAt}),interruptedAt:restartAt};};
    const restarts=await Promise.all([store.restartTaskSandboxAtomically(restartInput("a")),store.restartTaskSandboxAtomically(restartInput("b"))]);
    assert.deepEqual(restarts.map((result)=>result.kind).sort(),["existing_active","restarted"]);
    const activeRestart=await store.findTask(settlementTask.id);assert.ok(activeRestart);assert.notEqual(activeRestart.runId,cleaned.runId);assert.equal(activeRestart.activeReservation,true);assert.equal((await store.sandboxRuns.get(activeRestart.runId))?.resumeUnfinished,false);
    assert.equal((await store.findTaskMessage("message_pg_interrupted"))?.deliveryStatus,"failed");assert.match((await store.findTaskMessage("message_pg_interrupted"))?.safeError??"",/sandbox was released/i);
    assert.equal((await store.findProjectResourceUsage(settlementTask.projectId))?.activeTasks,1);
  });
});

function adjustFileBytes(store: PostgresProductStore, projectId: string, delta: number, updatedAt: string) {
  return store.adjustProjectResourceUsage({ projectId, delta: { activeTasks: 0, providerRequests: 0, providerTokens: 0, providerCost: 0, projectFileBytes: delta }, limit: "project_file_bytes_limit", updatedAt });
}

function adjustActiveTasks(store: PostgresProductStore, projectId: string, delta: number, updatedAt: string) {
  return store.adjustProjectResourceUsage({ projectId, delta: { activeTasks: delta, providerRequests: 0, providerTokens: 0, providerCost: 0, projectFileBytes: 0 }, limit: "active_tasks_limit", updatedAt });
}

function createTestCredential(store: PostgresProductStore, projectId: string, id: string, timestamp: string) {
  return store.createProjectCredential({
    id,
    projectId,
    name: "Provider",
    type: "api_key",
    baseUrl: "https://models.example.test/v1",
    keyId: "test",
    nonce: Buffer.alloc(12),
    ciphertext: Buffer.from("ciphertext"),
    authTag: Buffer.alloc(16),
    fingerprint: `fingerprint-${id}`,
    version: 1,
    createdAt: timestamp,
    lastRotatedAt: null,
    updatedAt: timestamp
  });
}

function endpointRecord(id: string, projectId: string, credentialId: string, timestamp: string): ModelEndpoint {
  return {
    id,
    projectId,
    name: id,
    protocol: "openai_chat_completions",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    credentialId,
    capabilities: ["text", "tool_calls"],
    requestTimeoutSecs: 30,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function settleProvider(store: PostgresProductStore, id: string, projectId: string, endpointId: string, timestamp: string): Promise<void> {
  assert.ok(await store.reserveProjectProviderSettlement({ id, projectId, taskId: null, endpointId, reservedTokens: 0, reservedCost: 0, reservedAt: timestamp, expiresAt: "2026-07-12T00:01:00.000Z" }));
  assert.ok(await store.markProjectProviderSettlementDispatched(id, timestamp));
  assert.ok(await store.markProjectProviderSettlementDelivered(id, timestamp));
  assert.ok(await store.settleProjectProviderSettlement(id, { tokens: 1, cost: 0.01 }, timestamp));
}

function oidcUserId(issuer: string, subject: string): string {
  const digest = createHash("sha256").update(`${issuer}\0${subject}`).digest("hex").slice(0, 32);
  return `user_oidc_${digest}`;
}

function sandboxRun(overrides: Partial<SandboxRunState> = {}): SandboxRunState {
  return {
    workspaceId: "ws_pg",
    projectId: "proj_pg",
    taskId: "task_pg",
    runId: "run_pg",
    namespace: "agentsmith",
    phase: "starting",
    image: "agentsmith-lite/botified-runner:test",
    pvcName: "agentsmith-lite-files",
    projectSubPath: "workspaces/ws_pg/projects/proj_pg",
    fileLibraryRootSubPath: "libraries/library_task_pg/home",
    fileLibraryId: "library_task_pg",
    startedByUserId: "user_pg",
    startedAt: null,
    botifiedPort: 3099,
    resourceNames: {
      pod: "asl-task-task_pg",
      service: "asl-task-task_pg",
      configMap: "asl-task-task_pg-config",
      secret: "asl-botified-task_pg",
      serviceAccount: "asl-task-task_pg",
      networkPolicy: "asl-task-task_pg"
    },
    serviceKeySecretRef: {
      name: "asl-botified-task_pg",
      key: "BOTIFIED_SERVICE_KEY"
    },
    directories: {
      libraryHome: "/workspace/project/libraries/library_task_pg/home",
      botified: "/workspace/project/tasks/task_pg/botified"
    },
    resourceLimits: {
      cpuRequest: "250m",
      memoryRequest: "512Mi",
      cpuLimit: "1",
      memoryLimit: "1Gi"
    },
    resourceSnapshot: { cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824" },
    fencingToken: 1,
    cleanupStatus: "active",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    ...overrides
  };
}
