import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { DescriptorFileTreeWalker } from "../../packages/application/src/descriptorFileTreeWalker.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { FileLibraryService } from "../../packages/application/src/fileLibraryService.js";
import { FilePathValidationService } from "../../packages/application/src/filePathValidationService.js";
import { FileService } from "../../packages/application/src/fileService.js";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import { DryRunBotifiedRuntimeHttpClient, type BotifiedRuntimeHttpClient } from "../../packages/ports/src/botified.js";
import type { PodReadiness } from "../../packages/sandbox-controller/src/kubernetesPort.js";

const roots: string[] = [];
const execFileAsync=promisify(execFile);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file library service", () => {
  it("authorizes CRUD and recursively deletes an unbound non-empty Library", async () => {
    const { services, ownerId, viewerId, projectId } = await fixture();

    await assert.rejects(() => services.fileLibraries.create(viewerId, projectId, { name: "Viewer library" }), /Project access denied/);
    const created = await services.fileLibraries.create(ownerId, projectId, { name: "Workspace" });
    assert.match(created.rootSubPath,new RegExp(`^libraries/${created.id}-attempt_[^/]+/home$`));
    assert.deepEqual((await services.fileLibraries.list(viewerId, projectId)).map((item) => item.id), [created.id]);

    const renamed = await services.fileLibraries.rename(ownerId, projectId, created.id, { name: "Renamed", expectedUpdatedAt: created.updatedAt });
    assert.equal(renamed.name, "Renamed");
    assert.equal(renamed.rootSubPath, created.rootSubPath);
    await assert.rejects(() => services.fileLibraries.rename(viewerId, projectId, renamed.id, { name: "Denied", expectedUpdatedAt: renamed.updatedAt }), /Project access denied/);
    await assert.rejects(() => services.fileLibraries.remove(viewerId, projectId, renamed.id, "viewer-delete", async () => undefined), /Project access denied/);

    const projectRoot = services.projectAbsoluteRoot((await services.authorization.requireProject(ownerId, projectId)).rootPath);
    await services.files.uploadLibraryFile(projectRoot, renamed.rootSubPath, { path: "notes/today.txt", bytes: Buffer.from("hello") });
    await services.files.uploadLibraryFile(projectRoot, renamed.rootSubPath, { path: "notes/nested/tomorrow.txt", bytes: Buffer.from("later") });
    let measured = -1;
    assert.deepEqual(
      await services.fileLibraries.remove(ownerId, projectId, renamed.id, "recursive-delete", async (bytes) => { measured = bytes; }),
      { deleted: true }
    );
    assert.equal(measured, 0);
    assert.equal(await services.store.findFileLibrary(renamed.id), null);
    await assert.rejects(() => readdir(path.join(projectRoot, renamed.rootSubPath)), { code: "ENOENT" });
    const audits = (await services.store.queryProjectAuditEvents(projectId, { limit: 100 })).items
      .filter((event) => event.action === "file_library.delete" && event.resourceId === renamed.id);
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0]?.detail, { bytes: 10 });
  });

  it("keeps a failed deletion visible and resumes it under a new request key", async () => {
    const { services, ownerId, projectId } = await fixture();
    const library = await services.fileLibraries.create(ownerId, projectId, { name: "Retry delete" });
    const projectRoot = services.projectAbsoluteRoot((await services.authorization.requireProject(ownerId, projectId)).rootPath);
    await services.files.uploadLibraryFile(projectRoot, library.rootSubPath, {
      path: "nested/value.txt",
      bytes: Buffer.from("value")
    });

    await assert.rejects(
      () => services.fileLibraries.remove(ownerId, projectId, library.id, "failed-delete", async () => {
        throw new Error("accounting unavailable");
      }),
      (error: unknown) => error instanceof ProductError &&
        error.code === "file_library_deleting" &&
        error.message === "File Library deletion is in progress"
    );
    const listed = (await services.fileLibraries.list(ownerId, projectId)).find((item) => item.id === library.id);
    assert.equal(listed?.lifecycleStatus, "deleting");
    assert.equal(listed?.capabilities.canRename, false);
    assert.equal(listed?.capabilities.canWriteFiles, false);
    await assert.rejects(
      () => services.fileLibraries.require(ownerId, projectId, library.id),
      (error: unknown) => error instanceof ProductError && error.code === "file_library_deleting"
    );
    await assert.rejects(
      () => services.fileLibraries.rename(ownerId,projectId,library.id,{name:"No rename",expectedUpdatedAt:library.updatedAt}),
      (error:unknown)=>error instanceof ProductError&&error.code==="file_library_deleting"
    );
    await assert.rejects(
      () => services.fileLibraries.withLibraryMutation(ownerId,projectId,library.id,async()=>undefined),
      (error:unknown)=>error instanceof ProductError&&error.code==="file_library_deleting"
    );
    await assert.rejects(
      () => services.fileLibraries.deleteEntry(ownerId,projectId,library.id,"nested","deleting-entry",async()=>undefined),
      (error:unknown)=>error instanceof ProductError&&error.code==="file_library_deleting"
    );
    await assert.rejects(()=>readdir(path.join(projectRoot,library.rootSubPath)),{code:"ENOENT"});

    assert.deepEqual(
      await services.fileLibraries.remove(ownerId, projectId, library.id, "retry-delete", async () => undefined),
      { deleted: true }
    );
    assert.deepEqual(
      await services.fileLibraries.remove(ownerId, projectId, library.id, "response-lost-delete", async () => undefined),
      { deleted: true }
    );
  });

  it("rejects a statically observed non-directory Library root without following it",async()=>{
    const {services,ownerId,projectId}=await fixture();
    const library=await services.fileLibraries.create(ownerId,projectId,{name:"Symlink root"});
    const regular=await services.fileLibraries.create(ownerId,projectId,{name:"Regular root"});
    const projectRoot=services.projectAbsoluteRoot((await services.authorization.requireProject(ownerId,projectId)).rootPath);
    const outside=await mkdtemp(path.join(tmpdir(),"asl-library-delete-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside,"retained.txt"),"retained");
    await rmdir(path.join(projectRoot,library.rootSubPath));
    await symlink(outside,path.join(projectRoot,library.rootSubPath));
    await rmdir(path.join(projectRoot,regular.rootSubPath));
    await writeFile(path.join(projectRoot,regular.rootSubPath),"not a directory");

    for(const target of [library,regular]){
      await assert.rejects(
        ()=>services.fileLibraries.remove(ownerId,projectId,target.id,`static-root-${target.id}`,async()=>undefined),
        (error:unknown)=>error instanceof ProductError&&
          error.statusCode===409&&
          error.code==="file_library_deleting"&&
          error.message==="File Library deletion is in progress"
      );
      assert.equal((await services.store.findFileLibrary(target.id))?.lifecycleStatus,"deleting");
    }
    assert.equal(await readFile(path.join(outside,"retained.txt"),"utf8"),"retained");
    await assert.rejects(()=>readdir(path.join(projectRoot,".deletions")),{code:"ENOENT"});
  });

  it("renews one serialized heartbeat during a slow accounting call",async()=>{
    const {services,store,ownerId,projectId}=await fixture();
    let renewals=0;
    let activeRenewals=0;
    let maxActiveRenewals=0;
    const renew=store.renewFileLibraryDeletionOperation.bind(store);
    store.renewFileLibraryDeletionOperation=async(owner,leaseMs)=>{
      renewals+=1;
      activeRenewals+=1;
      maxActiveRenewals=Math.max(maxActiveRenewals,activeRenewals);
      try{
        await new Promise<void>((resolve)=>setTimeout(resolve,4));
        return await renew(owner,leaseMs);
      }finally{
        activeRenewals-=1;
      }
    };
    const libraries=new FileLibraryService(
      store,
      services.authorization,
      services.files,
      services.projectAbsoluteRoot,
      {leaseMs:200,intervalMs:10}
    );
    const library=await libraries.create(ownerId,projectId,{name:"Heartbeat"});
    const beforeAccounting=renewals;

    assert.deepEqual(
      await libraries.remove(ownerId,projectId,library.id,"heartbeat-delete",async()=>{
        await new Promise<void>((resolve)=>setTimeout(resolve,55));
        assert.ok(renewals>beforeAccounting);
      }),
      {deleted:true}
    );
    assert.ok(renewals>=3);
    assert.equal(maxActiveRenewals,1);
    assert.equal(activeRenewals,0);
    const stoppedAt=renewals;
    await new Promise<void>((resolve)=>setTimeout(resolve,25));
    assert.equal(renewals,stoppedAt);
  });

  it("maps heartbeat claim loss to deleting and resumes with a new key",async()=>{
    const {services,store,dataRoot,ownerId,projectId}=await fixture();
    const project=await services.authorization.requireProject(ownerId,projectId);
    const projectRoot=services.projectAbsoluteRoot(project.rootPath);
    const files=new FileService(
      new FilePathValidationService(dataRoot),
      new DescriptorFileTreeWalker(),
      {async beforeRename(event){
        if(event.kind==="library")await new Promise<void>((resolve)=>setTimeout(resolve,25));
      }}
    );
    const libraries=new FileLibraryService(
      store,
      services.authorization,
      files,
      services.projectAbsoluteRoot,
      {leaseMs:100,intervalMs:5}
    );
    const library=await libraries.create(ownerId,projectId,{name:"Lost claim"});
    await files.uploadLibraryFile(projectRoot,library.rootSubPath,{
      path:"retained.txt",
      bytes:Buffer.from("retained")
    });
    const renew=store.renewFileLibraryDeletionOperation.bind(store);
    store.renewFileLibraryDeletionOperation=async()=>false;

    await assert.rejects(
      ()=>libraries.remove(ownerId,projectId,library.id,"lost-claim",async()=>undefined),
      (error:unknown)=>error instanceof ProductError&&
        error.statusCode===409&&
        error.code==="file_library_deleting"&&
        error.message==="File Library deletion is in progress"
    );
    assert.equal(await readFile(path.join(projectRoot,library.rootSubPath,"retained.txt"),"utf8"),"retained");
    assert.equal((await store.findFileLibrary(library.id))?.lifecycleStatus,"deleting");

    store.renewFileLibraryDeletionOperation=renew;
    assert.deepEqual(
      await libraries.remove(ownerId,projectId,library.id,"lost-claim-retry",async()=>undefined),
      {deleted:true}
    );
  });

  it("uses one Project-root descriptor when the pathname is replaced before quarantine rename",async()=>{
    const {services,store,dataRoot,ownerId,projectId}=await fixture();
    const project=await services.authorization.requireProject(ownerId,projectId);
    const projectRoot=services.projectAbsoluteRoot(project.rootPath);
    const displacedRoot=`${projectRoot}.displaced`;
    let replaced=false;
    const files=new FileService(
      new FilePathValidationService(dataRoot),
      new DescriptorFileTreeWalker(),
      {
        async beforeRename(event){
          if(event.kind!=="library"||replaced)return;
          replaced=true;
          await rename(projectRoot,displacedRoot);
          await mkdir(projectRoot,{recursive:true});
          await writeFile(path.join(projectRoot,"replacement.txt"),"replacement");
        }
      }
    );
    const libraries=new FileLibraryService(store,services.authorization,files,services.projectAbsoluteRoot);
    const library=await libraries.create(ownerId,projectId,{name:"Root replacement"});
    await files.uploadLibraryFile(projectRoot,library.rootSubPath,{
      path:"nested/value.txt",
      bytes:Buffer.from("value")
    });

    assert.deepEqual(
      await libraries.remove(ownerId,projectId,library.id,"root-replacement-delete",async()=>undefined),
      {deleted:true}
    );
    assert.equal(replaced,true);
    assert.equal(await readFile(path.join(projectRoot,"replacement.txt"),"utf8"),"replacement");
    await assert.rejects(()=>readdir(path.join(displacedRoot,library.rootSubPath)),{code:"ENOENT"});
  });

  it("persists and removes rename-time Library symlink and unsupported substitutions",async()=>{
    for(const entryType of ["symlink","unsupported"] as const){
      const {services,store,dataRoot,ownerId,projectId}=await fixture();
      const outside=await mkdtemp(path.join(tmpdir(),`asl-library-${entryType}-outside-`));
      roots.push(outside);
      const project=await services.authorization.requireProject(ownerId,projectId);
      const projectRoot=services.projectAbsoluteRoot(project.rootPath);
      let source="";
      let substituted=false;
      const files=new FileService(
        new FilePathValidationService(dataRoot),
        new DescriptorFileTreeWalker(),
        {
          async beforeRename(event){
            if(event.kind!=="library"||substituted)return;
            substituted=true;
            await rm(source,{recursive:true});
            if(entryType==="symlink")await symlink(path.join(outside,"retained.txt"),source);
            else await execFileAsync("mkfifo",[source]);
          }
        }
      );
      const libraries=new FileLibraryService(store,services.authorization,files,services.projectAbsoluteRoot);
      const library=await libraries.create(ownerId,projectId,{name:`Substituted ${entryType}`});
      source=path.join(projectRoot,library.rootSubPath);
      await files.uploadLibraryFile(projectRoot,library.rootSubPath,{
        path:"original.txt",
        bytes:Buffer.from("original")
      });
      await writeFile(path.join(outside,"retained.txt"),"retained");

      assert.deepEqual(
        await libraries.remove(ownerId,projectId,library.id,`substituted-${entryType}`,async()=>undefined),
        {deleted:true}
      );
      assert.equal(substituted,true);
      assert.equal(await readFile(path.join(outside,"retained.txt"),"utf8"),"retained");
      const audits=(await store.queryProjectAuditEvents(projectId,{limit:100})).items
        .filter((event)=>event.action==="file_library.delete"&&event.resourceId===library.id);
      assert.deepEqual(audits.map((event)=>event.detail),[{bytes:0}]);
    }
  });

  it("does not let a completed request key delete another Library",async()=>{
    const {services,ownerId,projectId}=await fixture();
    const first=await services.fileLibraries.create(ownerId,projectId,{name:"First key target"});
    const second=await services.fileLibraries.create(ownerId,projectId,{name:"Second key target"});
    const projectRoot=services.projectAbsoluteRoot((await services.authorization.requireProject(ownerId,projectId)).rootPath);
    await services.files.uploadLibraryFile(projectRoot,second.rootSubPath,{path:"retained.txt",bytes:Buffer.from("retained")});

    assert.deepEqual(await services.fileLibraries.remove(ownerId,projectId,first.id,"one-resource-key",async()=>undefined),{deleted:true});
    await assert.rejects(
      ()=>services.fileLibraries.remove(ownerId,projectId,second.id,"one-resource-key",async()=>undefined),
      /different request/
    );
    assert.equal((await services.store.findFileLibrary(second.id))?.lifecycleStatus,"active");
    assert.equal(await readFile(path.join(projectRoot,second.rootSubPath,"retained.txt"),"utf8"),"retained");
  });

  it("allocates and reuses the idempotency resource ID for create", async () => {
    const { services, ownerId, projectId } = await fixture();
    const first = await services.fileLibraries.create(ownerId, projectId, { name: "Stable" }, "stable-create-key");
    const replay = await services.fileLibraries.create(ownerId, projectId, { name: "Stable" }, "stable-create-key");
    assert.equal(replay.id, first.id);
    assert.equal((await services.fileLibraries.list(ownerId, projectId)).length, 1);
  });

  it("adopts an identical concurrent create without deleting its owned root",async()=>{
    const {services,store,ownerId,projectId}=await fixture();
    const project=await services.authorization.requireProject(ownerId,projectId);
    const create=store.createFileLibrary.bind(store);
    let marker="";
    let loserRoot="";
    store.createFileLibrary=async(value)=>{
      loserRoot=path.join(services.projectAbsoluteRoot(project.rootPath),value.rootSubPath);
      const winner={
        ...value,
        rootSubPath:`libraries/${value.id}-attempt_winner/home`
      };
      await services.files.ensureLibraryRoot(
        services.projectAbsoluteRoot(project.rootPath),
        winner.rootSubPath
      );
      const concurrent=await create(winner);
      assert.ok(concurrent);
      marker=path.join(services.projectAbsoluteRoot(project.rootPath),winner.rootSubPath,"concurrent.txt");
      await writeFile(marker,"owned by committed create");
      return null;
    };

    const created=await services.fileLibraries.create(
      ownerId,
      projectId,
      {name:"Concurrent owner"},
      "concurrent-owner-key"
    );

    assert.equal((await store.findFileLibrary(created.id))?.id,created.id);
    assert.equal(created.rootSubPath,`libraries/${created.id}-attempt_winner/home`);
    assert.equal(await readFile(marker,"utf8"),"owned by committed create");
    await assert.rejects(()=>readdir(path.dirname(loserRoot)),{code:"ENOENT"});
    assert.equal((await store.listFileLibrariesForProject(projectId)).length,1);
  });

  it("cleans only the exclusive different ID root after a duplicate-name conflict",async()=>{
    const {services,store,ownerId,projectId}=await fixture();
    const first=await services.fileLibraries.create(ownerId,projectId,{name:"Duplicate name"});
    const project=await services.authorization.requireProject(ownerId,projectId);
    const projectRoot=services.projectAbsoluteRoot(project.rootPath);
    const firstMarker=path.join(projectRoot,first.rootSubPath,"retained.txt");
    await writeFile(firstMarker,"retained");
    const create=store.createFileLibrary.bind(store);
    let attemptedRoot="";
    store.createFileLibrary=async(value)=>{
      attemptedRoot=path.join(projectRoot,value.rootSubPath);
      return create(value);
    };

    await assert.rejects(
      ()=>services.fileLibraries.create(
        ownerId,
        projectId,
        {name:"Duplicate name"},
        "different-id-duplicate-name"
      ),
      (error:unknown)=>{
        assert.ok(error instanceof ProductError);
        assert.equal(error.statusCode,409);
        assert.equal(error.message,"File Library name already exists");
        return true;
      }
    );

    assert.equal(await readFile(firstMarker,"utf8"),"retained");
    await assert.rejects(()=>readdir(path.dirname(attemptedRoot)),{code:"ENOENT"});
    assert.equal((await store.listFileLibrariesForProject(projectId)).length,1);
  });

  it("keeps the attempt root when the database create outcome is uncertain",async()=>{
    const {services,store,ownerId,projectId}=await fixture();
    const project=await services.authorization.requireProject(ownerId,projectId);
    let marker="";
    store.createFileLibrary=async(value)=>{
      marker=path.join(services.projectAbsoluteRoot(project.rootPath),value.rootSubPath,"uncertain.txt");
      await writeFile(marker,"retain");
      throw new Error("database outcome unknown");
    };

    await assert.rejects(
      ()=>services.fileLibraries.create(
        ownerId,
        projectId,
        {name:"Uncertain"},
        "uncertain-database-create"
      ),
      /File Library could not be created/
    );
    assert.equal(await readFile(marker,"utf8"),"retain");
  });

  it("does not expose a Library record when its root cannot be created", async () => {
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
    assert.deepEqual(await store.listFileLibrariesForProject(projectId),[]);
    const repaired = await services.fileLibraries.create(ownerId, projectId, { name: "Repair" }, "repair-create-key");
    assert.match(repaired.id,/^library_/);
    assert.equal((await store.listFileLibrariesForProject(projectId)).length, 1);
    assert.equal(ensureCalls,2);
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
    const deletion = services.fileLibraries.remove(ownerId, projectId, library.id, "serialized-delete", async () => undefined).finally(() => { deletionSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(deletionSettled, false);
    release();
    await mutation;
    assert.deepEqual(await deletion, { deleted: true });
  });

  it("holds the lifecycle lock before an expired same-key delete can reclaim its lease", async () => {
    const { services, store, ownerId, projectId } = await fixture();
    const library = await services.fileLibraries.create(ownerId, projectId, { name: "Delete lease" });
    const project = await services.authorization.requireProject(ownerId, projectId);
    const projectRoot = services.projectAbsoluteRoot(project.rootPath);
    await services.files.uploadLibraryFile(projectRoot, library.rootSubPath, {
      path: "selected/value.txt",
      bytes: Buffer.from("value")
    });

    const originalBegin = store.beginTaskIdempotency.bind(store);
    let beginCalls = 0;
    store.beginTaskIdempotency = (input) => {
      beginCalls += 1;
      if (beginCalls === 1) return originalBegin(input);
      const now = new Date(Date.parse(input.leaseExpiresAt) + 1).toISOString();
      return originalBegin({
        ...input,
        now,
        leaseExpiresAt: new Date(Date.parse(now) + 30_000).toISOString()
      });
    };

    let entered!: () => void;
    const accountingEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const accountingRelease = new Promise<void>((resolve) => { release = resolve; });
    const first = services.fileLibraries.deleteEntry(
      ownerId,
      projectId,
      library.id,
      "selected",
      "delete-lease-key",
      async () => {
        entered();
        await accountingRelease;
      }
    );
    await accountingEntered;
    const second = services.fileLibraries.deleteEntry(
      ownerId,
      projectId,
      library.id,
      "selected",
      "delete-lease-key",
      async () => undefined
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsWhileFirstOwnsLock = beginCalls;
    release();
    const results = await Promise.allSettled([first, second]);

    assert.equal(callsWhileFirstOwnsLock, 1);
    assert.equal(results.every((result) => result.status === "fulfilled"), true);
  });

  it("keeps a post-isolation typed failure retryable and leaves a recreated source untouched", async () => {
    const { services, store, ownerId, projectId } = await fixture();
    const library = await services.fileLibraries.create(ownerId, projectId, { name: "Delete retry" });
    const project = await services.authorization.requireProject(ownerId, projectId);
    const projectRoot = services.projectAbsoluteRoot(project.rootPath);
    await services.files.uploadLibraryFile(projectRoot, library.rootSubPath, {
      path: "selected/original.txt",
      bytes: Buffer.from("original")
    });

    const originalComplete = store.completeTaskIdempotency.bind(store);
    let deleteCompletionCalls = 0;
    store.completeTaskIdempotency = (input) => {
      if (input.operation === "project.file.delete") deleteCompletionCalls += 1;
      return originalComplete(input);
    };
    let rejectAccounting = true;
    const deletion = () => services.fileLibraries.deleteEntry(
      ownerId,
      projectId,
      library.id,
      "selected",
      "post-isolation-key",
      async () => {
        if (rejectAccounting) {
          rejectAccounting = false;
          throw new ProductError("Accounting changed", 409, "accounting_changed");
        }
      }
    );

    await assert.rejects(deletion, (error: unknown) =>
      error instanceof ProductError &&
      error.statusCode === 500 &&
      error.code === "file_deletion_incomplete"
    );
    assert.equal(deleteCompletionCalls, 0);

    await services.files.uploadLibraryFile(projectRoot, library.rootSubPath, {
      path: "selected/recreated.txt",
      bytes: Buffer.from("replacement")
    });
    const originalBegin = store.beginTaskIdempotency.bind(store);
    store.beginTaskIdempotency = (input) => {
      const now = new Date(Date.parse(input.leaseExpiresAt) + 1).toISOString();
      return originalBegin({
        ...input,
        now,
        leaseExpiresAt: new Date(Date.parse(now) + 30_000).toISOString()
      });
    };

    assert.deepEqual(await deletion(), { deleted: true });
    assert.equal(
      await readFile(path.join(projectRoot, library.rootSubPath, "selected", "recreated.txt"), "utf8"),
      "replacement"
    );
  });

  it("writes one Audit event with the actual rename-time substituted entry type", async () => {
    const { services, store, dataRoot, ownerId, projectId } = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "asl-file-delete-audit-outside-"));
    roots.push(outside);
    const project = await services.authorization.requireProject(ownerId, projectId);
    const projectRoot = services.projectAbsoluteRoot(project.rootPath);
    let source = "";
    let substituted = false;
    const files = new FileService(
      new FilePathValidationService(dataRoot),
      new DescriptorFileTreeWalker(),
      {
        async beforeRename() {
          if (substituted) return;
          substituted = true;
          await unlink(source);
          await symlink(path.join(outside, "retained.txt"), source);
        }
      }
    );
    const libraries = new FileLibraryService(
      store,
      services.authorization,
      files,
      services.projectAbsoluteRoot
    );
    const library = await libraries.create(ownerId, projectId, { name: "Substituted Audit" });
    source = path.join(projectRoot, library.rootSubPath, "selected.txt");
    await files.uploadLibraryFile(projectRoot, library.rootSubPath, {
      path: "selected.txt",
      bytes: Buffer.from("static")
    });
    await writeFile(path.join(outside, "retained.txt"), "retained");

    assert.deepEqual(
      await libraries.deleteEntry(ownerId, projectId, library.id, "selected.txt", "substituted-audit-key", async () => undefined),
      { deleted: true }
    );
    assert.equal(substituted, true);
    const audits = (await store.queryProjectAuditEvents(projectId, { limit: 100 })).items
      .filter((event) => event.action === "file.delete" && event.resourceId === library.id);
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0]?.detail, {
      filePath: `${library.rootSubPath}/selected.txt`,
      bytes: 0,
      entryType: "symlink"
    });
    assert.equal(await readFile(path.join(outside, "retained.txt"), "utf8"), "retained");
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

  it("fails closed when workspaces or projects is an intermediate symlink",async()=>{
    for(const component of ["workspaces","projects"] as const){
      const {services,ownerId,projectId,dataRoot}=await fixture();
      const project=await services.authorization.requireProject(ownerId,projectId);
      const segments=project.rootPath.split("/");
      const outside=await mkdtemp(path.join(tmpdir(),`asl-${component}-symlink-`));
      roots.push(outside);
      if(component==="workspaces"){
        await symlink(outside,path.join(dataRoot,"workspaces"));
      }else{
        const workspaceRoot=path.join(dataRoot,segments[0]!,segments[1]!);
        await mkdir(workspaceRoot,{recursive:true});
        await symlink(outside,path.join(workspaceRoot,"projects"));
      }

      await assert.rejects(
        ()=>services.fileLibraries.create(ownerId,projectId,{name:`Unsafe ${component}`}),
        /symlink|symbolic|ELOOP|ENOTDIR|not a directory/i
      );
      assert.deepEqual(await readdir(outside),[]);
    }
  });

  it("creates a non-live Task without requiring a live namespace limit",async()=>{
    const {services,ownerId,projectId}=await fixture();
    const endpointId=await taskEndpoint(services,ownerId,projectId,"non-live");

    const created=await services.tasks.createTask(ownerId,projectId,{
      endpointId,
      prompt:"non-live task",
      fileLibrary:{mode:"create_new",name:"Non-live files"}
    },"non-live-task");

    assert.equal(created.sandboxState.state,"released");
    assert.equal(created.sandboxState.runId,null);
  });

  it("still requires a namespace limit for live Task admission",async()=>{
    const {services,ownerId,projectId}=await fixture(true,null);
    const endpointId=await taskEndpoint(services,ownerId,projectId,"missing-live-limit");

    await assert.rejects(
      ()=>services.tasks.createTask(ownerId,projectId,{
        endpointId,
        prompt:"live task without capacity configuration",
        fileLibrary:{mode:"create_new",name:"Missing limit files"}
      },"missing-live-limit-task"),
      /sandbox\.namespaceLimit must be configured as a positive integer/
    );
  });

  it("aborts slow Botified readiness and immediately unblocks deadline cleanup",async()=>{
    let healthAborted=false;
    let resolveHealthAbort!:()=>void;
    const healthAbortObserved=new Promise<void>((resolve)=>{resolveHealthAbort=resolve;});
    const botified=new class extends DryRunBotifiedRuntimeHttpClient{
      override async health(_baseUrl?:string,_serviceKey?:string,signal?:AbortSignal):Promise<{status:"ok"}>{
        return new Promise<{status:"ok"}>((_resolve,reject)=>{
          const abort=()=>{healthAborted=true;resolveHealthAbort();reject(signal?.reason);};
          if(signal?.aborted)abort();
          else signal?.addEventListener("abort",abort,{once:true});
        });
      }
    };
    const {services,store,ownerId,projectId}=await fixture(true,100,{botifiedClient:botified,startupActionTimeoutMs:100});
    const endpointId=await taskEndpoint(services,ownerId,projectId,"slow-health");
    const created=await services.tasks.createTask(ownerId,projectId,{
      endpointId,
      prompt:"slow Botified readiness",
      fileLibrary:{mode:"create_new",name:"Slow health files"}
    },"slow-health-task");
    const task=await store.findTask(created.task.id);assert.ok(task?.currentRunId);

    const run=await store.sandboxRuns.get(task.currentRunId);assert.ok(run);
    const receipt=await services.tasks.startTaskTerminal(ownerId,task.id,{expectedRunId:run.runId,expectedSandboxState:run.state},"slow-health-terminal");
    store.findTaskPreparationOperation=async()=>null;
    store.listTaskMessagesDue=async()=>[];
    store.listActiveTasks=async()=>[];
    const sync=services.tasks.syncActiveTasksOnce();

    assert.equal(receipt.outcome,"accepted_in_progress");
    await waitForObservedAbort(healthAbortObserved,"Botified health");
    await sync;
    assert.equal(healthAborted,true);
    assert.equal(services.tasks.hasLocalStartupOperation(task.currentRunId),false);
    assert.notEqual((await store.sandboxRuns.get(task.currentRunId))?.startedAt,null);
    assert.equal((await services.policies.getUsageOverview(ownerId,projectId)).sandbox.launches,1);
    const reaped=await services.sandboxLifecycle.reapSandboxRunsOnce({apply:true,runId:task.currentRunId});
    assert.deepEqual(reaped.errors,[]);
    assert.equal((await store.sandboxRuns.get(task.currentRunId))?.state,"failed");
  });

  it("aborts a slow final Botified state identity read and unblocks cleanup",async()=>{
    let stateReadAborted=false;
    let resolveStateReadAbort!:()=>void;
    const stateReadAbortObserved=new Promise<void>((resolve)=>{resolveStateReadAbort=resolve;});
    const botified=new class extends DryRunBotifiedRuntimeHttpClient{
      override async readState(_baseUrl?:string,_serviceKey?:string,signal?:AbortSignal){
        return new Promise<never>((_resolve,reject)=>{
          const abort=()=>{stateReadAborted=true;resolveStateReadAbort();reject(signal?.reason);};
          if(signal?.aborted)abort();
          else signal?.addEventListener("abort",abort,{once:true});
        });
      }
    };
    const {services,store,ownerId,projectId}=await fixture(true,100,{botifiedClient:botified,startupActionTimeoutMs:100});
    const endpointId=await taskEndpoint(services,ownerId,projectId,"slow-state");
    const created=await services.tasks.createTask(ownerId,projectId,{
      endpointId,
      prompt:"slow Botified state identity read",
      fileLibrary:{mode:"create_new",name:"Slow state files"}
    },"slow-state-task");
    const task=await store.findTask(created.task.id);assert.ok(task?.currentRunId);

    const run=await store.sandboxRuns.get(task.currentRunId);assert.ok(run);
    const receipt=await services.tasks.startTaskTerminal(ownerId,task.id,{expectedRunId:run.runId,expectedSandboxState:run.state},"slow-state-terminal");
    store.findTaskPreparationOperation=async()=>null;
    store.listTaskMessagesDue=async()=>[];
    store.listActiveTasks=async()=>[];
    const sync=services.tasks.syncActiveTasksOnce();

    assert.equal(receipt.outcome,"accepted_in_progress");
    await waitForObservedAbort(stateReadAbortObserved,"final Botified state read");
    await sync;
    assert.equal(stateReadAborted,true);
    assert.equal(services.tasks.hasLocalStartupOperation(task.currentRunId),false);
    const reaped=await services.sandboxLifecycle.reapSandboxRunsOnce({apply:true,runId:task.currentRunId});
    assert.deepEqual(reaped.errors,[]);
    assert.equal((await store.sandboxRuns.get(task.currentRunId))?.state,"failed");
  });

  it("aborts the first Botified state rebuild without restoring the missing runtime document",async()=>{
    let stateReadAborted=false;
    let stateReadSignal:AbortSignal|undefined;
    let resolveStateReadAbort!:()=>void;
    const stateReadAbortObserved=new Promise<void>((resolve)=>{resolveStateReadAbort=resolve;});
    const botified=new class extends DryRunBotifiedRuntimeHttpClient{
      override async readState(_baseUrl?:string,_serviceKey?:string,signal?:AbortSignal){
        stateReadSignal=signal;
        return new Promise<never>((_resolve,reject)=>{
          const abort=()=>{stateReadAborted=true;resolveStateReadAbort();reject(signal?.reason);};
          if(signal?.aborted)abort();
          else signal?.addEventListener("abort",abort,{once:true});
        });
      }
    };
    const {services,store,ownerId,projectId}=await fixture(true,100,{botifiedClient:botified,startupActionTimeoutMs:100});
    const endpointId=await taskEndpoint(services,ownerId,projectId,"slow-state-rebuild");
    const created=await services.tasks.createTask(ownerId,projectId,{
      endpointId,
      prompt:"slow missing runtime state rebuild",
      fileLibrary:{mode:"create_new",name:"Slow state rebuild files"}
    },"slow-state-rebuild-task");
    const task=await store.findTask(created.task.id);assert.ok(task?.currentRunId);
    await store.jsonDocs.delete("sandbox_runtime_state",task.id);
    assert.equal(await store.jsonDocs.get("sandbox_runtime_state",task.id),null);

    const run=await store.sandboxRuns.get(task.currentRunId);assert.ok(run);
    const receipt=await services.tasks.startTaskTerminal(ownerId,task.id,{expectedRunId:run.runId,expectedSandboxState:run.state},"slow-state-rebuild-terminal");
    store.findTaskPreparationOperation=async()=>null;
    store.listTaskMessagesDue=async()=>[];
    store.listActiveTasks=async()=>[];
    const sync=services.tasks.syncActiveTasksOnce();

    assert.equal(receipt.outcome,"accepted_in_progress");
    await waitForObservedAbort(stateReadAbortObserved,"initial Botified state rebuild");
    await sync;
    assert.equal(stateReadSignal?.aborted,true);
    assert.equal(stateReadAborted,true);
    assert.equal(services.tasks.hasLocalStartupOperation(task.currentRunId),false);
    assert.equal(await store.jsonDocs.get("sandbox_runtime_state",task.id),null);
  });

  it("does not start runtime accounting when the Pod fails before readiness",async()=>{
    const {services,store,ownerId,projectId}=await fixture(true,100,{
      podReadiness:{state:"failed",podUid:"fixture-pod-uid"}
    });
    const endpointId=await taskEndpoint(services,ownerId,projectId,"pod-not-ready");
    const created=await services.tasks.createTask(ownerId,projectId,{
      endpointId,
      prompt:"Pod fails before readiness",
      fileLibrary:{mode:"create_new",name:"Pod not ready files"}
    },"pod-not-ready-task");
    const task=await store.findTask(created.task.id);assert.ok(task?.currentRunId);
    const run=await store.sandboxRuns.get(task.currentRunId);assert.ok(run);

    await services.tasks.startTaskTerminal(
      ownerId,
      task.id,
      {expectedRunId:run.runId,expectedSandboxState:run.state},
      "pod-not-ready-terminal"
    );
    store.findTaskPreparationOperation=async()=>null;
    store.listTaskMessagesDue=async()=>[];
    store.listActiveTasks=async()=>[];
    await services.tasks.syncActiveTasksOnce();

    assert.equal((await store.sandboxRuns.get(task.currentRunId))?.startedAt,null);
    const usage=(await services.policies.getUsageOverview(ownerId,projectId)).sandbox;
    assert.equal(usage.launches,0);
    assert.equal(usage.totalDurationSeconds,"0");
  });

  it("does not prepare an existing Library before a rejected live admission",async()=>{
    const {services,store,ownerId,projectId}=await fixture(true);
    const endpointId=await taskEndpoint(services,ownerId,projectId,"capacity");
    const existing=await services.fileLibraries.create(ownerId,projectId,{name:"Existing cold Library"});
    const project=await services.authorization.requireProject(ownerId,projectId);
    const libraryRoot=path.join(services.projectAbsoluteRoot(project.rootPath),existing.rootSubPath);
    const before=await directoryTree(libraryRoot);
    const policy=await services.store.findProjectResourcePolicy(projectId);
    assert.ok(policy);
    await services.store.patchProjectResourcePolicy(projectId,{sandboxLimit:1},new Date(Date.parse(policy.updatedAt)+1).toISOString(),policy.updatedAt);
    await services.tasks.createTask(ownerId,projectId,{
      endpointId,
      prompt:"occupy the only slot",
      fileLibrary:{mode:"create_new",name:"Occupying files"}
    },"occupying-live-task");
    const createTaskAtomically=store.createTaskAtomically.bind(store);
    let rejectedStagingRoot:string|null=null;
    store.createTaskAtomically=async(input)=>{
      if(input.task.prompt==="must be rejected before filesystem preparation"){
        rejectedStagingRoot=path.join(services.projectAbsoluteRoot(project.rootPath),".preparations",input.task.id);
        await assert.rejects(()=>readdir(rejectedStagingRoot!),{code:"ENOENT"});
        assert.deepEqual(await directoryTree(libraryRoot),before);
      }
      return createTaskAtomically(input);
    };

    await assert.rejects(
      ()=>services.tasks.createTask(ownerId,projectId,{
        endpointId,
        prompt:"must be rejected before filesystem preparation",
        fileLibrary:{mode:"use_existing",id:existing.id}
      },"rejected-existing-library"),
      (error:unknown)=>error instanceof Error&&"statusCode" in error&&(error as {statusCode:number}).statusCode===409
    );
    assert.ok(rejectedStagingRoot);
    await assert.rejects(()=>readdir(rejectedStagingRoot!),{code:"ENOENT"});
    assert.deepEqual(await directoryTree(libraryRoot),before);
  });

  it("resumes the same promoted Task and Run after a readiness handoff interruption",async()=>{
    const {services,store,ownerId,projectId}=await fixture(true);
    const endpointId=await taskEndpoint(services,ownerId,projectId,"promotion-retry");
    const markReady=store.markTaskSandboxStartupReady.bind(store);
    let interrupted=true;
    store.markTaskSandboxStartupReady=async(input)=>{
      if(interrupted){interrupted=false;throw new Error("readiness handoff interrupted");}
      return markReady(input);
    };
    const request={endpointId,prompt:"resume promoted workspace",fileLibrary:{mode:"create_new" as const,name:"Promotion retry files"}};
    await assert.rejects(()=>services.tasks.createTask(ownerId,projectId,request,"promotion-retry"),/readiness handoff interrupted/);
    const admitted=(await store.listTasksForProject(projectId)).find((task)=>task.prompt===request.prompt);
    assert.ok(admitted?.currentRunId);
    const admittedRunId=admitted.currentRunId;
    const begin=store.beginTaskIdempotency.bind(store);
    store.beginTaskIdempotency=(input)=>begin({...input,now:new Date(Date.now()+120_000).toISOString()});

    const recovered=await services.tasks.createTask(ownerId,projectId,request,"promotion-retry");
    assert.equal(recovered.task.id,admitted.id);
    assert.equal(recovered.sandboxState.runId,admittedRunId);
    assert.ok((await store.sandboxRuns.get(admittedRunId))?.startupReadyAt);
    assert.equal((await store.sandboxRuns.list()).filter((run)=>run.taskId===admitted.id).length,1);
  });

  it("fails closed when a promoted Task marker does not match its admission operation",async()=>{
    const {services,store,dataRoot,ownerId,projectId}=await fixture(true);
    const endpointId=await taskEndpoint(services,ownerId,projectId,"marker-mismatch");
    const markReady=store.markTaskSandboxStartupReady.bind(store);
    let interrupted=true;
    store.markTaskSandboxStartupReady=async(input)=>{
      if(interrupted){interrupted=false;throw new Error("readiness handoff interrupted");}
      return markReady(input);
    };
    const request={endpointId,prompt:"reject mismatched promoted marker",fileLibrary:{mode:"create_new" as const,name:"Marker files"}};
    await assert.rejects(()=>services.tasks.createTask(ownerId,projectId,request,"marker-mismatch"),/readiness handoff interrupted/);
    const admitted=(await store.listTasksForProject(projectId)).find((task)=>task.prompt===request.prompt);
    assert.ok(admitted);
    const project=await services.authorization.requireProject(ownerId,projectId);
    const taskRoot=path.join(services.projectAbsoluteRoot(project.rootPath),"tasks",admitted.id);
    const markerPath=path.join(taskRoot,".agentsmith-preparation.json");
    const admittedMarker=await readFile(markerPath,"utf8");
    await writeFile(markerPath,JSON.stringify({taskId:"foreign"}));
    const begin=store.beginTaskIdempotency.bind(store);
    store.beginTaskIdempotency=(input)=>begin({...input,now:new Date(Date.now()+120_000).toISOString()});

    await assert.rejects(
      ()=>services.tasks.createTask(ownerId,projectId,request,"marker-mismatch"),
      /marker/
    );
    assert.equal((await store.sandboxRuns.get(admitted.currentRunId!))?.startupReadyAt,null);

    const externalMarker=path.join(dataRoot,"external-preparation-marker.json");
    await writeFile(externalMarker,admittedMarker);
    await rm(markerPath);
    await symlink(externalMarker,markerPath);
    await assert.rejects(
      ()=>services.tasks.createTask(ownerId,projectId,request,"marker-mismatch"),
      /marker|symlink|ELOOP/
    );
    assert.equal((await store.sandboxRuns.get(admitted.currentRunId!))?.startupReadyAt,null);
  });

  it("rejects a foreign existing Library target instead of treating it as promotion recovery",async()=>{
    const {services,store,ownerId,projectId}=await fixture(true);
    const endpointId=await taskEndpoint(services,ownerId,projectId,"foreign-library-target");
    const project=await services.authorization.requireProject(ownerId,projectId);
    const createTaskAtomically=store.createTaskAtomically.bind(store);
    let foreignRoot:string|null=null;
    store.createTaskAtomically=async(input)=>{
      const result=await createTaskAtomically(input);
      if(input.task.prompt==="foreign target must not resume"&&input.newFileLibrary){
        foreignRoot=path.join(services.projectAbsoluteRoot(project.rootPath),input.newFileLibrary.rootSubPath);
        await mkdir(foreignRoot,{recursive:true});
        await writeFile(path.join(foreignRoot,"foreign.txt"),"foreign");
      }
      return result;
    };

    await assert.rejects(
      ()=>services.tasks.createTask(ownerId,projectId,{
        endpointId,prompt:"foreign target must not resume",
        fileLibrary:{mode:"create_new",name:"Foreign target"}
      },"foreign-library-target"),
      /existing target|marker|operation/
    );
    assert.ok(foreignRoot);
    assert.equal(await readFile(path.join(foreignRoot!,"foreign.txt"),"utf8"),"foreign");
    const admitted=(await store.listTasksForProject(projectId)).find((task)=>task.prompt==="foreign target must not resume");
    assert.ok(admitted?.currentRunId);
    assert.equal((await store.sandboxRuns.get(admitted.currentRunId))?.startupReadyAt,null);
  });
});

async function fixture(
  live=false,
  namespaceLimit:number|null=live?100:null,
  options:{botifiedClient?:BotifiedRuntimeHttpClient;startupActionTimeoutMs?:number;podReadiness?:PodReadiness}={}
) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-file-library-service-"));
  roots.push(dataRoot);
  const store = createLocalInMemoryProductStore();
  const builtinAdminPassword=live?"production-admin-password":"admin-password";
  const resources=new Map<string,KubernetesResource>();
  const resourceKey=(resource:Pick<KubernetesResource,"kind"|"metadata">)=>
    `${resource.kind}/${resource.metadata.namespace??"default"}/${resource.metadata.name}`;
  const services = Object.assign(createApplicationServices({
    store,
    dataRoot,
    builtinAdminPassword,
    providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}},
    ...(options.botifiedClient?{botifiedClient:options.botifiedClient}:{}),
    ...(live?{
      sessionSecret:"production-session-secret-32-chars",
      ...(namespaceLimit===null?{}:{sandboxNamespaceLimit:namespaceLimit}),
      botifiedServiceKeyFactory:({taskId}:{taskId:string})=>taskId,
      liveSandbox:{
        ...(options.startupActionTimeoutMs!==undefined?{startupActionTimeoutMs:options.startupActionTimeoutMs}:{}),
        port:{
          async applyResource(resource:KubernetesResource){
            const uid=resource.kind==="Pod"?"fixture-pod-uid":`fixture-${resource.kind.toLowerCase()}-${resource.metadata.name}`;
            resources.set(resourceKey(resource),structuredClone({
              ...resource,
              metadata:{...resource.metadata,uid}
            }));
            return"applied" as const;
          },
          async deleteResource(ref:{kind:string;namespace:string;name:string}){
            const key=`${ref.kind}/${ref.namespace}/${ref.name}`;
            return resources.delete(key)?"deleted" as const:"not_found" as const;
          },
          async getPodReadiness(namespace:string,name:string){
            if(!resources.has(`Pod/${namespace}/${name}`))return"not_found" as const;
            return options.podReadiness??{state:"ready" as const,podUid:"fixture-pod-uid",podIp:"10.0.0.2"};
          },
          async getConfigMapData(namespace:string,name:string){
            const resource=resources.get(`ConfigMap/${namespace}/${name}`);
            const data=resource?.data;
            return data&&typeof data==="object"&&!Array.isArray(data)
              ?{data:structuredClone(data) as Record<string,string>}
              :"not_found" as const;
          },
          async listManagedResources(namespace:string){
            return[...resources.values()]
              .filter((resource)=>resource.metadata.namespace===namespace)
              .map((resource)=>structuredClone(resource));
          },
          async inspectResource(ref:{kind:string;namespace:string;name:string}){
            const resource=resources.get(`${ref.kind}/${ref.namespace}/${ref.name}`);
            return resource?{state:"present" as const,resource:structuredClone(resource)}:"not_found" as const;
          }
        }
      }
    }:{})
  }), { store });
  const owner = await services.auth.loginAfterBootstrap(builtinAdminPassword);
  const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
  const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
  const viewer = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "viewer", email: "viewer@example.test", emailVerified: true });
  const now = new Date().toISOString();
  await store.upsertProjectMembership({ projectId: project.id, userId: viewer.user.id, role: "viewer", createdAt: now, updatedAt: now });
  return { services, store, dataRoot, ownerId: owner.user.id, viewerId: viewer.user.id, projectId: project.id };
}

