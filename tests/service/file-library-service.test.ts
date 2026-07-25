import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { DryRunBotifiedRuntimeHttpClient, type BotifiedRuntimeHttpClient } from "../../packages/ports/src/botified.js";
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
    const botified=new class extends DryRunBotifiedRuntimeHttpClient{
      override async health(_baseUrl?:string,_serviceKey?:string,signal?:AbortSignal):Promise<{status:"ok"}>{
        return new Promise<{status:"ok"}>((_resolve,reject)=>{
          const abort=()=>{healthAborted=true;reject(signal?.reason);};
          if(signal?.aborted)abort();
          else signal?.addEventListener("abort",abort,{once:true});
        });
      }
    };
    const {services,store,ownerId,projectId}=await fixture(true,100,{botifiedClient:botified,startupActionTimeoutMs:5});
    const endpointId=await taskEndpoint(services,ownerId,projectId,"slow-health");
    const created=await services.tasks.createTask(ownerId,projectId,{
      endpointId,
      prompt:"slow Botified readiness",
      fileLibrary:{mode:"create_new",name:"Slow health files"}
    },"slow-health-task");
    const task=await store.findTask(created.task.id);assert.ok(task?.currentRunId);

    const receipt=await services.tasks.startTaskTerminal(ownerId,task.id,"slow-health-terminal");

    assert.equal(receipt.status,"in_progress");
    assert.equal(healthAborted,true);
    await new Promise<void>((resolve)=>setImmediate(resolve));
    assert.equal(services.tasks.hasLocalStartupOperation(task.currentRunId),false);
    const reaped=await services.sandboxLifecycle.reapSandboxRunsOnce({apply:true,runId:task.currentRunId});
    assert.deepEqual(reaped.errors,[]);
    assert.equal((await store.sandboxRuns.get(task.currentRunId))?.state,"failed");
  });

  it("aborts a slow final Botified state identity read and unblocks cleanup",async()=>{
    let stateReadAborted=false;
    const botified=new class extends DryRunBotifiedRuntimeHttpClient{
      override async readState(_baseUrl?:string,_serviceKey?:string,signal?:AbortSignal){
        return new Promise<never>((_resolve,reject)=>{
          const abort=()=>{stateReadAborted=true;reject(signal?.reason);};
          if(signal?.aborted)abort();
          else signal?.addEventListener("abort",abort,{once:true});
        });
      }
    };
    const {services,store,ownerId,projectId}=await fixture(true,100,{botifiedClient:botified,startupActionTimeoutMs:5});
    const endpointId=await taskEndpoint(services,ownerId,projectId,"slow-state");
    const created=await services.tasks.createTask(ownerId,projectId,{
      endpointId,
      prompt:"slow Botified state identity read",
      fileLibrary:{mode:"create_new",name:"Slow state files"}
    },"slow-state-task");
    const task=await store.findTask(created.task.id);assert.ok(task?.currentRunId);

    const receipt=await services.tasks.startTaskTerminal(ownerId,task.id,"slow-state-terminal");

    assert.equal(receipt.status,"in_progress");
    assert.equal(stateReadAborted,true);
    await new Promise<void>((resolve)=>setImmediate(resolve));
    assert.equal(services.tasks.hasLocalStartupOperation(task.currentRunId),false);
    const reaped=await services.sandboxLifecycle.reapSandboxRunsOnce({apply:true,runId:task.currentRunId});
    assert.deepEqual(reaped.errors,[]);
    assert.equal((await store.sandboxRuns.get(task.currentRunId))?.state,"failed");
  });

  it("aborts the first Botified state rebuild without restoring the missing runtime document",async()=>{
    let stateReadAborted=false;
    let stateReadSignal:AbortSignal|undefined;
    const botified=new class extends DryRunBotifiedRuntimeHttpClient{
      override async readState(_baseUrl?:string,_serviceKey?:string,signal?:AbortSignal){
        stateReadSignal=signal;
        return new Promise<never>((_resolve,reject)=>{
          const abort=()=>{stateReadAborted=true;reject(signal?.reason);};
          if(signal?.aborted)abort();
          else signal?.addEventListener("abort",abort,{once:true});
        });
      }
    };
    const {services,store,ownerId,projectId}=await fixture(true,100,{botifiedClient:botified,startupActionTimeoutMs:5});
    const endpointId=await taskEndpoint(services,ownerId,projectId,"slow-state-rebuild");
    const created=await services.tasks.createTask(ownerId,projectId,{
      endpointId,
      prompt:"slow missing runtime state rebuild",
      fileLibrary:{mode:"create_new",name:"Slow state rebuild files"}
    },"slow-state-rebuild-task");
    const task=await store.findTask(created.task.id);assert.ok(task?.currentRunId);
    await store.jsonDocs.delete("sandbox_runtime_state",task.id);
    assert.equal(await store.jsonDocs.get("sandbox_runtime_state",task.id),null);

    const receipt=await services.tasks.startTaskTerminal(ownerId,task.id,"slow-state-rebuild-terminal");

    assert.equal(receipt.status,"in_progress");
    assert.equal(stateReadSignal?.aborted,true);
    assert.equal(stateReadAborted,true);
    await new Promise<void>((resolve)=>setImmediate(resolve));
    assert.equal(services.tasks.hasLocalStartupOperation(task.currentRunId),false);
    assert.equal(await store.jsonDocs.get("sandbox_runtime_state",task.id),null);
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
        assert.notEqual((await readdir(rejectedStagingRoot)).length,0);
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
  options:{botifiedClient?:BotifiedRuntimeHttpClient;startupActionTimeoutMs?:number}={}
) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-file-library-service-"));
  roots.push(dataRoot);
  const store = createLocalInMemoryProductStore();
  const builtinAdminPassword=live?"production-admin-password":"admin-password";
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
          async applyResource(){return"applied" as const;},
          async deleteResource(){return"deleted" as const;},
          async getPodReadiness(){return"ready" as const;},
          async listManagedResources(){return[];}
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
