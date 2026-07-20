import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import type {
  BotifiedDeliveryMessageInput,
  BotifiedDeliveryReceipt,
  BotifiedRuntimeHttpClient,
  BotifiedRuntimeStateResult,
  BotifiedTimelineReadResult,
  BotifiedUploadFileInput
} from "../../packages/ports/src/botified.js";
import type { KubernetesResourceRef, PodReadiness, SandboxKubernetesMutationPort, SandboxKubernetesReadinessPort } from "../../packages/sandbox-controller/src/kubernetesPort.js";

describe("Phase 3 durable Botified task sessions", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive:true, force:true }))));

  it("keeps two tasks in isolated sessions and stores each initial prompt as a message", async () => {
    const setup = await fixture();
    const first = await setup.create("first");
    const second = await setup.create("second");
    setup.botified.sessions.set(first.id, first.id);
    setup.botified.sessions.set(second.id, second.id);
    await setup.services.tasks.syncActiveTasksOnce();

    assert.deepEqual(setup.botified.posts.map((post) => [post.taskId, post.input.text]), [[first.id, "first"], [second.id, "second"]]);
    assert.deepEqual((await setup.store.listTaskMessages(first.id)).map((message) => message.content), ["first"]);
    assert.deepEqual((await setup.store.listTaskMessages(second.id)).map((message) => message.content), ["second"]);
  });

  it("delivers sequential turns and a message sent while running to the same Task session", async () => {
    const setup = await fixture();
    const task = await setup.create("initial");
    setup.botified.sessions.set(task.id, task.id);
    await setup.services.tasks.syncActiveTasksOnce();
    await setup.services.tasks.sendTaskMessage(setup.userId, task.id, "queued while running", "queued-key");
    setup.botified.timelines.set(task.id, [{ status:"ok", events:[event(task.id, 1, "cycle.completed")], nextCursor:`evt_${token(task.id)}_1`, historyBoundary:"start" }]);
    await setup.services.tasks.syncActiveTasksOnce();
    setup.botified.runtimeStates.set(task.id,"idle");
    const ready=await setup.services.tasks.getTaskDetail(setup.userId,task.id);
    assert.equal(ready.currentTurn.state,"ready");
    assert.equal(ready.lifecycle.state,"active");
    assert.equal(ready.sandboxState.state,"active");
    await setup.services.tasks.sendTaskMessage(setup.userId, task.id, "next turn", "next-key");

    assert.deepEqual(setup.botified.posts.filter((post) => post.taskId === task.id).map((post) => post.input.text), ["initial", "queued while running", "next turn"]);
    const stored = await setup.store.findTask(task.id);
    assert.equal(stored?.terminalReason, null);
    assert.equal(stored?.status, "running");
    assert.equal((await setup.store.sandboxRuns.get(task.runId))?.cleanupStatus, "active");
  });

  it("recovers a duplicate accepted delivery after restart without reposting", async () => {
    const setup = await fixture();
    const task = await setup.create("recover receipt");
    setup.botified.sessions.set(task.id, task.id);
    setup.botified.throwAfterAccept = true;
    await setup.services.tasks.syncActiveTasksOnce();
    assert.equal(setup.botified.posts.length, 1);
    const restarted=setup.restart();
    await restarted.tasks.syncActiveTasksOnce();
    assert.equal(setup.botified.posts.length, 1);
    assert.equal((await setup.store.listTaskMessages(task.id))[0]?.deliveryStatus, "accepted");
  });

  it("keeps the oldest unresolved claim ahead of later messages after restart",async()=>{
    const setup=await fixture();
    const task=await setup.create("ordered");
    setup.botified.sessions.set(task.id,task.id);
    await setup.services.tasks.syncActiveTasksOnce();
    const now="2026-07-19T00:00:00.000Z";
    const oldest=await setup.store.createTaskMessage(message(task.id,"message_oldest","oldest",now));
    await setup.store.createTaskMessage(message(task.id,"message_later","later","2026-07-19T00:00:01.000Z"));
    await setup.store.claimTaskMessage({id:oldest.id,claimToken:"oldest-claim",claimedAt:now,leaseExpiresAt:"2099-01-01T00:00:00.000Z"});
    assert.equal(await setup.store.claimTaskMessage({id:"message_later",claimToken:"later-claim",claimedAt:now,leaseExpiresAt:"2099-01-01T00:00:00.000Z"}),null);
    const postsBefore=setup.botified.posts.length;

    await setup.restart().tasks.syncActiveTasksOnce();

    assert.equal(setup.botified.posts.length,postsBefore);
    assert.equal((await setup.store.findTaskMessage("message_later"))?.deliveryStatus,"pending");
  });

  it("fails closed for Botified state and timeline session mismatches", async () => {
    const setup = await fixture();
    const task = await setup.create("identity");
    setup.botified.sessions.set(task.id, "another-task");
    const first = await setup.services.tasks.syncActiveTasksOnce();
    assert.deepEqual(first.failedTaskIds, [task.id]);
    assert.equal(setup.botified.posts.length, 0);

    setup.botified.sessions.set(task.id, task.id);
    await setup.services.tasks.syncActiveTasksOnce();
    setup.botified.timelines.set(task.id, [{ status:"ok", events:[event("another-task", 1, "cycle.completed")], nextCursor:"evt_other_1", historyBoundary:"start" }]);
    const second = await setup.services.tasks.syncActiveTasksOnce();
    assert.deepEqual(second.failedTaskIds, [task.id]);
    assert.equal((await setup.store.findTask(task.id))?.terminalReason, null);
  });

  it("fences broker authorization on the Task session identity",async()=>{
    const setup=await fixture();
    const task=await setup.create("broker identity");
    setup.botified.sessions.set(task.id,task.id);
    await setup.services.tasks.syncActiveTasksOnce();
    setup.botified.sessions.set(task.id,"another-task");
    await assert.rejects(()=>setup.services.tasks.authorizeBotifiedChatCompletion(task.id,task.runId,"service-key"),/session identity mismatch/i);
  });

  it("keeps failed and aborted cycles reusable for the next message",async()=>{
    for(const [name,data] of [["failed",{error:{code:"provider_failed"}}],["aborted",{error:{code:"aborted"}}]] as const){
      const setup=await fixture();
      const task=await setup.create(name);
      setup.botified.sessions.set(task.id,task.id);
      await setup.services.tasks.syncActiveTasksOnce();
      setup.botified.timelines.set(task.id,[{status:"ok",events:[event(task.id,1,"cycle.failed",data)],nextCursor:`evt_${token(task.id)}_1`,historyBoundary:"start"}]);
      setup.botified.runtimeStates.set(task.id,"idle");
      await setup.services.tasks.syncActiveTasksOnce();
      assert.equal((await setup.store.findTask(task.id))?.status,"queued");
      await setup.services.tasks.sendTaskMessage(setup.userId,task.id,`after ${name}`,`after-${name}`);
      assert.equal(setup.botified.posts.at(-1)?.input.text,`after ${name}`);
      assert.equal((await setup.store.sandboxRuns.get(task.runId))?.cleanupStatus,"active");
    }
  });

  it("projects Botified-accepted queue state and excludes permanent delivery failures",async()=>{
    const setup=await fixture();
    const task=await setup.create("queue projection");
    setup.botified.sessions.set(task.id,task.id);
    await setup.services.tasks.syncActiveTasksOnce();
    const initial=(await setup.store.listTaskMessages(task.id))[0]!;
    setup.botified.timelines.set(task.id,[{status:"ok",events:[event(task.id,1,"input.queued",{source:"user",input_id:initial.receipt?.messageId,text:initial.content})],nextCursor:`evt_${token(task.id)}_1`,historyBoundary:"start"}]);
    setup.botified.runtimeStates.set(task.id,"idle");
    await setup.services.tasks.syncActiveTasksOnce();
    assert.equal((await setup.services.tasks.getTaskDetail(setup.userId,task.id)).currentTurn.state,"queued");

    setup.botified.timelines.set(task.id,[{status:"ok",events:[event(task.id,2,"input.accepted",{source:"user",input_id:initial.receipt?.messageId,text:initial.content}),event(task.id,3,"cycle.completed")],nextCursor:`evt_${token(task.id)}_3`,historyBoundary:"start"}]);
    await setup.services.tasks.syncActiveTasksOnce();

    const failed=message(task.id,"message_failed","failed","2026-07-19T00:00:02.000Z");
    await setup.store.createTaskMessage({...failed,deliveryStatus:"failed",safeError:"permanent"});
    assert.equal((await setup.services.tasks.getTaskDetail(setup.userId,task.id)).currentTurn.state,"ready");
  });

  it("fails closed when the live Sandbox run record is missing",async()=>{
    const setup=await fixture();
    const task=await setup.create("released");
    setup.botified.sessions.set(task.id,task.id);
    await setup.services.tasks.syncActiveTasksOnce();
    await setup.store.jsonDocs.delete("sandbox_run_state",task.runId);
    const detail=await setup.services.tasks.getTaskDetail(setup.userId,task.id);
    assert.equal(detail.sandboxState.state,"failed");
    assert.equal(detail.currentTurn.state,"ready");
    assert.equal(detail.capabilities.sendMessage,false);
    assert.equal(detail.capabilities.releaseSandbox,false);
    assert.equal(detail.capabilities.archiveTask,false);
    assert.equal(detail.capabilities.deleteTask,false);
    assert.equal("cancelTask" in detail.capabilities,false);
    await assert.rejects(()=>setup.services.tasks.sendTaskMessage(setup.userId,task.id,"cannot start cold","cold"),/release is not complete/i);
    await assert.rejects(()=>setup.services.tasks.releaseTaskSandbox(setup.userId,task.id,"release-missing"),/ownership record is unavailable or mismatched/i);
    await assert.rejects(()=>setup.services.tasks.archiveTask(setup.userId,task.id,"archive-missing"),/release the task sandbox/i);
    await assert.rejects(()=>setup.services.tasks.deleteTask(setup.userId,task.id,"delete-missing"),/release the task sandbox/i);
    assert.equal((await setup.store.findTask(task.id))?.activeReservation,true);
  });

  it("releases only on an authorized idempotent request and holds reservation through deletion",async()=>{
    const setup=await fixture();const task=await setup.create("explicit release");setup.botified.sessions.set(task.id,task.id);await setup.services.tasks.syncActiveTasksOnce();
    const before=await setup.services.tasks.getTaskDetail(setup.userId,task.id);assert.equal(before.capabilities.releaseSandbox,true);
    await assert.rejects(()=>setup.services.tasks.releaseTaskSandbox("user_without_access",task.id,"unauthorized-release"),/access denied/i);

    const [requested,independentlyRetried]=await Promise.all([
      setup.services.tasks.releaseTaskSandbox(setup.userId,task.id,"release-key"),
      setup.services.tasks.releaseTaskSandbox(setup.userId,task.id,"release-other-key")
    ]);
    assert.equal(requested.sandboxState.state,"release_requested");assert.equal(requested.capabilities.releaseSandbox,false);
    assert.deepEqual(independentlyRetried,requested);
    const duplicate=await setup.services.tasks.releaseTaskSandbox(setup.userId,task.id,"release-key");assert.deepEqual(duplicate,requested);
    const requestedRun=await setup.store.sandboxRuns.get(task.runId);assert.equal(requestedRun?.cleanupStatus,"cleanup_requested");assert.equal((await setup.store.findTask(task.id))?.activeReservation,true);
    assert.deepEqual((await setup.store.listProjectAuditEvents(setup.projectId)).filter((event)=>event.action==="sandbox.release_requested").map((event)=>event.id),[`audit_sandbox_release_requested_${task.runId}`]);
    const deleting=await setup.store.sandboxRuns.claimForCleanup({runId:task.runId,expectedFencingToken:requestedRun!.fencingToken,claimedAt:"2026-07-19T00:20:00.000Z"});assert.equal(deleting?.cleanupStatus,"deleting");assert.equal((await setup.store.findTask(task.id))?.activeReservation,true);

    await setup.services.sandboxLifecycle.reapSandboxRunsOnce({runId:task.runId,apply:true});
    const released=await setup.services.tasks.getTaskDetail(setup.userId,task.id);assert.equal(released.sandboxState.state,"released");assert.equal(released.capabilities.releaseSandbox,false);assert.equal(released.capabilities.sendMessage,true);assert.equal(released.capabilities.openTerminal,true);assert.equal((await setup.store.findTask(task.id))?.activeReservation,false);
    assert.equal((await setup.store.listTaskMessages(task.id))[0]?.content,"explicit release");assert.ok((await setup.store.findTask(task.id))?.fileLibraryId);
    const audit=(await setup.store.listProjectAuditEvents(setup.projectId)).filter((event)=>event.action==="sandbox.release_requested"||event.action==="sandbox.released");assert.deepEqual(audit.map((event)=>event.action).sort(),["sandbox.release_requested","sandbox.released"]);

    const previousTask=await setup.store.findTask(task.id);assert.ok(previousTask);
    await setup.services.tasks.sendTaskMessage(setup.userId,task.id,"continue in this task","cold-restart-message");
    const restarted=await setup.store.findTask(task.id);assert.ok(restarted);assert.notEqual(restarted.runId,task.runId);assert.equal(restarted.id,task.id);assert.equal(restarted.fileLibraryId,previousTask.fileLibraryId);assert.equal(restarted.activeReservation,true);
    assert.equal((await setup.store.sandboxRuns.get(task.runId))?.cleanupStatus,"cleaned");assert.equal((await setup.store.sandboxRuns.get(restarted.runId))?.cleanupStatus,"active");assert.equal((await setup.store.sandboxRuns.get(restarted.runId))?.resumeUnfinished,false);
    assert.equal(setup.botified.posts.at(-1)?.input.text,"continue in this task");assert.equal(setup.botified.sessions.get(task.id),task.id);
  });

  it("retains ownership and denies delivery, Terminal, archive, and delete until cleanup is confirmed",async()=>{
    const setup=await fixture();const task=await setup.create("cleanup fencing");setup.botified.sessions.set(task.id,task.id);await setup.services.tasks.syncActiveTasksOnce();
    const run=await setup.store.sandboxRuns.get(task.runId);assert.ok(run);await setup.store.sandboxRuns.updateWithFencing(run.runId,run.fencingToken,{...run,phase:"stopping",cleanupStatus:"cleanup_requested",fencingToken:run.fencingToken+1,updatedAt:"2026-07-19T00:10:00.000Z"});
    const detail=await setup.services.tasks.getTaskDetail(setup.userId,task.id);assert.equal(detail.sandboxState.state,"release_requested");assert.equal(detail.capabilities.sendMessage,false);assert.equal(detail.capabilities.openTerminal,false);assert.equal(detail.capabilities.archiveTask,false);assert.equal(detail.capabilities.deleteTask,false);
    const [summary]=await setup.services.tasks.listTaskSummaries(setup.userId,setup.projectId);assert.equal(summary?.sandboxState.state,"release_requested");const listed=await setup.services.tasks.listTasks(setup.userId,setup.projectId,{});assert.equal(listed.items[0]?.sandboxState.state,"release_requested");
    await assert.rejects(()=>setup.services.tasks.sendTaskMessage(setup.userId,task.id,"blocked","blocked-message"),/release is not complete/i);await assert.rejects(()=>setup.services.tasks.openTaskTerminal(setup.userId,task.id),/release is not complete/i);await assert.rejects(()=>setup.services.tasks.authorizeBotifiedChatCompletion(task.id,task.runId,"service-key"),/not active/i);await assert.rejects(()=>setup.services.tasks.archiveTask(setup.userId,task.id,"blocked-archive"),/release the task sandbox/i);await assert.rejects(()=>setup.services.tasks.deleteTask(setup.userId,task.id,"blocked-delete"),/release the task sandbox/i);
    assert.equal((await setup.store.findTask(task.id))?.activeReservation,true);assert.equal((await setup.store.findProjectResourceUsage(setup.projectId))?.activeTasks,1);
    const cleaning=await setup.store.sandboxRuns.get(task.runId);assert.ok(cleaning);const releasedAt="2026-07-19T00:11:00.000Z",cleaned={...cleaning,phase:"cleaned" as const,cleanupStatus:"cleaned" as const,releaseReason:"cleanup" as const,fencingToken:cleaning.fencingToken+1,updatedAt:releasedAt};assert.equal(await setup.store.completeSandboxRunRelease({runId:cleaning.runId,expectedFencingToken:cleaning.fencingToken,run:cleaned,settlement:{runId:cleaning.runId,workspaceId:cleaning.workspaceId,projectId:cleaning.projectId,taskId:cleaning.taskId,fileLibraryId:cleaning.fileLibraryId,startedByUserId:cleaning.startedByUserId,startedAt:cleaning.startedAt,releasedAt,durationSeconds:cleaning.startedAt?Math.max(0,(Date.parse(releasedAt)-Date.parse(cleaning.startedAt))/1000):0,resources:cleaning.resourceSnapshot,releaseReason:"cleanup" as const},auditEvent:{id:`audit_sandbox_released_${cleaning.runId}`,projectId:cleaning.projectId,actorId:null,subjectUserId:cleaning.startedByUserId,action:"sandbox.released",status:"accepted",resourceKind:"sandbox",resourceId:cleaning.taskId,detail:{taskId:cleaning.taskId,runId:cleaning.runId,releaseReason:"cleanup" as const},createdAt:releasedAt}}),"applied");
    const released=await setup.services.tasks.getTaskDetail(setup.userId,task.id);assert.equal(released.sandboxState.state,"released");assert.equal(released.capabilities.deleteTask,true);assert.equal((await setup.store.findTask(task.id))?.activeReservation,false);assert.equal((await setup.store.findProjectResourceUsage(setup.projectId))?.activeTasks,0);
  });

  it("aborts only the current turn and accepts the next message without cleanup", async () => {
    const setup = await fixture();
    const task = await setup.create("abort me");
    setup.botified.sessions.set(task.id, task.id);
    await setup.services.tasks.syncActiveTasksOnce();
    await setup.services.tasks.abortTaskTurn(setup.userId, task.id, "abort-key");
    await setup.services.tasks.sendTaskMessage(setup.userId, task.id, "after abort", "after-abort-key");

    assert.equal(setup.botified.abortTaskIds[0], task.id);
    assert.equal(setup.botified.posts.at(-1)?.input.text, "after abort");
    assert.equal((await setup.store.findTask(task.id))?.terminalReason, null);
    assert.equal((await setup.store.sandboxRuns.get(task.runId))?.cleanupStatus, "active");
  });

  async function fixture() {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-phase3-session-"));
    roots.push(dataRoot);
    const store = createLocalInMemoryProductStore();
    const botified = new BotifiedClient();
    const port = new SandboxPort();
    const applicationInput = {
      store, dataRoot, botifiedClient:botified, botifiedServiceKeyFactory:()=>"service-key",
      builtinAdminPassword:"production-admin-password", sessionSecret:"production-session-secret-at-least-32-chars",
      providerClient:{ completeChat:async()=>{ throw new Error("not used"); }, validateEndpoint:async()=>({ status:"healthy" as const }) },
      taskDeliveryLeaseMs:0, taskRetryDelayMs:0,
      liveSandbox:{ port, readinessTimeoutMs:10, readinessPollMs:1, sleep:async()=>undefined }
    } as const;
    const services = createApplicationServices(applicationInput);
    const { user } = await services.auth.loginAfterBootstrap("production-admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name:"Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name:"Project" });
    const credential = await services.credentials.create(user.id, project.id, { name:"Provider", baseUrl:"https://models.example.test/v1", secret:"secret" });
    const endpoint = await services.endpoints.createEndpoint(user.id, project.id, { name:"Endpoint", protocol:"openai_chat_completions", baseUrl:"https://models.example.test/v1", model:"model", credentialId:credential.id, capabilities:["text","tool_calls"], requestTimeoutSecs:30 });
    return {
      services, store, botified, userId:user.id,projectId:project.id,restart:()=>createApplicationServices(applicationInput),
      create:(prompt:string)=>services.tasks.createTask(user.id, project.id, { endpointId:endpoint.id, prompt, fileLibrary:{ mode:"create_new", name:`${prompt} Library` } }, `create-${prompt}`)
    };
  }
});

