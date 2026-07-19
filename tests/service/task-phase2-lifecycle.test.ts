import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
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
    assert.equal((await setup.services.tasks.authorizeBotifiedChatCompletion(task.id,task.runId,task.id)).actorId,setup.userId);
    await setup.services.credentials.rotate(setup.userId,setup.projectId,setup.credentialId,{secret:"rotated"});
    await assert.rejects(()=>setup.services.tasks.authorizeBotifiedChatCompletion(task.id,task.runId,task.id),/Endpoint is unavailable/);
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

  async function fixture(){
    const dataRoot=await mkdtemp(path.join(tmpdir(),"asl-phase2-lifecycle-"));roots.push(dataRoot);
    const store=createLocalInMemoryProductStore(),botified=new BotifiedClient(),port=new SandboxPort();
    const services=createApplicationServices({store,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:"production-session-secret-at-least-32-chars",botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,providerClient:{completeChat:async()=>{throw new Error("not used")},validateEndpoint:async()=>({status:"healthy" as const})},taskDeliveryLeaseMs:0,taskMaintenanceLeaseMs:0,taskRetryDelayMs:0,liveSandbox:{port,readinessTimeoutMs:10,readinessPollMs:1,sleep:async()=>undefined}});
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
  timeline:Array<BotifiedTimelineReadResult|Error>=[];cursors:Array<string|undefined>=[];states:BotifiedRuntimeStateResult[]=[];downloads=new Map<string,Uint8Array>();posts:Array<BotifiedDeliveryMessageInput>=[];receipts=new Map<string,BotifiedDeliveryReceipt>();delayMs=0;cursor:string|undefined;
  async health(){return{status:"ok" as const}} async readState(_base:string,key:string){const state=this.states.shift()??runtimeState("running");return{...state,sessionId:key,snapshot:{...(state.snapshot as Record<string,unknown>),session_id:key}}}
  async postMessage(){return{accepted:true,messageId:"message",cursor:"cursor"}}
  async postMessageWithDelivery(_base:string,_key:string,input:BotifiedDeliveryMessageInput):Promise<BotifiedDeliveryReceipt>{this.posts.push(input);const receipt={accepted:true,deliveryKey:input.deliveryKey,requestHash:input.requestHash,messageId:`message-${this.posts.length}`,cursor:`cursor-${this.posts.length}`} as const;this.receipts.set(input.deliveryKey,receipt);return receipt}
  async queryDeliveryReceipt(_base:string,_key:string,deliveryKey:string){return this.receipts.get(deliveryKey)??null}
  async readTimeline(_base:string,key:string,cursor?:string){if(this.delayMs)await new Promise((resolve)=>setTimeout(resolve,this.delayMs));this.cursors.push(cursor);const next=this.timeline.shift();if(next instanceof Error)throw next;const result=next??{status:"ok" as const,events:[],...(cursor?{nextCursor:cursor}:{})};if(result.nextCursor)this.cursor=result.nextCursor;if(result.status==="gap")return result;return{...result,events:result.events.map((item)=>({...item as Record<string,unknown>,session_id:key}))}}
  async downloadFile(_base:string,_key:string,id:string):Promise<BotifiedDownloadFileResult>{const bytes=this.downloads.get(id)??new Uint8Array();return{bytes,sizeBytes:bytes.length,filename:id}}
  async uploadFile(_base:string,_key:string,_file:BotifiedUploadFileInput):Promise<BotifiedUploadFileResult>{return{files:[]}}
  async abort(){return{aborted:true}} async stopBackgroundTask(_base:string,_key:string,id:string){return{taskId:id,state:"cancelling" as const}}
}
class SandboxPort implements SandboxKubernetesMutationPort,SandboxKubernetesReadinessPort{resources:KubernetesResource[]=[];async listManagedResources(){return structuredClone(this.resources)}async applyResource(resource:KubernetesResource){this.resources=this.resources.filter((item)=>item.kind!==resource.kind||item.metadata.name!==resource.metadata.name);this.resources.push(structuredClone(resource));return"applied" as const}async deleteResource(ref:KubernetesResourceRef){const count=this.resources.length;this.resources=this.resources.filter((item)=>item.kind!==ref.kind||item.metadata.name!==ref.name);return count===this.resources.length?"not_found" as const:"deleted" as const}async getPodReadiness():Promise<PodReadiness>{return"ready"}}
function runtimeState(state:string):BotifiedRuntimeStateResult{return{state,snapshot:{state,queue_length:0,tasks:{running:0,cancelling:0,pending_callbacks:0,pending_asks:0},active_items:[{id:"service",type:"service_status",status:state},{id:"queue",type:"queue_state",status:"ready"}]},activeItems:[]}}
function event(seq:number,type:string,data:Record<string,unknown>,item:null|{id:string;type:string;status:string}=null):BotifiedTimelineEvent{return{version:"botified.timeline.v1",seq,cursor:`evt_test_${seq}`,time:`2026-07-19T00:00:0${seq}.000Z`,session_id:"task",type,trace:{cycle_id:"cycle"},item,data}}
