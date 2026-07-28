import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { apiClient, restoredTaskReleaseTargetDisposition, taskTerminalWebSocketUrlForApiBase } from "../../src/lib/api/client.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("task interaction API client", () => {
  it("retires a restored Release target after the canonical Task advances to a new Run",()=>{
    assert.equal(restoredTaskReleaseTargetDisposition("run_new","run_old"),"retire");
    assert.equal(restoredTaskReleaseTargetDisposition("run_old","run_old"),"replay");
  });

  it("parses retained and final typed Release receipts for the exact target",async()=>{
    const request={expectedRunId:"run_1"};
    globalThis.fetch=async()=>Response.json({
      outcome:"accepted_in_progress",keyDisposition:"retain",taskId:"task_1",runId:"run_1"
    },{status:202});
    assert.deepEqual(await apiClient.releaseTaskSandbox("task_1",request,"release-key"),{
      outcome:"accepted_in_progress",keyDisposition:"retain",taskId:"task_1",runId:"run_1"
    });

    globalThis.fetch=async()=>Response.json({
      outcome:"completed",keyDisposition:"retire",taskId:"task_1",runId:"run_1"
    },{status:200});
    assert.deepEqual(await apiClient.releaseTaskSandbox("task_1",request,"release-key"),{
      outcome:"completed",keyDisposition:"retire",taskId:"task_1",runId:"run_1"
    });
  });

  it("builds terminal sockets from both same-origin and absolute development API bases", () => {
    assert.equal(
      taskTerminalWebSocketUrlForApiBase("/app/api/v1", "task/1", "run/1", "https://agentsmith.localhost/app/tasks"),
      "wss://agentsmith.localhost/app/api/v1/tasks/task%2F1/terminal/ws?expectedRunId=run%2F1"
    );
    assert.equal(
      taskTerminalWebSocketUrlForApiBase("http://127.0.0.1:3001/api/v1", "task/1", "run/1", "http://127.0.0.1:3000/tasks"),
      "ws://127.0.0.1:3001/api/v1/tasks/task%2F1/terminal/ws?expectedRunId=run%2F1"
    );
  });

  it("uses the interaction, message, Abort, sandbox, and task routes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/me")) return Response.json({ user: { id: "user_1", email: "user@example.test" }, csrfToken: "csrf" });
      if(url.endsWith("/turn/abort"))return Response.json({taskId:"task/1",runId:"run_1",state:"aborting",queueLength:0});
      return Response.json({ outcome:"completed",keyDisposition:"retire",messageId: "message_1", disposition: "queued_for_active_run", duplicate: false, queuedMessage: null, interaction: null, presentation:taskPresentation() });
    };

    await apiClient.currentIdentity();
    await apiClient.getTaskInteractions("task/1", "before 1");
    const sent = await apiClient.sendTaskMessage("task/1", "Continue", "send-key");
    const edited = await apiClient.updateTaskMessage("task/1", "message/1", "Updated", "edit-key");
    const deleted = await apiClient.deleteTaskMessage("task/1", "message/1", "delete-key");
    const aborted=await apiClient.abortTaskTurn("task/1",{expectedRunId:"run_1"});
    await apiClient.releaseTaskSandbox("task/1",{expectedRunId:"run_1"},"release-key");
    await apiClient.editTask("task/1", "New title", "task-edit-key");
    await apiClient.archiveTask("task/1", "archive-key");

    assert.match(calls[1]!.url, /tasks\/task%2F1\/interactions\?cursor=before\+1$/);
    assert.deepEqual(calls.slice(2).map((call) => [call.init.method, new Headers(call.init.headers).get("idempotency-key")]), [["POST", "send-key"], ["PATCH", "edit-key"], ["DELETE", "delete-key"], ["POST", null], ["POST", "release-key"], ["PATCH", "task-edit-key"], ["POST", "archive-key"]]);
    assert.match(calls[6]!.url, /tasks\/task%2F1\/sandbox\/release$/);
    assert.equal(calls[6]!.init.body,JSON.stringify({expectedRunId:"run_1"}));
    assert.equal(calls[5]!.init.body,JSON.stringify({expectedRunId:"run_1"}));
    assert.match(calls[7]!.url, /tasks\/task%2F1$/);
    assert.match(calls[8]!.url, /tasks\/task%2F1\/archive$/);
    assert.equal(sent.outcome, "completed");
    assert.equal(sent.disposition, "queued_for_active_run");
    assert.equal(edited.messageId, "message_1");
    assert.equal(deleted.messageId, "message_1");
    assert.deepEqual(aborted,{taskId:"task/1",runId:"run_1",state:"aborting",queueLength:0});
  });

  it("passes the opaque cursor to the task interaction stream", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = async (input, init = {}) => {
      assert.match(String(input), /interactions\/stream\?cursor=cursor-1$/);
      assert.equal(new Headers(init.headers).get("last-event-id"), "cursor-1");
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode("event: done\n\n")); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    };
    const events: unknown[] = [];
    await apiClient.streamTaskInteractions("task_1", "cursor-1", new AbortController().signal, (event) => events.push(event));
    assert.deepEqual(events, [{ type: "done" }]);
  });

  it("parses independent authoritative transient state events", async () => {
    const encoder = new TextEncoder();
    const queuedMessages = [{ id: "message_1", content: "Queued", deliveryStatus: "pending", editable: true, deletable: true, updatedAt: "2026-07-13T00:00:00.000Z" }];
    const state = { queuedMessages, presentation:taskPresentation({abortTurn:false}) };
    const connection = { connectionState:"connected", runtimeReachability:"reachable", historyStatus:"complete", lastSyncedAt:"2026-07-13T00:00:01.000Z", message:null };
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify(state)}\n\nevent: connection\ndata: ${JSON.stringify(connection)}\n\n`));
      controller.close();
    } }));
    const events: unknown[] = [];
    await apiClient.streamTaskInteractions("task_1", undefined, new AbortController().signal, (event) => events.push(event));
    assert.deepEqual(events, [{ type:"state", ...state }, { type:"connection", ...connection }]);
  });

  it("parses preview availability independently from the interaction connection", async () => {
    const encoder = new TextEncoder();
    const previewStatus = { previewStatus:"unavailable", message:"Live assistant preview is unavailable. Final responses and conversation updates remain available." };
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(`event: preview_status\ndata: ${JSON.stringify(previewStatus)}\n\n`));
      controller.close();
    } }));
    const events: unknown[] = [];
    await apiClient.streamTaskInteractions("task_1", undefined, new AbortController().signal, (event) => events.push(event));
    assert.deepEqual(events, [{ type:"preview_status", ...previewStatus }]);
  });

  it("parses an explicit assistant preview clear event", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode("event: assistant_preview_clear\ndata: {\"interactionId\":\"preview_1\"}\n\n"));
      controller.close();
    } }));
    const events: unknown[] = [];
    await apiClient.streamTaskInteractions("task_1", undefined, new AbortController().signal, (event) => events.push(event));
    assert.deepEqual(events, [{ type:"assistant_preview_clear", interactionId:"preview_1" }]);
  });
});

function taskPresentation(capabilityOverrides:Record<string,boolean>={}){
  return{
    task:{id:"task_1",workspaceId:"workspace_1",projectId:"project_1",endpointId:"endpoint_1",fileLibraryId:"library_1",title:"Task",prompt:"Prompt",createdAt:"2026-07-13T00:00:00.000Z",updatedAt:"2026-07-13T00:00:00.000Z"},
    lifecycle:{state:"active"},currentTurn:{state:"running"},sandboxState:{state:"active",runId:"run_1",cause:null},
    capabilities:{sendMessage:true,editQueuedMessage:true,abortTurn:true,openTerminal:true,releaseSandbox:true,editTask:true,archiveTask:true,deleteTask:true,...capabilityOverrides}
  };
}
