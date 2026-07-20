import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises";
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
import type { PersistedAgentTask, PersistedSandboxRunState } from "../../packages/ports/src/store.js";

describe("deletion lifecycle", () => {
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
    await store.createProjectChatThread({id:"chat_first",projectId:first.id,ownerUserId:"owner",endpointId:null,title:null,pinnedAt:null,starredAt:null,deletedAt:null,createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"});
    await store.appendProjectChatMessages([{id:"chatmsg_first",threadId:"chat_first",sequence:1,version:1,deliveryStatus:"completed",role:"user",content:"Delete with project",createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"}]);
    await store.upsertActiveProjectAlert({id:"alert_first",projectId:first.id,type:"task_failure",status:"active",deliveryStatus:"not_configured",createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z",resolvedAt:null,dismissedAt:null});
    assert.ok(await store.reserveProjectProviderSettlement({id:"settlement_first",projectId:first.id,taskId:null,endpointId:null,reservedTokens:0,reservedCost:0,reservedAt:"2026-01-01T00:00:00.000Z",expiresAt:"2026-01-01T00:01:00.000Z"}));
    await store.markProjectProviderSettlementDispatched("settlement_first","2026-01-01T00:00:00.000Z");
    await store.markProjectProviderSettlementDelivered("settlement_first","2026-01-01T00:00:00.000Z");
    await store.settleProjectProviderSettlement("settlement_first",{tokens:1,cost:0.01},"2026-01-01T00:00:00.000Z");
    const deletion = new DeletionService(store, root);

    await deletion.deleteProject("owner", first.id);

    assert.equal(await store.findProject(first.id), null);
    assert.deepEqual(await store.listProjectAuditEvents(first.id), []);
    assert.deepEqual((await store.listUserNotifications("owner")).map((notification) => notification.id), ["notification_second"]);
    assert.equal(await store.findProjectChatThread("chat_first"),null);
    assert.deepEqual(await store.listProjectChatMessages("chat_first"),[]);
    assert.deepEqual(await store.listProjectAlerts(first.id),[]);
    assert.deepEqual(await store.listSettledProjectProviderSettlements(first.id,"2025-01-01T00:00:00.000Z"),[]);
    await assert.rejects(access(path.join(root, first.rootPath, "only-first.txt")));
    await access(path.join(root, second.rootPath, "only-second.txt"));
  });

  it("rejects owned sandbox uncertainty without changing the active writable project or its files", async () => {
    for (const state of ["active", "failed", "cleanup_requested", "missing"] as const) {
      const root = await mkdtemp(path.join(tmpdir(), `asl-delete-release-required-${state}-`));
      try {
        const store = createLocalInMemoryProductStore();
        const workspace = await store.createWorkspace(ws(`ws_${state}`));
        const target = await store.createProject(project(`proj_${state}`, workspace.id));
        const task = liveTask(target, state === "cleanup_requested" ? "queued" : "failed");
        await createLiveTask(store, task, state === "missing" ? null : sandboxRun(task, state));
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
    const task = liveTask(target, "queued");
    await createLiveTask(store, task, sandboxRun(task, "cleaned"), false);
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
    const task = liveTask(target, "queued");
    await createLiveTask(store, task, sandboxRun(task, "cleaned"), false);
    assert.equal((await store.beginProjectDeletion(target.id, "2026-07-19T01:00:00.000Z", "owner")).kind, "ready");
    const cleaned = await store.sandboxRuns.get(task.runId);assert.ok(cleaned);
    await store.sandboxRuns.updateWithFencing(cleaned.runId, cleaned.fencingToken, { ...cleaned, phase:"running", cleanupStatus:"active", fencingToken:cleaned.fencingToken+1, updatedAt:"2026-07-19T01:01:00.000Z" });
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
    const task = liveTask(target, "queued");
    await createLiveTask(store, task, sandboxRun(task, "cleaned"), false);
    assert.equal((await store.beginProjectDeletion(target.id, "2026-07-19T01:00:00.000Z", "owner")).kind, "ready");

    await new DeletionService(store, root).deleteProject("owner", target.id);

    assert.equal(await store.findProject(target.id), null);
  });

  it("does not remove project files when database dependency deletion rejects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-delete-db-reject-"));
    const store = createLocalInMemoryProductStore();
    const workspace = await store.createWorkspace(ws("ws_db_reject"));
    const target = await store.createProject(project("proj_db_reject", workspace.id));
    await mkdir(path.join(root, target.rootPath), { recursive: true });
    await writeFile(path.join(root, target.rootPath, "keep.txt"), "keep");
    store.deleteProjectDependenciesAndProject = async () => false;

    await assert.rejects(() => new DeletionService(store, root).deleteProject("owner", target.id), (error: unknown) => error instanceof ProductError && error.statusCode === 409);

    assert.equal((await store.findProject(target.id))?.lifecycleStatus, "deleting");
    await access(path.join(root, target.rootPath, "keep.txt"));
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
    await store.createProjectContextEntry({ id: "context_1", workspaceId: workspace.id, projectId: null, ownerUserId: null, scope: "workspace_shared", contextKey: "note", content: "x", version:1,createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    const deletion = new DeletionService(store, root);

    await deletion.deleteWorkspace("owner", workspace.id);

    assert.equal(await store.findWorkspace(workspace.id), null);
    assert.equal(await store.findWorkspaceMembership(workspace.id,"owner"),null);
    assert.equal(await store.findWorkspaceMembership(workspace.id,"member"),null);
    assert.deepEqual(await store.listProjectContextEntries(workspace.id, null, "workspace_shared", null), []);
  });

  it("keeps a workspace and every project active when one Task still owns a sandbox", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-delete-workspace-release-required-"));
    const store = createLocalInMemoryProductStore();
    const workspace = await store.createWorkspace(ws("ws_blocked"));
    const blocked = await store.createProject(project("proj_blocked", workspace.id));
    const clean = await store.createProject(project("proj_clean", workspace.id));
    const task = liveTask(blocked, "failed");
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
    const task = liveTask(blocked, "queued");
    await createLiveTask(store, task, sandboxRun(task, "cleaned"), false);
    assert.equal((await store.beginWorkspaceDeletion(workspace.id, "2026-07-19T02:00:00.000Z", "owner")).kind, "ready");
    const cleaned = await store.sandboxRuns.get(task.runId);assert.ok(cleaned);
    await store.sandboxRuns.updateWithFencing(cleaned.runId, cleaned.fencingToken, { ...cleaned, phase:"running", cleanupStatus:"active", fencingToken:cleaned.fencingToken+1, updatedAt:"2026-07-19T02:01:00.000Z" });

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
    const task = liveTask(target, "queued");
    await createLiveTask(store, task, sandboxRun(task, "cleaned"), false);
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

function liveTask(target: Project, status: "queued" | "failed"): PersistedAgentTask {
  return {
    id: `task_${target.id}`, workspaceId: target.workspaceId, projectId: target.id, endpointId: `endpoint_${target.id}`,
    fileLibraryId: `library_${target.id}`, title: "Durable Task", prompt: "work", status, runId: `run_${target.id}`,
    executionMode: "live", sandbox: { namespace: "agentsmith", resources: [] }, activeReservation: true,
    createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z"
  };
}

function sandboxRun(task: PersistedAgentTask, state: "active" | "failed" | "cleanup_requested" | "cleaned"): PersistedSandboxRunState {
  const cleaned = state === "cleaned";
  return {
    namespace: "agentsmith", workspaceId: task.workspaceId, projectId: task.projectId, taskId: task.id, runId: task.runId,
    phase: cleaned ? "cleaned" : "running", image: "botified:test", pvcName: "files",
    projectSubPath: `workspaces/${task.workspaceId}/projects/${task.projectId}`, fileLibraryRootSubPath: `libraries/${task.fileLibraryId}/home`, fileLibraryId:task.fileLibraryId!,startedByUserId:task.createdByUserId??"owner",startedAt:task.createdAt,botifiedPort: 3099,
    resourceNames: { pod: `pod-${task.id}`, service: `service-${task.id}`, configMap: `config-${task.id}`, secret: `secret-${task.id}` },
    serviceKeySecretRef: { name: `secret-${task.id}`, key: "BOTIFIED_SERVICE_KEY" },
    directories: { libraryHome: "/workspace/project/library", botified: "/workspace/project/botified" },
    resourceLimits: { cpuRequest: "100m", memoryRequest: "128Mi", cpuLimit: "1", memoryLimit: "1Gi" },
    resourceSnapshot:{cpuRequestMillis:"100",memoryRequestBytes:"134217728",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},
    fencingToken: 1, cleanupStatus: cleaned ? "cleaned" : state === "cleanup_requested" ? "cleanup_requested" : "active", createdAt: task.createdAt, updatedAt: task.updatedAt
  };
}

async function createLiveTask(
  store: ReturnType<typeof createLocalInMemoryProductStore>,
  task: PersistedAgentTask,
  run: PersistedSandboxRunState | null,
  reserveActive = true
): Promise<void> {
  const created = await store.createTaskAtomically({
    task: { ...task, activeReservation: reserveActive },
    newFileLibrary: {
      id: task.fileLibraryId!, workspaceId: task.workspaceId, projectId: task.projectId, name: `Library ${task.id}`,
      rootSubPath: `libraries/${task.fileLibraryId}/home`, createdByUserId: "owner", createdAt: task.createdAt, updatedAt: task.updatedAt
    },
    reserveActive,
    ...(run ? { sandboxRun: run } : {})
  });
  assert.equal(created.kind, "created");
}