class BotifiedClient implements BotifiedRuntimeHttpClient {
  sessions = new Map<string,string>();
  runtimeStates = new Map<string,string>();
  timelines = new Map<string,BotifiedTimelineReadResult[]>();
  posts: Array<{ taskId:string; input:BotifiedDeliveryMessageInput }> = [];
  receipts = new Map<string,BotifiedDeliveryReceipt>();
  abortTaskIds: string[] = [];
  throwAfterAccept = false;
  async health() { return { status:"ok" as const }; }
  taskId(baseUrl:string){for(const taskId of this.sessions.keys())if(baseUrl.includes(taskId.replaceAll("_","-")))return taskId;return taskIdFromUrl(baseUrl);}
  async readState(baseUrl:string):Promise<BotifiedRuntimeStateResult> { const taskId=this.taskId(baseUrl);const sessionId=this.sessions.get(taskId)??taskId;const state=this.runtimeStates.get(taskId)??"running";return { sessionId, state, snapshot:{ session_id:sessionId, state, active_items:state==="running"?[{ id:"cycle", type:"cycle", status:"running" }]:[] }, activeItems:[] }; }
  async postMessage() { return { accepted:true }; }
  async postMessageWithDelivery(baseUrl:string,_key:string,input:BotifiedDeliveryMessageInput) { const taskId=this.taskId(baseUrl);this.posts.push({taskId,input});const receipt={accepted:true,deliveryKey:input.deliveryKey,requestHash:input.requestHash,messageId:`remote-${input.deliveryKey}`} satisfies BotifiedDeliveryReceipt;this.receipts.set(input.deliveryKey,receipt);if(this.throwAfterAccept){this.throwAfterAccept=false;throw new Error("restart after acceptance");}return receipt; }
  async queryDeliveryReceipt(_base:string,_key:string,deliveryKey:string){return this.receipts.get(deliveryKey)??null;}
  async readTimeline(baseUrl:string){const taskId=this.taskId(baseUrl);return this.timelines.get(taskId)?.shift()??{status:"ok" as const,events:[]};}
  async uploadFile(_base:string,_key:string,_file:BotifiedUploadFileInput){return{files:[]};}
  async downloadFile(){return{bytes:new Uint8Array(),sizeBytes:0};}
  async abort(baseUrl:string){this.abortTaskIds.push(this.taskId(baseUrl));return{aborted:true};}
}

