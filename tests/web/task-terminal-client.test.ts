import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { TaskDetail } from "../../src/lib/api/client.js";
import { ApiError, apiClient, taskCommandOutcomeError, taskTerminalWebSocketUrlForApiBase } from "../../src/lib/api/client.js";

const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});

describe("task terminal API client",()=>{
  it("keeps the exact Run identity in every Terminal WebSocket reconnect URL",()=>{
    const first=taskTerminalWebSocketUrlForApiBase("/api/v1","task/a","run_a","https://agentsmith.test/tasks/task%2Fa");
    const reconnect=taskTerminalWebSocketUrlForApiBase("/api/v1","task/a","run_a","https://agentsmith.test/tasks/task%2Fa");
    assert.equal(first,"wss://agentsmith.test/api/v1/tasks/task%2Fa/terminal/ws?expectedRunId=run_a");
    assert.equal(reconnect,first);
  });

  it("returns typed Terminal rejection and completed failure outcomes",async()=>{
    const rejectedError=capacityEnvelope(presentation("released"));
    let calls=0;
    globalThis.fetch=apiFetch(()=>calls++===0
      ?Response.json({outcome:"rejected_before_acceptance",keyDisposition:"retire",error:rejectedError,code:rejectedError.code},{status:409})
      :Response.json({outcome:"completed",keyDisposition:"retire",runId:"run_1",error:startFailedEnvelope(presentation("failed"))},{status:502})
    );
    const request={expectedRunId:"run_0",expectedSandboxState:"released" as const};

    const rejected=await apiClient.startTaskTerminal("task_1",request,"terminal-key");
    assert.equal(rejected.outcome,"rejected_before_acceptance");
    const rejection=taskCommandOutcomeError(rejected);
    assert.ok(rejection instanceof ApiError);
    assert.equal(rejection.code,"project_sandbox_capacity_reached");
    const failed=await apiClient.startTaskTerminal("task_1",request,"terminal-key-2");
    assert.equal(failed.outcome,"completed");
    assert.ok("error" in failed);
  });

  it("accepts nullable Terminal failure presentation but rejects malformed presentation",async()=>{
    let calls=0;
    globalThis.fetch=apiFetch(()=>Response.json({
      outcome:"completed",keyDisposition:"retire",runId:"run_1",
      error:startFailedEnvelope(calls++===0?null:{invalid:true})
    },{status:502}));
    const request={expectedRunId:"run_0",expectedSandboxState:"released" as const};

    const nullable=await apiClient.startTaskTerminal("task_1",request,"terminal-null-presentation");
    const malformed=await apiClient.startTaskTerminal("task_1",request,"terminal-invalid-presentation");

    assert.equal(nullable.outcome,"completed");
    assert.equal(nullable.keyDisposition,"retire");
    assert.equal(malformed.outcome,"outcome_unknown");
    assert.equal(malformed.keyDisposition,"retain");
  });

  it("posts the exact target and parses 202 accepted and 200 completed receipts",async()=>{
    const requests:Request[]=[];
    let starts=0;
    globalThis.fetch=async(input,init)=>{
      const request=asRequest(input,init);
      requests.push(request);
      if(request.url.endsWith("/me"))return Response.json({user:{id:"user_1",email:"user@example.test"},csrfToken:"csrf"});
      starts+=1;
      return starts===1
        ?Response.json({outcome:"accepted_in_progress",keyDisposition:"retain",runId:"run_1"},{status:202})
        :Response.json({outcome:"completed",keyDisposition:"retire",runId:"run_1"},{status:200});
    };

    await apiClient.currentIdentity();
    const request={expectedRunId:"run_0",expectedSandboxState:"released" as const};
    const pending=await apiClient.startTaskTerminal("task_1",request,"terminal-key");
    const active=await apiClient.startTaskTerminal("task_1",request,"terminal-key");

    assert.equal(pending.outcome,"accepted_in_progress");
    assert.equal(active.outcome,"completed");
    assert.equal(requests[1]?.url,"http://localhost/api/v1/tasks/task_1/terminal/start");
    assert.equal(requests[1]?.headers.get("idempotency-key"),"terminal-key");
    assert.deepEqual(await requests[1]?.json(),request);
    assert.equal(requests[2]?.headers.get("idempotency-key"),"terminal-key");
  });
});

function apiFetch(response:()=>Response):typeof fetch{
  return async(input,init)=>{
    const request=asRequest(input,init);
    if(request.url.endsWith("/me"))return Response.json({user:{id:"user_1",email:"user@example.test"},csrfToken:"csrf"});
    return response();
  };
}

function asRequest(input:string|URL|Request,init?:RequestInit):Request{
  return new Request(new URL(typeof input==="string"?input:input instanceof URL?input:input.url,"http://localhost"),init);
}

function capacityEnvelope(canonical:TaskDetail){
  return{
    code:"project_sandbox_capacity_reached" as const,
    message:"Project Sandbox capacity reached",
    retryable:true as const,
    details:{activeSandboxes:2,sandboxLimit:2},
    presentation:canonical
  };
}

function startFailedEnvelope(canonical:TaskDetail|null|{invalid:true}){
  return{code:"sandbox_start_failed" as const,message:"Sandbox could not be started",retryable:true as const,details:null,presentation:canonical};
}

function presentation(state:"active"|"released"|"failed"):TaskDetail{
  return{
    task:{id:"task_1",workspaceId:"workspace_1",projectId:"project_1",endpointId:"endpoint_1",fileLibraryId:"library_1",title:"Task",prompt:"Prompt",createdAt:"2026-07-25T00:00:00.000Z",updatedAt:"2026-07-25T00:00:00.000Z"},
    lifecycle:{state:"active"},
    currentTurn:{state:state==="active"?"running":"ready",turnId:state==="active"?"turn_1":null},
    sandboxState:{state,runId:"run_1",cause:state==="failed"?{code:"startup_failed",message:"Startup failed"}:null},
    capabilities:{sendMessage:true,editQueuedMessage:false,abortTurn:false,stopWork:false,openTerminal:true,releaseSandbox:state==="active",editTask:true,archiveTask:true,deleteTask:true}
  };
}