async function waitForObservedAbort(observed:Promise<void>,label:string):Promise<void>{
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{
    await Promise.race([
      observed,
      new Promise<never>((_resolve,reject)=>{
        timeout=setTimeout(()=>reject(new Error(`${label} was not aborted`)),1_000);
      })
    ]);
  }finally{
    if(timeout)clearTimeout(timeout);
  }
}

async function taskEndpoint(
  services:Awaited<ReturnType<typeof fixture>>["services"],
  ownerId:string,
  projectId:string,
  label:string
):Promise<string>{
  const credential=await services.credentials.create(ownerId,projectId,{name:`Credential ${label}`,baseUrl:"https://models.example.test/v1",secret:`secret-${label}`});
  return (await services.endpoints.createEndpoint(ownerId,projectId,{
    name:`Endpoint ${label}`,
    protocol:"openai_chat_completions",
    baseUrl:"https://models.example.test/v1",
    model:"model",
    credentialId:credential.id,
    capabilities:["text","tool_calls"],
    requestTimeoutSecs:30
  })).id;
}

async function directoryTree(root:string):Promise<string[]>{
  const entries:string[]=[];
  const walk=async(directory:string,prefix:string):Promise<void>=>{
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const relative=path.posix.join(prefix,entry.name);
      entries.push(`${entry.isDirectory()?"d":"f"}:${relative}`);
      if(entry.isDirectory())await walk(path.join(directory,entry.name),relative);
    }
  };
  await walk(root,"");
  return entries.sort();
}
