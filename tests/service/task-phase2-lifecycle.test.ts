import assert from "node:assert/strict";
import { mkdir,mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { projectTaskInteraction } from "../../packages/application/src/taskInteractionProjector.js";
import type { BotifiedTimelineEvent } from "../../packages/botified-runtime/src/projection.js";
import type { AgentTask, KubernetesResource, ProjectAuditEvent } from "../../packages/contracts/src/api.js";
import type { BotifiedDeliveryMessageInput, BotifiedDeliveryReceipt, BotifiedDownloadFileResult, BotifiedRuntimeHttpClient, BotifiedRuntimeStateResult, BotifiedTimelineReadResult, BotifiedUploadFileInput, BotifiedUploadFileResult } from "../../packages/ports/src/botified.js";
import type { TaskInteractionChangeInput } from "../../packages/ports/src/store.js";
import type { KubernetesResourceRef, PodReadiness, SandboxKubernetesMutationPort, SandboxKubernetesReadinessPort } from "../../packages/sandbox-controller/src/kubernetesPort.js";

describe("Phase 2 durable task lifecycle",()=>{
  const roots:string[]=[];
  afterEach(async()=>{await Promise.all(roots.splice(0).map((root)=>rm(root,{recursive:true,force:true})))});

  it("attributes provider calls to the creator and fences rotated credentials",async()=>{
    const setup=await fixture();
    const task=await startTask(setup,"attribution");
    assert.equal((await setup.services.tasks.authorizeBotifiedChatCompletion(task.id,task.runId,"service-key")).actorId,setup.userId);
    await setup.services.credentials.rotate(setup.userId,setup.projectId,setup.credentialId,{secret:"rotated"});
    await assert.rejects(()=>setup.services.tasks.authorizeBotifiedChatCompletion(task.id,task.runId,"service-key"),/Endpoint is unavailable/);
  });

  it("serializes concurrent timeline reads and recovers an expired boundary in order",async()=>{
    const setup=await fixture();
    const task=await startTask(setup,"serialized");
    setup.botified.delayMs=10;
    setup.botified.timeline.push({status:"ok",events:[event(1,"assistant_message.completed",{assistant_message_id:"answer",text:"serialized"},{id:"answer",type:"assistant_message",status:"completed"})],nextCursor:"evt_test_1",historyBoundary:"start"});
    const sync=setup.services.tasks.syncActiveTasksOnce();
    await new Promise<void>((resolve)=>setImmediate(resolve));
    const interactions=await setup.services.tasks.taskInteractions(setup.userId,task.id);
    await sync;
    assert.equal(interactions.items.some((item)=>item.kind==="assistant_message"&&item.body==="serialized"),true);
    assert.equal((await setup.store.readTaskInteractionSnapshot(task.id,null,10))?.sourceCursor,"evt_test_1");

    const recoverySetup=await fixture();
    recoverySetup.botified.timeline.push(
      {status:"ok",events:[{...event(3,"service.error",{code:"service_unavailable",message:"latest"}),trace:{cycle_id:"latest"}}],nextCursor:"evt_test_3",pageStartCursor:"evt_test_3",pageEndCursor:"evt_test_3",hasMoreBefore:true,historyBoundary:"expired"},
      {status:"ok",events:[{...event(2,"service.error",{code:"service_unavailable",message:"oldest"}),trace:{cycle_id:"oldest"}}],nextCursor:"evt_test_2",pageStartCursor:"evt_test_2",pageEndCursor:"evt_test_2",hasMoreBefore:false,historyBoundary:"expired"}
    );
    const recovered=await startTask(recoverySetup,"recovery");
    const snapshot=await recoverySetup.store.readTaskInteractionSnapshot(recovered.id,null,10);
    assert.equal(snapshot?.historyStatus,"gap");
    assert.deepEqual(snapshot?.items.filter((item)=>item.kind==="system_error").map((item)=>item.body),["oldest","latest"]);
  });

  it("recovers an accepted start receipt without reposting",async()=>{
    const setup=await fixture();
    setup.botified.throwAfterAcceptOnce=true;
    const input=taskInput("receipt-recovery");input.endpointId=setup.endpointId;
    const task=await setup.services.tasks.createTask(setup.userId,setup.projectId,input,"receipt-recovery");
    await setup.services.tasks.syncActiveTasksOnce();
    assert.equal((await setup.store.findTask(task.id))?.startIntentStatus,"dispatching");
    assert.equal(setup.botified.posts.length,1);
    await setup.services.tasks.syncActiveTasksOnce();
    const recovered=await setup.store.findTask(task.id);
    assert.equal(recovered?.startIntentStatus,"dispatched");
    assert.equal(recovered?.startReceipt?.accepted,true);
    assert.equal(recovered?.startTimelineCursor,null);
    assert.equal(setup.botified.posts.length,1);
  });

  it("projects a delayed lifecycle update older than the snapshot window through TaskService",async()=>{
    const setup=await fixture();
    const task=await startTask(setup,"delayed-projection");
    const firstEvent=event(1,"assistant_message.completed",{assistant_message_id:"assistant-old",text:"old"},{id:"assistant-old",type:"assistant_message",status:"completed"});
    const first=projectTaskInteraction({sourceKind:"botified",taskId:task.id,event:firstEvent},null,{knownSecrets:new Set()}).interaction!;
    const changes:TaskInteractionChangeInput[]=[{sourceKind:"botified",sourceId:"seed-old",sourceRevision:0,interaction:first}];
    for(let index=0;index<1001;index+=1)changes.push({sourceKind:"botified",sourceId:`filler-${index}`,sourceRevision:0,interaction:{...first,id:`filler-${index}`,position:first.position+index+1}});
    await setup.store.persistTaskInteractionMutation({taskId:task.id,changes});
    setup.botified.timeline.push({status:"ok",events:[event(2,"assistant_message.completed",{assistant_message_id:"assistant-old",text:"updated"},{id:"assistant-old",type:"assistant_message",status:"completed"})],nextCursor:"evt_test_2",historyBoundary:"start"});
    await setup.services.tasks.syncActiveTasksOnce();
    const updated=await setup.store.findLatestTaskInteractionChange(task.id,first.id);
    assert.equal(updated?.interaction.revision,2);
    assert.equal(updated?.interaction.body,"updated");
  });

  it("keeps terminal reason first-wins and releases active capacity once",async()=>{
    const setup=await fixture();
    const input=taskInput("terminal");input.endpointId=setup.endpointId;
    const task=await setup.services.tasks.createTask(setup.userId,setup.projectId,input,"terminal");
    const timestamp=new Date().toISOString();
    const audit=(id:string,action:ProjectAuditEvent["action"]):ProjectAuditEvent=>({id,projectId:setup.projectId,actorId:null,action,status:"accepted",resourceKind:"task",resourceId:task.id,createdAt:timestamp});
    await Promise.all([
      setup.store.finalizeTaskLifecycle({taskId:task.id,terminalReason:"completed",updatedAt:timestamp,auditEvent:audit("complete","task.completed")}),
      setup.store.finalizeTaskLifecycle({taskId:task.id,terminalReason:"failed",updatedAt:timestamp,auditEvent:audit("failed","task.failed")})
    ]);
    const winner=(await setup.store.findTask(task.id))!;
    await setup.store.finalizeTaskLifecycle({taskId:task.id,terminalReason:winner.terminalReason==="failed"?"completed":"failed",updatedAt:new Date(Date.parse(timestamp)+1).toISOString(),auditEvent:audit("late","task.failed")});
    assert.equal((await setup.store.findTask(task.id))?.terminalReason,winner.terminalReason);
    assert.equal((await setup.store.findProjectResourceUsage(setup.projectId))?.activeTasks,0);
  });

  it("attributes capacity rejection to the requester and generated Task ID",async()=>{
    const setup=await fixture();
    await setup.store.patchProjectResourcePolicy(setup.projectId,{activeTasksLimit:0},new Date().toISOString());
    const input=taskInput("capacity");input.endpointId=setup.endpointId;
    await assert.rejects(()=>setup.services.tasks.createTask(setup.userId,setup.projectId,input,"capacity-key"),/active tasks limit reached/i);
    const rejected=(await setup.store.listProjectAuditEvents(setup.projectId)).find((item)=>item.action==="task.create"&&item.status==="rejected");
    assert.equal(rejected?.actorId,setup.userId);
    assert.match(rejected?.resourceId??"",/^task_/);
    assert.doesNotMatch(rejected?.resourceId??"",/^library_/);
  });

  it("projects a late artifact from Library workspace without double accounting",async()=>{
    const setup=await fixture();
    setup.botified.timeline.push({status:"ok",events:[event(1,"cycle.started",{})],nextCursor:"evt_test_1",historyBoundary:"start"});
    setup.botified.downloads.set("late-file",new TextEncoder().encode("late"));
    const task=await startTask(setup,"late-artifact");
    const instructions=setup.port.resources.find((resource)=>resource.kind==="Secret"&&typeof (resource as {stringData?:Record<string,string>}).stringData?.["AGENTS.md"]==="string") as {stringData?:Record<string,string>}|undefined;
    assert.match(instructions?.stringData?.["AGENTS.md"]??"",new RegExp(`/workspace/task/home/workspace/\\.artifacts/${task.id}`));
    setup.botified.timeline.push({status:"ok",events:[event(2,"file.published",{file_id:"late-file",filename:"late.txt",size_bytes:4},{id:"late-file",type:"file",status:"available"}),event(3,"cycle.completed",{ok:true})],nextCursor:"evt_test_3",historyBoundary:"start"});
    setup.botified.states.push(runtimeState("idle"));
    await setup.services.tasks.syncActiveTasksOnce();
    const library=await setup.store.findFileLibrary(task.fileLibraryId);
    assert.ok(library);
    const artifact=(await setup.store.listTaskArtifacts(task.id))[0]!;
    assert.ok(artifact,JSON.stringify({task:await setup.store.findTask(task.id),cursors:setup.botified.cursors,remainingTimeline:setup.botified.timeline.length}));
    const stored=path.join(setup.dataRoot,setup.projectRootPath,library.rootSubPath,"workspace",".artifacts",task.id,`${artifact.id}-${artifact.name}`);
    assert.equal(await readFile(stored,"utf8"),"late");
    await (setup.services.tasks as unknown as {projectSandboxArtifactFiles(task:AgentTask):Promise<void>}).projectSandboxArtifactFiles(task);
    assert.equal((await setup.store.listTaskArtifacts(task.id)).length,1);
    assert.equal((await setup.services.tasks.listTaskArtifacts(setup.userId,task.id)).length,1);
    assert.equal(artifact.fileId,"late-file");
    assert.equal((await setup.store.findProjectResourceUsage(setup.projectId))?.projectFileBytes,4);
  });

  it("does not transfer deleted Task artifact ownership when its Library is reused",async()=>{
    const setup=await fixture();
    const first=await startTask(setup,"first-owner");
    const library=await setup.store.findFileLibrary(first.fileLibraryId);assert.ok(library);
    const artifactRoot=path.join(setup.dataRoot,setup.projectRootPath,library.rootSubPath,"workspace",".artifacts",first.id);
    await writeFile(path.join(artifactRoot,"prior.txt"),"prior task");
    await setup.services.tasks.cancelTask(setup.userId,first.id,"cancel-first");
    await setup.services.tasks.syncActiveTasksOnce();
    await setup.services.tasks.deleteTask(setup.userId,first.id,"delete-first");
    const input={endpointId:setup.endpointId,prompt:"reuse",fileLibrary:{mode:"use_existing" as const,id:library.id}};
    const second=await setup.services.tasks.createTask(setup.userId,setup.projectId,input,"reuse-library");
    const secondRoot=path.join(setup.dataRoot,setup.projectRootPath,library.rootSubPath,"workspace",".artifacts",second.id);
    await writeFile(path.join(secondRoot,"prior.txt"),"second task");
    await mkdir(path.join(secondRoot,"nested"),{recursive:true});
    await writeFile(path.join(secondRoot,"nested","result.txt"),"nested");
    await (setup.services.tasks as unknown as {projectSandboxArtifactFiles(task:AgentTask):Promise<void>}).projectSandboxArtifactFiles(second);
    assert.deepEqual((await setup.store.listTaskArtifacts(second.id)).map((artifact)=>[artifact.fileId,artifact.name]).sort(),[["sandbox-published:nested/result.txt","result.txt"],["sandbox-published:prior.txt","prior.txt"]]);
    assert.equal(await readFile(path.join(artifactRoot,"prior.txt"),"utf8"),"prior task");
  });

  it("replays the successful create snapshot after deletion and leaves an artifact-free Library deletable",async()=>{
    const setup=await fixture();
    const input=taskInput("delete-replay");input.endpointId=setup.endpointId;
    const created=await setup.services.tasks.createTask(setup.userId,setup.projectId,input,"create-delete-replay");
    const libraryId=created.fileLibraryId;
    await setup.services.tasks.syncActiveTasksOnce();
    await setup.services.tasks.cancelTask(setup.userId,created.id,"cancel-delete-replay");
    await setup.services.tasks.syncActiveTasksOnce();
    await setup.services.tasks.deleteTask(setup.userId,created.id,"delete-delete-replay");
    assert.equal((await setup.store.findTask(created.id))?.fileLibraryId,null);

    const replay=await setup.services.tasks.createTask(setup.userId,setup.projectId,input,"create-delete-replay");
    assert.deepEqual(replay,created);
    assert.equal(replay.fileLibraryId,libraryId);
    assert.deepEqual(await setup.services.fileLibraries.remove(setup.userId,setup.projectId,libraryId),{deleted:true});
  });

  it("cleans the live sandbox before deleting its Project",async()=>{
    const setup=await fixture();
    const task=await startTask(setup,"project-delete");
    await setup.services.tasks.cancelTask(setup.userId,task.id,"cancel-before-delete");
    assert.ok(setup.port.resources.length>0);
    await setup.services.deletion.deleteProject(setup.userId,setup.projectId);
    assert.equal(await setup.store.findProject(setup.projectId),null);
    assert.equal(await setup.store.sandboxRuns.get(task.runId),null);
    assert.equal(setup.port.resources.length,0);
  });

  async function fixture(){
    const dataRoot=await mkdtemp(path.join(tmpdir(),"asl-phase2-lifecycle-"));roots.push(dataRoot);
    const store=createLocalInMemoryProductStore(),botified=new BotifiedClient(),port=new SandboxPort();
    const services=createApplicationServices({store,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:"production-session-secret-at-least-32-chars",botifiedClient:botified,botifiedServiceKeyFactory:()=>"service-key",providerClient:{completeChat:async()=>{throw new Error("not used")},validateEndpoint:async()=>({status:"healthy" as const})},taskDeliveryLeaseMs:0,taskMaintenanceLeaseMs:0,taskRetryDelayMs:0,liveSandbox:{port,readinessTimeoutMs:10,readinessPollMs:1,sleep:async()=>undefined}});
    const {user}=await services.auth.loginAfterBootstrap("production-admin-password");
    const workspace=await services.workspaces.createWorkspace(user.id,{name:"Workspace"});
    const project=await services.workspaces.createProject(user.id,workspace.id,{name:"Project"});
    const credential=await services.credentials.create(user.id,project.id,{name:"Provider",baseUrl:"https://models.example.test/v1",secret:"secret"});
    const endpoint=await services.endpoints.createEndpoint(user.id,project.id,{name:"Endpoint",protocol:"openai_chat_completions",baseUrl:"https://models.example.test/v1",model:"model",credentialId:credential.id,capabilities:["text","tool_calls"],requestTimeoutSecs:30});
    return{services,store,botified,port,dataRoot,userId:user.id,projectId:project.id,projectRootPath:project.rootPath,credentialId:credential.id,endpointId:endpoint.id};
  }
  function taskInput(name:string){return{endpointId:"",prompt:name,fileLibrary:{mode:"create_new" as const,name:`${name} Library`}}}
  async function startTask(setup:Awaited<ReturnType<typeof fixture>>,name:string):Promise<AgentTask>{const input=taskInput(name);input.endpointId=setup.endpointId;const created=await setup.services.tasks.createTask(setup.userId,setup.projectId,input,`create-${name}`);await setup.services.tasks.syncActiveTasksOnce();return setup.services.tasks.getTask(setup.userId,created.id);}
});

class BotifiedClient implements BotifiedRuntimeHttpClient{
  timeline:Array<BotifiedTimelineReadResult|Error>=[];cursors:Array<string|undefined>=[];states:BotifiedRuntimeStateResult[]=[];downloads=new Map<string,Uint8Array>();posts:Array<BotifiedDeliveryMessageInput>=[];receipts=new Map<string,BotifiedDeliveryReceipt>();delayMs=0;cursor:string|undefined;throwAfterAcceptOnce=false;
  async health(){return{status:"ok" as const}} async readState(){return this.states.shift()??runtimeState("running")}
  async postMessage(){return{accepted:true,messageId:"message",cursor:"cursor"}}
  async postMessageWithDelivery(_base:string,_key:string,input:BotifiedDeliveryMessageInput):Promise<BotifiedDeliveryReceipt>{this.posts.push(input);const receipt={accepted:true,deliveryKey:input.deliveryKey,requestHash:input.requestHash,messageId:`message-${this.posts.length}`,cursor:`cursor-${this.posts.length}`} as const;this.receipts.set(input.deliveryKey,receipt);if(this.throwAfterAcceptOnce){this.throwAfterAcceptOnce=false;throw new Error("crash after remote acceptance")}return receipt}
  async queryDeliveryReceipt(_base:string,_key:string,deliveryKey:string){return this.receipts.get(deliveryKey)??null}
  async readTimeline(_base:string,_key:string,cursor?:string){if(this.delayMs)await new Promise((resolve)=>setTimeout(resolve,this.delayMs));this.cursors.push(cursor);const next=this.timeline.shift();if(next instanceof Error)throw next;const result=next??{status:"ok" as const,events:[],...(cursor?{nextCursor:cursor}:{})};if(result.nextCursor)this.cursor=result.nextCursor;return result}
  async downloadFile(_base:string,_key:string,id:string):Promise<BotifiedDownloadFileResult>{const bytes=this.downloads.get(id)??new Uint8Array();return{bytes,sizeBytes:bytes.length,filename:id}}
  async uploadFile(_base:string,_key:string,_file:BotifiedUploadFileInput):Promise<BotifiedUploadFileResult>{return{files:[]}}
  async abort(){return{aborted:true}} async stopBackgroundTask(_base:string,_key:string,id:string){return{taskId:id,state:"cancelling" as const}}
}
class SandboxPort implements SandboxKubernetesMutationPort,SandboxKubernetesReadinessPort{resources:KubernetesResource[]=[];async listManagedResources(){return structuredClone(this.resources)}async applyResource(resource:KubernetesResource){this.resources=this.resources.filter((item)=>item.kind!==resource.kind||item.metadata.name!==resource.metadata.name);this.resources.push(structuredClone(resource));return"applied" as const}async deleteResource(ref:KubernetesResourceRef){const count=this.resources.length;this.resources=this.resources.filter((item)=>item.kind!==ref.kind||item.metadata.name!==ref.name);return count===this.resources.length?"not_found" as const:"deleted" as const}async getPodReadiness():Promise<PodReadiness>{return"ready"}}
function runtimeState(state:string):BotifiedRuntimeStateResult{return{state,snapshot:{state,queue_length:0,tasks:{running:0,cancelling:0,pending_callbacks:0,pending_asks:0},active_items:[{id:"service",type:"service_status",status:state},{id:"queue",type:"queue_state",status:"ready"}]},activeItems:[]}}
function event(seq:number,type:string,data:Record<string,unknown>,item:null|{id:string;type:string;status:string}=null):BotifiedTimelineEvent{return{version:"botified.timeline.v1",seq,cursor:`evt_test_${seq}`,time:`2026-07-19T00:00:0${seq}.000Z`,session_id:"task",type,trace:{cycle_id:"cycle"},item,data}}
