import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { submitTerminalStart } from "../../src/components/tasks/task-terminal-start.js";

describe("terminal start submission", () => {
  it("records one accepted target without polling the mutation route",async()=>{
    const calls:Array<{request:unknown;key:string}>=[];
    const request={expectedRunId:"run_1",expectedSandboxState:"released" as const};
    const accepted=await submitTerminalStart({
      taskId:"task_1",
      request,
      idempotencyKey:"terminal-key",
      signal:new AbortController().signal,
      start:async(_taskId,nextRequest,key)=>{
        calls.push({request:nextRequest,key});
        return{outcome:"accepted_in_progress",keyDisposition:"retain",runId:"run_2"};
      }
    });

    assert.deepEqual(accepted,{outcome:"accepted_in_progress",keyDisposition:"retain",runId:"run_2"});
    assert.deepEqual(calls,[{request,key:"terminal-key"}]);
  });

  it("does not submit after the Terminal view is disposed",async()=>{
    const controller=new AbortController();
    controller.abort();
    let starts=0;
    await assert.rejects(
      submitTerminalStart({
        taskId:"task_1",
        request:{expectedRunId:null,expectedSandboxState:"released"},
        idempotencyKey:"terminal-key",
        signal:controller.signal,
        start:async()=>{
          starts+=1;
          return{outcome:"accepted_in_progress",keyDisposition:"retain",runId:"run_1"};
        }
      }),
      (error:unknown)=>error instanceof DOMException&&error.name==="AbortError"
    );
    assert.equal(starts,0);
  });
});
