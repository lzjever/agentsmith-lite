import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { DeletionService } from "../../packages/application/src/deletionService.js";
import type { Project, Workspace } from "../../packages/contracts/src/api.js";

describe("deletion lifecycle", () => {
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
    const tasks = { async stopTasksForProjectDeletion() {} } as never;
    const deletion = new DeletionService(store, tasks, root);

    await deletion.deleteProject("owner", first.id);

    assert.equal(await store.findProject(first.id), null);
    await assert.rejects(access(path.join(root, first.rootPath, "only-first.txt")));
    await access(path.join(root, second.rootPath, "only-second.txt"));
  });

  it("keeps deleting state after cleanup failure so retry is scoped to the same project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-delete-failure-"));
    const store = createLocalInMemoryProductStore();
    const workspace = await store.createWorkspace(ws("ws_1"));
    const target = await store.createProject(project("proj_1", workspace.id));
    let fail = true;
    const tasks = { async stopTasksForProjectDeletion() { if (fail) throw new Error("sandbox unavailable"); } } as never;
    const deletion = new DeletionService(store, tasks, root);
    await assert.rejects(deletion.deleteProject("owner", target.id), /sandbox unavailable/);
    assert.equal((await store.findProject(target.id))?.lifecycleStatus, "deleting");
    fail = false;
    await deletion.deleteProject("owner", target.id);
    assert.equal(await store.findProject(target.id), null);
  });

  it("deletes a workspace by running each project lifecycle before its own context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-delete-workspace-"));
    const store = createLocalInMemoryProductStore();
    const workspace = await store.createWorkspace(ws("ws_1"));
    await store.createProject(project("proj_1", workspace.id));
    await store.createProject(project("proj_2", workspace.id));
    await store.createProjectContextEntry({ id: "context_1", workspaceId: workspace.id, projectId: null, ownerUserId: null, scope: "workspace_shared", contextKey: "note", content: "x", version:1,createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    const stopped: string[] = [];
    const deletion = new DeletionService(store, { async stopTasksForProjectDeletion(id: string) { stopped.push(id); } } as never, root);

    await deletion.deleteWorkspace("owner", workspace.id);

    assert.deepEqual(stopped.sort(), ["proj_1", "proj_2"]);
    assert.equal(await store.findWorkspace(workspace.id), null);
    assert.deepEqual(await store.listProjectContextEntries(workspace.id, null, "workspace_shared", null), []);
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