class SandboxPort implements SandboxKubernetesMutationPort, SandboxKubernetesReadinessPort {
  resources:KubernetesResource[]=[];
  async listManagedResources(){return structuredClone(this.resources);}
  async applyResource(resource:KubernetesResource){this.resources.push(structuredClone(resource));return"applied" as const;}
  async deleteResource(ref:KubernetesResourceRef){const index=this.resources.findIndex((resource)=>resource.kind===ref.kind&&resource.metadata.namespace===ref.namespace&&resource.metadata.name===ref.name);if(index<0)return"not_found" as const;this.resources.splice(index,1);return"deleted" as const;}
  async getPodReadiness():Promise<PodReadiness>{return"ready";}
}

function event(sessionId:string,seq:number,type:string,data:Record<string,unknown>={}){return{version:"botified.timeline.v1",seq,cursor:`evt_${token(sessionId)}_${seq}`,time:"2026-07-19T00:00:00.000Z",session_id:sessionId,type,trace:{cycle_id:`cycle-${seq}`},item:null,data};}
function message(taskId:string,id:string,content:string,createdAt:string){return{id,taskId,actorId:null,content,deliveryKey:`delivery_message_${id}`,requestHash:`hash-${id}`,claimToken:null,receipt:null,timelineCursor:null,deliveryStatus:"pending" as const,claimedAt:null,leaseExpiresAt:null,attemptCount:0,nextRetryAt:null,safeError:null,createdAt,updatedAt:createdAt,deletedAt:null};}
function token(value:string){return value.replace(/[^A-Za-z0-9]/g,"");}
function taskIdFromUrl(baseUrl:string){const match=/\/(task_[A-Za-z0-9_-]+)(?:\/|:|\.|$)/.exec(baseUrl);if(match?.[1])return match[1];const host=new URL(baseUrl).hostname;const task=host.match(/task-[a-z0-9-]+/i)?.[0]?.replace(/^task-/,"task_");if(task)return task;throw new Error(`Task ID missing from ${baseUrl}`);}
