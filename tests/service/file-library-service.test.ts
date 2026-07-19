import assert from "node:assert/strict";
import { mkdtemp, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { ProductStore } from "../../packages/ports/src/store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file library service", () => {
  it("authorizes CRUD and rejects bound or non-empty deletion", async () => {
    const { services, ownerId, viewerId, projectId } = await fixture();

    await assert.rejects(() => services.fileLibraries.create(viewerId, projectId, { name: "Viewer library" }), /Project access denied/);
    const created = await services.fileLibraries.create(ownerId, projectId, { name: "Workspace" });
    assert.match(created.rootSubPath, new RegExp(`^libraries/${created.id}/home$`));
    assert.deepEqual((await services.fileLibraries.list(viewerId, projectId)).map((item) => item.id), [created.id]);

    const renamed = await services.fileLibraries.rename(ownerId, projectId, created.id, { name: "Renamed", expectedUpdatedAt: created.updatedAt });
    assert.equal(renamed.name, "Renamed");
    assert.equal(renamed.rootSubPath, created.rootSubPath);
    await assert.rejects(() => services.fileLibraries.rename(viewerId, projectId, renamed.id, { name: "Denied", expectedUpdatedAt: renamed.updatedAt }), /Project access denied/);
    await assert.rejects(() => services.fileLibraries.remove(viewerId, projectId, renamed.id), /Project access denied/);

    const projectRoot = services.projectAbsoluteRoot((await services.authorization.requireProject(ownerId, projectId)).rootPath);
    await services.files.uploadLibraryFile(projectRoot, renamed.rootSubPath, { path: "notes/today.txt", bytes: Buffer.from("hello") });
    await assert.rejects(() => services.fileLibraries.remove(ownerId, projectId, renamed.id), /File Library is not empty/);
    await services.files.deleteLibraryFile(projectRoot, renamed.rootSubPath, "notes/today.txt");
    await rmdir(path.join(projectRoot,renamed.rootSubPath,"notes"));

    const store = services.store;
    (store as ProductStore).findTaskBoundToFileLibrary = async () => ({ kind: "bound", task: { id: "task_one", title: "Bound task" } });
    (store as ProductStore).deleteFileLibraryIfUnbound = async () => "bound";
    const boundProjection = (await services.fileLibraries.list(ownerId, projectId))[0]!;
    assert.equal(boundProjection.boundTask?.id, "task_one");
    assert.equal(boundProjection.capabilities.canDelete, false);
    await assert.rejects(() => services.fileLibraries.remove(ownerId, projectId, renamed.id), /File Library is bound to a Task/);
  });

  it("allocates and reuses the idempotency resource ID for create", async () => {
    const { services, ownerId, projectId } = await fixture();
    const first = await services.fileLibraries.create(ownerId, projectId, { name: "Stable" }, "stable-create-key");
    const replay = await services.fileLibraries.create(ownerId, projectId, { name: "Stable" }, "stable-create-key");
    assert.equal(replay.id, first.id);
    assert.equal((await services.fileLibraries.list(ownerId, projectId)).length, 1);
  });

  it("repairs a failed directory create with the persisted idempotency resource ID", async () => {
    const { services, store, ownerId, projectId } = await fixture();
    const originalEnsure = services.files.ensureLibraryRoot.bind(services.files);
    let ensureCalls = 0;
    services.files.ensureLibraryRoot = async (...args) => {
      ensureCalls += 1;
      if (ensureCalls === 1) throw new Error("storage unavailable");
      return originalEnsure(...args);
    };
    const originalBegin = store.beginTaskIdempotency.bind(store);
    let beginCalls = 0;
    store.beginTaskIdempotency = (input) => {
      beginCalls += 1;
      if (beginCalls === 1) return originalBegin(input);
      const now = new Date(Date.parse(input.leaseExpiresAt) + 1).toISOString();
      return originalBegin({ ...input, now, leaseExpiresAt: new Date(Date.parse(now) + 30_000).toISOString() });
    };

    await assert.rejects(() => services.fileLibraries.create(ownerId, projectId, { name: "Repair" }, "repair-create-key"), /File Library could not be created/);
    const reserved = (await store.listFileLibrariesForProject(projectId))[0]!;
    const repaired = await services.fileLibraries.create(ownerId, projectId, { name: "Repair" }, "repair-create-key");
    assert.equal(repaired.id, reserved.id);
    assert.equal((await store.listFileLibrariesForProject(projectId)).length, 1);
  });

  it("serializes an authorized library mutation ahead of deletion", async () => {
    const { services, ownerId, projectId } = await fixture();
    const library = await services.fileLibraries.create(ownerId, projectId, { name: "Race" });
    let entered!: () => void;
    const mutationEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const mutationRelease = new Promise<void>((resolve) => { release = resolve; });
    const mutation = services.fileLibraries.withLibraryMutation(ownerId, projectId, library.id, async ({ projectRoot, library: current }) => {
      entered();
      await mutationRelease;
      await services.files.uploadLibraryFile(projectRoot, current.rootSubPath, { path: "raced.txt", bytes: Buffer.from("kept") });
    });
    await mutationEntered;
    let deletionSettled = false;
    const deletion = services.fileLibraries.remove(ownerId, projectId, library.id).finally(() => { deletionSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(deletionSettled, false);
    release();
    await mutation;
    await assert.rejects(deletion, /File Library is not empty/);
  });

  it("keeps libraries isolated and rejects traversal and symlink paths", async () => {
    const { services, ownerId, projectId, dataRoot } = await fixture();
    const first = await services.fileLibraries.create(ownerId, projectId, { name: "First" });
    const second = await services.fileLibraries.create(ownerId, projectId, { name: "Second" });
    const project = await services.authorization.requireProject(ownerId, projectId);
    const projectRoot = services.projectAbsoluteRoot(project.rootPath);

    await services.files.uploadLibraryFile(projectRoot, first.rootSubPath, { path: "same.bin", bytes: Uint8Array.from([0, 255, 1]) });
    assert.deepEqual((await services.files.listLibraryFiles(projectRoot, first.rootSubPath)).entries.map((entry) => entry.path), ["same.bin"]);
    assert.deepEqual((await services.files.listLibraryFiles(projectRoot, second.rootSubPath)).entries, []);
    assert.equal(await services.fileLibraries.measureProjectFileBytes(ownerId,projectId),3);
    assert.deepEqual(Array.from((await services.files.downloadLibraryFile(projectRoot, first.rootSubPath, "same.bin")).bytes), [0, 255, 1]);
    await assert.rejects(() => services.files.uploadLibraryFile(projectRoot, first.rootSubPath, { path: "../escape", bytes: Buffer.from("no") }), /traversal/);

    const outside = path.join(dataRoot, "outside");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(projectRoot, first.rootSubPath, "link"));
    await assert.rejects(() => services.files.downloadLibraryFile(projectRoot, first.rootSubPath, "link"), /symlink|escapes/);
    assert.equal("uploadFile" in services.files,false);
    assert.equal("normalizeProjectFilesPath" in services.files,false);
    await assert.rejects(()=>services.files.ensureLibraryRoot(projectRoot,"files"),/Library root path is invalid/);
  });
});

async function fixture() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-file-library-service-"));
  roots.push(dataRoot);
  const store = createLocalInMemoryProductStore();
  const services = Object.assign(createApplicationServices({ store, dataRoot, builtinAdminPassword: "admin-password" }), { store });
  const owner = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
  const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
  const viewer = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "viewer", email: "viewer@example.test", emailVerified: true });
  const now = new Date().toISOString();
  await store.upsertProjectMembership({ projectId: project.id, userId: viewer.user.id, role: "viewer", createdAt: now, updatedAt: now });
  return { services, store, dataRoot, ownerId: owner.user.id, viewerId: viewer.user.id, projectId: project.id };
}
