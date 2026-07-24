import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, access, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { DeletionService } from "../../packages/application/src/deletionService.js";
import { AuthorizationService } from "../../packages/application/src/authorizationService.js";
import { FileLibraryService } from "../../packages/application/src/fileLibraryService.js";
import { FileService } from "../../packages/application/src/fileService.js";
import type { Project, Workspace } from "../../packages/contracts/src/api.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import type { BeginTaskIdempotencyInput, CompleteTaskIdempotencyInput, PersistedAgentTask, PersistedSandboxRunState } from "../../packages/ports/src/store.js";

describe("deletion lifecycle", () => {
  it("atomically completes the exact in-memory delete claim with Project finalization",async()=>{
    const store=createLocalInMemoryProductStore();
    const workspace=await store.createWorkspace(ws("ws_delete_replay"));
    const target=await store.createProject(project("proj_delete_replay",workspace.id));
    const seeded=await seedProjectDeletionBusinessData(store,target);
    const claim={
      actorId:"owner",
      projectId:target.id,
      operation:"project.delete" as const,
      key:"project-delete-replay",
      requestHash:"project-delete-request",
      resourceId:target.id,
      claimToken:"project-delete-claim",
      now:"2026-07-23T00:00:00.000Z",
      leaseExpiresAt:"2026-07-23T00:01:00.000Z"
    };
    assert.equal((await store.beginTaskIdempotency(claim)).kind,"claimed");
    assert.equal((await store.beginProjectDeletion(target.id,claim.now,"owner")).kind,"ready");
    const finalized=await finalizeProjectDeletionWithClaim(store,target.id,completedProjectDeletion(claim));
    assert.equal(await store.findProject(target.id),null);
    assert.equal(await store.findProjectMembership(target.id,"owner"),null);
    assert.equal(await store.findTask(seeded.task.id),null);
    assert.equal(await store.findFileLibrary(seeded.task.fileLibraryId!),null);
    assert.equal(await store.findTaskMessage(seeded.message.id),null);
    assert.deepEqual((await store.queryTaskArtifacts(seeded.task.id,{kind:null,mediaType:null,previewOnly:false,limit:100})).items,[]);
    assert.equal(await store.jsonDocs.get("sandbox_runtime_state",seeded.task.id),null);
    for(const receipt of seeded.receipts){
      assert.equal((await store.beginTaskIdempotency({...receipt,claimToken:`retry-${receipt.claimToken}`})).kind,"claimed");
    }
    assert.equal(finalized,"deleted");
    assert.deepEqual(await store.beginTaskIdempotency({...claim,claimToken:"replay-claim"}),{
      kind:"replay",
      resourceId:target.id,
      responseStatus:200,
      responseBody:{deleted:true}
    });
  });

  it("rolls back every in-memory Project dependency when finalize fails",async()=>{
    const store=createLocalInMemoryProductStore();
    const workspace=await store.createWorkspace(ws("ws_delete_rollback"));
    const target=await store.createProject(project("proj_delete_rollback",workspace.id));
    const seeded=await seedProjectDeletionBusinessData(store,target);
    assert.equal((await store.beginProjectDeletion(target.id,"2026-07-23T00:00:00.000Z","owner")).kind,"ready");
    const deleteRuns=store.sandboxRuns.deleteForProject.bind(store.sandboxRuns);
    store.sandboxRuns.deleteForProject=()=>{throw new Error("forced in-memory finalize failure");};

    await assert.rejects(()=>store.finalizeProjectDeletion(target.id),/forced in-memory finalize failure/);

    assert.equal((await store.findProject(target.id))?.lifecycleStatus,"deleting");
    await assertProjectDeletionBusinessDataIsPresent(store,target,seeded);
    store.sandboxRuns.deleteForProject=deleteRuns;
    assert.equal(await store.finalizeProjectDeletion(target.id),"deleted");
    assert.equal(await store.findProject(target.id),null);
  });

  it("rejects wrong and stale in-memory delete claims without deleting the Project",async()=>{
    const store=createLocalInMemoryProductStore();
    const workspace=await store.createWorkspace(ws("ws_delete_claim_fence"));
    const target=await store.createProject(project("proj_delete_claim_fence",workspace.id));
    const seeded=await seedProjectDeletionBusinessData(store,target);
    const original={
      actorId:"owner",projectId:target.id,operation:"project.delete" as const,key:"project-delete-claim-fence",
      requestHash:"project-delete-claim-fence-request",resourceId:target.id,claimToken:"project-delete-old-claim",
      now:"2026-07-23T00:00:00.000Z",leaseExpiresAt:"2026-07-23T00:01:00.000Z"
    };
    assert.equal((await store.beginTaskIdempotency(original)).kind,"claimed");
    assert.equal((await store.beginProjectDeletion(target.id,original.now,"owner")).kind,"ready");

    assert.equal(await finalizeProjectDeletionWithClaim(store,target.id,{
      ...completedProjectDeletion(original),claimToken:"project-delete-wrong-claim"
    }),"not_ready");
    assert.equal((await store.findProject(target.id))?.lifecycleStatus,"deleting");
    await assertProjectDeletionBusinessDataIsPresent(store,target,seeded);

    const reclaimed={
      ...original,claimToken:"project-delete-current-claim",
      now:"2026-07-23T00:02:00.000Z",leaseExpiresAt:"2026-07-23T00:03:00.000Z"
    };
    assert.deepEqual(await store.beginTaskIdempotency(reclaimed),{
      kind:"claimed",resourceId:target.id,claimToken:reclaimed.claimToken
    });
    assert.equal(await finalizeProjectDeletionWithClaim(store,target.id,completedProjectDeletion(original)),"not_ready");
    assert.equal((await store.findProject(target.id))?.lifecycleStatus,"deleting");
    await assertProjectDeletionBusinessDataIsPresent(store,target,seeded);

    assert.equal(await finalizeProjectDeletionWithClaim(store,target.id,completedProjectDeletion(reclaimed)),"deleted");
    assert.deepEqual(await store.beginTaskIdempotency({...reclaimed,claimToken:"project-delete-current-replay"}),{
      kind:"replay",resourceId:target.id,responseStatus:200,responseBody:{deleted:true}
    });
  });

  it("waits for an in-flight library create before project cleanup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-delete-library-create-"));
    try {
      const store = createLocalInMemoryProductStore();
      const workspace = await store.createWorkspace(ws("ws_create_race"));
      const target = await store.createProject(project("proj_create_race", workspace.id));
      const files = new FileService();
      const originalEnsure = files.ensureLibraryRoot.bind(files);
      let createEntered!: () => void;
      const entered = new Promise<void>((resolve) => { createEntered = resolve; });
      let releaseCreate!: () => void;
      const release = new Promise<void>((resolve) => { releaseCreate = resolve; });
      files.ensureLibraryRoot = async (...args) => { createEntered(); await release; return originalEnsure(...args); };
      const libraries = new FileLibraryService(store, new AuthorizationService(store), files, (rootPath) => path.resolve(root, rootPath));
      const deletion = new DeletionService(store, root);

      const creating = libraries.create("owner", target.id, { name: "In flight" });
      await entered;
      const deleting = deletion.deleteProject("owner", target.id);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal((await store.findProject(target.id))?.lifecycleStatus, "active");
      releaseCreate();
      await creating;
      await deleting;
      assert.equal(await store.findProject(target.id), null);
      await assert.rejects(access(path.join(root, target.rootPath)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks first, removes only its checked root, and leaves other projects intact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-delete-"));
    const store = createLocalInMemoryProductStore();
    const workspace = await store.createWorkspace(ws("ws_1"));
    const first = await store.createProject(project("proj_1", workspace.id));
    const second = await store.createProject(project("proj_2", workspace.id));
    await mkdir(path.join(root, first.rootPath), { recursive: true });
    await mkdir(path.join(root, second.rootPath), { recursive: true });
    await writeFile(path.join(root, first.rootPath, "only-first.txt"), "x");
    await writeFile(path.join(root, second.rootPath, "only-second.txt"), "x");
    await store.appendProjectAuditEvent({id:"audit_proj_1",projectId:first.id,actorId:"owner",action:"project.delete",status:"accepted",resourceKind:"project",resourceId:first.id,createdAt:"2026-01-01T00:00:00.000Z"});
    await store.createUserNotification({id:"notification_first",userId:"owner",type:"project_alert",title:"First project",body:null,projectId:first.id,resourceKind:"alert",resourceId:"alert_first",linkPath:`/projects/${first.id}/alerts`,readAt:null,createdAt:"2026-01-01T00:00:00.000Z"},"first-project-alert");
    await store.createUserNotification({id:"notification_second",userId:"owner",type:"project_alert",title:"Second project",body:null,projectId:second.id,resourceKind:"alert",resourceId:"alert_second",linkPath:`/projects/${second.id}/alerts`,readAt:null,createdAt:"2026-01-01T00:00:00.000Z"},"second-project-alert");
    await store.upsertActiveProjectAlert({id:"alert_first",projectId:first.id,type:"sandbox_failure",status:"active",deliveryStatus:"not_configured",createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z",resolvedAt:null,dismissedAt:null});
    assert.ok(await store.reserveProjectProviderSettlement({id:"settlement_first",projectId:first.id,taskId:null,endpointId:null,reservedTokens:0,reservedCost:0,reservedAt:"2026-01-01T00:00:00.000Z",expiresAt:"2026-01-01T00:01:00.000Z"}));
    await store.markProjectProviderSettlementDispatched("settlement_first","2026-01-01T00:00:00.000Z");
    await store.markProjectProviderSettlementDelivered("settlement_first","2026-01-01T00:00:00.000Z");
    await store.settleProjectProviderSettlement("settlement_first",{tokens:1,cost:0.01},"2026-01-01T00:00:00.000Z");
    const deletion = new DeletionService(store, root);

    await deletion.deleteProject("owner", first.id);

    assert.equal(await store.findProject(first.id), null);
    assert.deepEqual((await store.queryProjectAuditEvents(first.id,{limit:100})).items, []);
    assert.deepEqual((await store.listUserNotifications("owner")).map((notification) => notification.id), ["notification_second"]);
    assert.deepEqual((await store.queryProjectAlerts(first.id,{view:"active",limit:50})).items,[]);
    assert.deepEqual(await store.listSettledProjectProviderSettlements(first.id,"2025-01-01T00:00:00.000Z"),[]);
    await assert.rejects(access(path.join(root, first.rootPath, "only-first.txt")));
    await access(path.join(root, second.rootPath, "only-second.txt"));
  });

  it("removes released Runs and Sandbox Usage with a deleting Project",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"asl-delete-sandbox-usage-"));
    try{
      const store=createLocalInMemoryProductStore();
      const workspace=await store.createWorkspace(ws("ws_usage_delete"));
      const target=await store.createProject(project("proj_usage_delete",workspace.id));
      const task=liveTask(target);
      const pending={...sandboxRun(task,"release_requested"),releaseReason:"requested" as const};
      await createLiveTask(store,task,pending);
      const releasedAt="2026-07-19T00:01:00.000Z";
      const released={...pending,state:"released" as const,releasedAt,fencingToken:2,updatedAt:releasedAt};
      assert.equal(await store.completeSandboxRunRelease({
        runId:pending.runId,
        expectedFencingToken:pending.fencingToken,
        run:released,
        settlement:{runId:pending.runId,workspaceId:pending.workspaceId,projectId:pending.projectId,taskId:pending.taskId,fileLibraryId:pending.fileLibraryId,startedByUserId:pending.startedByUserId,startedAt:pending.startedAt,releasedAt,durationSeconds:60,resources:pending.resourceSnapshot,releaseReason:"requested"},
        auditEvent:{id:"audit_usage_delete_release",projectId:target.id,actorId:null,subjectUserId:pending.startedByUserId,action:"sandbox.released",status:"accepted",resourceKind:"sandbox",resourceId:task.id,detail:{taskId:task.id,runId:pending.runId,releaseReason:"requested"},createdAt:releasedAt}
      }),"applied");
      assert.equal((await store.listSandboxUsageSettlements(target.id,pending.startedByUserId)).length,1);
      await mkdir(path.join(root,target.rootPath),{recursive:true});

      await new DeletionService(store,root).deleteProject("owner",target.id);

      assert.equal(await store.findProject(target.id),null);
      assert.equal((await store.listSandboxUsageSettlements(target.id,pending.startedByUserId)).length,0);
      assert.equal((await store.sandboxRuns.list()).some((run)=>run.projectId===target.id),false);
    }finally{
      await rm(root,{recursive:true,force:true});
    }
  });

  it("rejects owned sandbox uncertainty without changing the active writable project or its files", async () => {
    for (const state of ["active", "failed", "release_requested"] as const) {
      const root = await mkdtemp(path.join(tmpdir(), `asl-delete-release-required-${state}-`));
      try {
        const store = createLocalInMemoryProductStore();
        const workspace = await store.createWorkspace(ws(`ws_${state}`));
        const target = await store.createProject(project(`proj_${state}`, workspace.id));
        const task = liveTask(target);
        await createLiveTask(store, task, sandboxRun(task, state));
        await mkdir(path.join(root, target.rootPath), { recursive: true });
        await writeFile(path.join(root, target.rootPath, "keep.txt"), "kept");

        await assert.rejects(() => new DeletionService(store, root).deleteProject("owner", target.id), (error: unknown) => error instanceof ProductError && error.statusCode === 409 && error.code === "task_sandbox_active");

        assert.equal((await store.findProject(target.id))?.lifecycleStatus, "active");
        assert.equal((await store.updateProjectName(target.id, `${target.name} writable`, new Date().toISOString(), target.name))?.name, `${target.name} writable`);
        await access(path.join(root, target.rootPath, "keep.txt"));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("deletes a reusable queued Task project after its exact sandbox run is confirmed cleaned", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-delete-cleaned-"));
    const store = createLocalInMemoryProductStore();
    const workspace = await store.createWorkspace(ws("ws_cleaned"));
    const target = await store.createProject(project("proj_cleaned", workspace.id));
    const task = liveTask(target);
    await createLiveTask(store, task, sandboxRun(task, "released"));
    await mkdir(path.join(root, target.rootPath), { recursive: true });
    await writeFile(path.join(root, target.rootPath, "remove.txt"), "remove");

    await new DeletionService(store, root).deleteProject("owner", target.id);

    assert.equal(await store.findProject(target.id), null);
    await assert.rejects(access(path.join(root, target.rootPath)));
  });

  it("reactivates an already-deleting project when sandbox ownership reappears", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-delete-retry-blocked-"));
    const store = createLocalInMemoryProductStore();
    const workspace = await store.createWorkspace(ws("ws_retry_blocked"));
    const target = await store.createProject(project("proj_retry_blocked", workspace.id));
    const task = liveTask(target);
    await createLiveTask(store, task, sandboxRun(task, "released"));
    assert.equal((await store.beginProjectDeletion(target.id, "2026-07-19T01:00:00.000Z", "owner")).kind, "ready");
    const cleaned = await store.sandboxRuns.get(task.currentRunId!);assert.ok(cleaned);
    await store.sandboxRuns.updateWithFencing(cleaned.runId, cleaned.fencingToken, { ...cleaned, state:"active", releasedAt:null, releaseReason:null, releaseRequestedAt:null, fencingToken:cleaned.fencingToken+1, updatedAt:"2026-07-19T01:01:00.000Z" });
    await mkdir(path.join(root, target.rootPath), { recursive:true });
    await writeFile(path.join(root, target.rootPath, "keep.txt"), "keep");

    await assert.rejects(() => new DeletionService(store, root).deleteProject("owner", target.id), (error:unknown) => error instanceof ProductError && error.statusCode===409 && error.code==="task_sandbox_active");

    const reactivated = await store.findProject(target.id);assert.equal(reactivated?.lifecycleStatus, "active");
    assert.equal((await store.updateProjectName(target.id, "Writable again", "2026-07-19T01:02:00.000Z", target.name))?.name, "Writable again");
    await access(path.join(root, target.rootPath, "keep.txt"));
    assert.ok(await store.findTask(task.id));
  });

  it("completes an already-deleting project retry when sandbox ownership remains cleaned", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-delete-retry-cleaned-"));
    const store = createLocalInMemoryProductStore();
    const workspace = await store.createWorkspace(ws("ws_retry_cleaned"));
    const target = await store.createProject(project("proj_retry_cleaned", workspace.id));
    const task = liveTask(target);
    await createLiveTask(store, task, sandboxRun(task, "released"));
    assert.equal((await store.beginProjectDeletion(target.id, "2026-07-19T01:00:00.000Z", "owner")).kind, "ready");

    await new DeletionService(store, root).deleteProject("owner", target.id);

    assert.equal(await store.findProject(target.id), null);
  });

  it("keeps every business record retryable when removing the Project root fails",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"asl-delete-file-failure-"));
    const store=createLocalInMemoryProductStore();
    const workspace=await store.createWorkspace(ws("ws_file_failure"));
    const target=await store.createProject(project("proj_file_failure",workspace.id));
    const seeded=await seedProjectDeletionBusinessData(store,target);
    const projectRoot=path.join(root,target.rootPath);
    const blocked=path.join(projectRoot,"blocked");
    await mkdir(blocked,{recursive:true});
    await writeFile(path.join(blocked,"keep.txt"),"keep");
    await chmod(blocked,0o000);
    try{
      await assert.rejects(()=>new DeletionService(store,root).deleteProject("owner",target.id));
      assert.equal((await store.findProject(target.id))?.lifecycleStatus,"deleting");
      await assertProjectDeletionBusinessDataIsPresent(store,target,seeded);
      await chmod(blocked,0o700);
      await new DeletionService(store,root).deleteProject("owner",target.id);
      assert.equal(await store.findProject(target.id),null);
      await assert.rejects(access(projectRoot));
    }finally{
      await chmod(blocked,0o700).catch(()=>undefined);
      await rm(root,{recursive:true,force:true});
    }
  });

  it("deletes files before finalize and retries a failed finalize with the database intact",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"asl-delete-finalize-failure-"));
    const store=createLocalInMemoryProductStore();
    const workspace=await store.createWorkspace(ws("ws_finalize_failure"));
    const target=await store.createProject(project("proj_finalize_failure",workspace.id));
    const seeded=await seedProjectDeletionBusinessData(store,target);
    const projectRoot=path.join(root,target.rootPath);
    await mkdir(projectRoot,{recursive:true});
    await writeFile(path.join(projectRoot,"remove.txt"),"remove");
    const finalize=store.finalizeProjectDeletion.bind(store);
    let attempts=0;
    store.finalizeProjectDeletion=async(id)=>{
      attempts+=1;
      if(attempts===1)throw new Error("forced finalize failure");
      return finalize(id);
    };
    try{
      await assert.rejects(()=>new DeletionService(store,root).deleteProject("owner",target.id),/forced finalize failure/);
      await assert.rejects(access(projectRoot));
      assert.equal((await store.findProject(target.id))?.lifecycleStatus,"deleting");
      await assertProjectDeletionBusinessDataIsPresent(store,target,seeded);

      await new DeletionService(store,root).deleteProject("owner",target.id);
      assert.equal(attempts,2);
      assert.equal(await store.findProject(target.id),null);
      await assert.rejects(access(projectRoot));
    }finally{
      await rm(root,{recursive:true,force:true});
    }
  });

  it("does not start deletion after ownership changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-delete-owner-race-"));
    const store = createLocalInMemoryProductStore();
    const workspace = await store.createWorkspace(ws("ws_owner_race"));
    const target = await store.createProject(project("proj_owner_race", workspace.id));
    const beginProjectDeletion = store.beginProjectDeletion.bind(store);
    store.beginProjectDeletion = async (id, updatedAt, expectedOwnerUserId) => {
      await store.upsertProjectMembership({ projectId: id, userId: "successor", role: "member", createdAt: updatedAt, updatedAt });
      await store.transferProjectOwner(id, "owner", "successor", updatedAt);
      return beginProjectDeletion(id, updatedAt, expectedOwnerUserId);
    };
    const deletion = new DeletionService(store, root);

    await assert.rejects(() => deletion.deleteProject("owner", target.id), (error: unknown) => error instanceof ProductError && error.statusCode === 403);
    assert.equal((await store.findProject(target.id))?.lifecycleStatus, "active");
    assert.equal((await store.findProject(target.id))?.ownerUserId, "successor");
  });

  it("deletes a workspace by running each project lifecycle before its own context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-delete-workspace-"));
    const store = createLocalInMemoryProductStore();
    const workspace = await store.createWorkspace(ws("ws_1"));
    await store.upsertWorkspaceMembership({workspaceId:workspace.id,userId:"member",role:"member",createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"});
    await store.createProject(project("proj_1", workspace.id));
    await store.createProject(project("proj_2", workspace.id));
    await store.createProjectContextEntry({ id: "context_1", workspaceId: workspace.id, projectId: null, ownerUserId: null, scope: "workspace_shared", contextKey: "note", content: "x", contentType:"text",version:1,createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    const deletion = new DeletionService(store, root);

    await deletion.deleteWorkspace("owner", workspace.id);

    assert.equal(await store.findWorkspace(workspace.id), null);
    assert.equal(await store.findWorkspaceMembership(workspace.id,"owner"),null);
    assert.equal(await store.findWorkspaceMembership(workspace.id,"member"),null);
    assert.equal(await store.findProjectContextEntryByKey(workspace.id, null, "workspace_shared", null, "note"), null);
  });

  it("keeps a workspace and every project active when one Task still owns a sandbox", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-delete-workspace-release-required-"));
    const store = createLocalInMemoryProductStore();
    const workspace = await store.createWorkspace(ws("ws_blocked"));
    const blocked = await store.createProject(project("proj_blocked", workspace.id));
    const clean = await store.createProject(project("proj_clean", workspace.id));
    const task = liveTask(blocked);
    await createLiveTask(store, task, sandboxRun(task, "failed"));

    await assert.rejects(() => new DeletionService(store, root).deleteWorkspace("owner", workspace.id), (error: unknown) => error instanceof ProductError && error.statusCode === 409);

    assert.equal((await store.findWorkspace(workspace.id))?.lifecycleStatus, "active");
    assert.equal((await store.findProject(blocked.id))?.lifecycleStatus, "active");
    assert.equal((await store.findProject(clean.id))?.lifecycleStatus, "active");
  });

  it("reactivates an already-deleting workspace and its uncertain project when sandbox ownership reappears", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-delete-workspace-retry-blocked-"));
    const store = createLocalInMemoryProductStore();
    const workspace = await store.createWorkspace(ws("ws_retry_blocked"));
    const blocked = await store.createProject(project("proj_retry_blocked", workspace.id));
    const sibling = await store.createProject(project("proj_retry_sibling", workspace.id));
    const task = liveTask(blocked);
    await createLiveTask(store, task, sandboxRun(task, "released"));
    assert.equal((await store.beginWorkspaceDeletion(workspace.id, "2026-07-19T02:00:00.000Z", "owner")).kind, "ready");
    const cleaned = await store.sandboxRuns.get(task.currentRunId!);assert.ok(cleaned);
    await store.sandboxRuns.updateWithFencing(cleaned.runId, cleaned.fencingToken, { ...cleaned, state:"active", releasedAt:null, releaseReason:null, releaseRequestedAt:null, fencingToken:cleaned.fencingToken+1, updatedAt:"2026-07-19T02:01:00.000Z" });

    await assert.rejects(() => new DeletionService(store, root).deleteWorkspace("owner", workspace.id), (error:unknown) => error instanceof ProductError && error.statusCode===409);

    assert.equal((await store.findWorkspace(workspace.id))?.lifecycleStatus, "active");
    assert.equal((await store.findProject(blocked.id))?.lifecycleStatus, "active");
    assert.equal((await store.findProject(sibling.id))?.lifecycleStatus, "deleting");
    assert.equal((await store.updateWorkspaceName(workspace.id, "Writable workspace", "2026-07-19T02:02:00.000Z", workspace.name))?.name, "Writable workspace");
  });

  it("completes an already-deleting workspace retry when every sandbox remains cleaned", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-delete-workspace-retry-cleaned-"));
    const store = createLocalInMemoryProductStore();
    const workspace = await store.createWorkspace(ws("ws_retry_cleaned"));
    const target = await store.createProject(project("proj_retry_cleaned", workspace.id));
    const task = liveTask(target);
    await createLiveTask(store, task, sandboxRun(task, "released"));
    assert.equal((await store.beginWorkspaceDeletion(workspace.id, "2026-07-19T02:00:00.000Z", "owner")).kind, "ready");

    await new DeletionService(store, root).deleteWorkspace("owner", workspace.id);

    assert.equal(await store.findWorkspace(workspace.id), null);
    assert.equal(await store.findProject(target.id), null);
  });

  it("transfers ownership only to an existing different member and demotes the former owner", async () => {
    const store=createLocalInMemoryProductStore(); const workspace=await store.createWorkspace(ws("ws_transfer"));
    await store.createUser({id:"member",email:"member@example.test",emailVerified:true,passwordHash:"x",createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"});
    await store.upsertWorkspaceMembership({workspaceId:workspace.id,userId:"member",role:"member",createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"});
    const project=await store.createProject(projectForTransfer("proj_transfer",workspace.id));
    await store.upsertProjectMembership({projectId:project.id,userId:"member",role:"member",createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"});
    assert.equal(await store.transferWorkspaceOwner(workspace.id,"owner","missing","2026-01-02T00:00:00.000Z"),null);
    await store.transferWorkspaceOwner(workspace.id,"owner","member","2026-01-02T00:00:00.000Z");
    await store.transferProjectOwner(project.id,"owner","member","2026-01-02T00:00:00.000Z");
    assert.equal((await store.findWorkspaceMembership(workspace.id,"owner"))?.role,"admin");
    assert.equal((await store.findProjectMembership(project.id,"member"))?.role,"owner");
  });
});

function ws(id: string): Workspace { return { id, name: id, ownerUserId: "owner", lifecycleStatus: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }; }
function project(id: string, workspaceId: string): Project { return { id, workspaceId, name: id, ownerUserId: "owner", rootPath: `workspaces/${workspaceId}/projects/${id}`, taskConcurrencyLimit: 1, lifecycleStatus: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }; }
function projectForTransfer(id:string,workspaceId:string){return project(id,workspaceId)}

function liveTask(target: Project): PersistedAgentTask {
  return {
    id: `task_${target.id}`, workspaceId: target.workspaceId, projectId: target.id, endpointId: `endpoint_${target.id}`,
    fileLibraryId: `library_${target.id}`, title: "Durable Task", prompt: "work",
    createdByUserId: "owner", agentContext: "", currentRunId: `run_${target.id}`, archivedAt: null, deletedAt: null,
    createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z"
  };
}

function sandboxRun(task: PersistedAgentTask, state: "active" | "failed" | "release_requested" | "released"): PersistedSandboxRunState {
  const released = state === "released";
  return {
    namespace: "agentsmith", workspaceId: task.workspaceId, projectId: task.projectId, taskId: task.id, runId: task.currentRunId!,
    state, image: "botified:test", pvcName: "files",
    projectSubPath: `workspaces/${task.workspaceId}/projects/${task.projectId}`, fileLibraryRootSubPath: `libraries/${task.fileLibraryId}/home`, fileLibraryId:task.fileLibraryId!,startedByUserId:task.createdByUserId??"owner",startedAt:task.createdAt,botifiedPort: 3099,
    resourceNames: { pod: `pod-${task.id}`, service: `service-${task.id}`, configMap: `config-${task.id}`, secret: `secret-${task.id}` },
    serviceKeySecretRef: { name: `secret-${task.id}`, key: "BOTIFIED_SERVICE_KEY" },
    directories: { libraryHome: "/workspace/project/library", botified: "/workspace/project/botified" },
    resourceLimits: { cpuRequest: "100m", memoryRequest: "128Mi", cpuLimit: "1", memoryLimit: "1Gi" },
    resourceSnapshot:{cpuRequestMillis:"100",memoryRequestBytes:"134217728",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},
    failureCode:state==="failed"?"runner_failed":null,failureCause:state==="failed"?"Sandbox failed":null,fencingToken:1,cleanupClaimedAt:null,cleanupAttempts:0,lastCleanupAt:null,lastCleanupError:null,
    releaseReason:released?"requested":state==="failed"?"failed":null,
    releaseRequestedAt:state==="release_requested"||state==="failed"?task.updatedAt:null,
    failedAt:state==="failed"?task.updatedAt:null,releasedAt:released?task.updatedAt:null,
    createdAt: task.createdAt, updatedAt: task.updatedAt
  };
}

async function createLiveTask(
  store: ReturnType<typeof createLocalInMemoryProductStore>,
  task: PersistedAgentTask,
  run: PersistedSandboxRunState
): Promise<void> {
  assert.equal(task.currentRunId, run.runId);
  const created = await store.createTaskAtomically({
    task,
    newFileLibrary: {
      id: task.fileLibraryId!, workspaceId: task.workspaceId, projectId: task.projectId, name: `Library ${task.id}`,
      rootSubPath: `libraries/${task.fileLibraryId}/home`, createdByUserId: "owner", createdAt: task.createdAt, updatedAt: task.updatedAt
    },
    reserveActive: run.state !== "released",
    sandboxRun: run
  });
  assert.equal(created.kind, "created");
}

async function seedProjectDeletionBusinessData(
  store:ReturnType<typeof createLocalInMemoryProductStore>,
  target:Project
){
  const task={...liveTask(target),currentRunId:null};
  const message={
    id:`message_${target.id}`,taskId:task.id,actorId:"owner",content:"keep message",
    deliveryKey:`delivery_${target.id}`,requestHash:`message_request_${target.id}`,claimToken:null,receipt:null,
    timelineCursor:null,deliveryStatus:"pending" as const,claimedAt:null,leaseExpiresAt:null,attemptCount:0,
    nextRetryAt:null,safeError:null,createdAt:task.createdAt,updatedAt:task.updatedAt,deletedAt:null
  };
  assert.equal((await store.createTaskAtomically({
    task,
    reserveActive:false,
    newFileLibrary:{
      id:task.fileLibraryId!,workspaceId:task.workspaceId,projectId:task.projectId,name:`Library ${task.id}`,
      rootSubPath:`libraries/${task.fileLibraryId}/home`,createdByUserId:"owner",createdAt:task.createdAt,updatedAt:task.updatedAt
    },
    initialMessage:message,
    runtimeState:{prompt:task.prompt,message:message.content}
  })).kind,"created");
  await store.appendTaskArtifacts([{
    id:`artifact_${target.id}`,taskId:task.id,fileId:`file_${target.id}`,name:"result.txt",
    bytes:4,mediaType:"text/plain",previewText:"keep",createdAt:task.createdAt
  }]);
  const receipts=[
    {
      actorId:"owner",projectId:target.id,operation:"project.settings.update" as const,key:`project-receipt-${target.id}`,
      requestHash:`project-receipt-request-${target.id}`,resourceId:target.id,claimToken:`project-receipt-claim-${target.id}`,
      now:task.createdAt,leaseExpiresAt:"2026-07-19T00:05:00.000Z"
    },
    {
      actorId:"owner",projectId:target.id,operation:"message" as const,key:`task-receipt-${target.id}`,
      requestHash:`task-receipt-request-${target.id}`,resourceId:message.id,claimToken:`task-receipt-claim-${target.id}`,
      now:task.createdAt,leaseExpiresAt:"2026-07-19T00:05:00.000Z"
    }
  ];
  for(const receipt of receipts){
    assert.equal((await store.beginTaskIdempotency(receipt)).kind,"claimed");
    assert.equal(await store.completeTaskIdempotency({
      ...receipt,responseStatus:200,responseBody:{prompt:task.prompt,message:message.content},updatedAt:task.updatedAt
    }),true);
  }
  return{task,message,receipts};
}

async function assertProjectDeletionBusinessDataIsPresent(
  store:ReturnType<typeof createLocalInMemoryProductStore>,
  target:Project,
  seeded:Awaited<ReturnType<typeof seedProjectDeletionBusinessData>>
):Promise<void>{
  assert.ok(await store.findProjectMembership(target.id,"owner"));
  assert.ok(await store.findTask(seeded.task.id));
  assert.ok(await store.findFileLibrary(seeded.task.fileLibraryId!));
  assert.ok(await store.findTaskMessage(seeded.message.id));
  assert.equal((await store.queryTaskArtifacts(seeded.task.id,{kind:null,mediaType:null,previewOnly:false,limit:100})).items.length,1);
  assert.deepEqual(await store.jsonDocs.get("sandbox_runtime_state",seeded.task.id),{
    prompt:seeded.task.prompt,
    message:seeded.message.content
  });
  for(const receipt of seeded.receipts){
    assert.equal((await store.beginTaskIdempotency({...receipt,claimToken:`replay-${receipt.claimToken}`})).kind,"replay");
  }
}

function completedProjectDeletion(claim:BeginTaskIdempotencyInput):CompleteTaskIdempotencyInput{
  return{
    actorId:claim.actorId,projectId:claim.projectId,operation:claim.operation,key:claim.key,
    requestHash:claim.requestHash,claimToken:claim.claimToken,responseStatus:200,responseBody:{deleted:true},updatedAt:claim.now
  };
}

function finalizeProjectDeletionWithClaim(
  store:ReturnType<typeof createLocalInMemoryProductStore>,
  projectId:string,
  completion:CompleteTaskIdempotencyInput
):Promise<"deleted"|"not_ready">{
  return store.finalizeProjectDeletion(projectId,completion);
}
