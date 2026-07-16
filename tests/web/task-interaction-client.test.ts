import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { apiClient } from "../../src/lib/api/client.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("task interaction API client", () => {
  it("uses the interaction, message, turn, work, and task routes with idempotency keys", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/me")) return Response.json({ user: { id: "user_1", email: "user@example.test" }, csrfToken: "csrf" });
      return Response.json({ messageId: "message_1", disposition: "queued_for_active_run", targetTaskId: "task_1", duplicate: false, queuedMessage: null, interaction: null, capabilities: { sendMessage: true, editQueuedMessage: true, abortTurn: true, cancelTask: true, openTerminal: true, deleteTask: true } });
    };

    await apiClient.currentIdentity();
    await apiClient.getTaskInteractions("task/1", "before 1");
    const sent = await apiClient.sendTaskMessage("task/1", "Continue", "send-key");
    const edited = await apiClient.updateTaskMessage("task/1", "message/1", "Updated", "edit-key");
    const deleted = await apiClient.deleteTaskMessage("task/1", "message/1", "delete-key");
    await apiClient.abortTaskTurn("task/1", "abort-key");
    await apiClient.stopTaskWork("task/1", "interaction/1", "stop-key");
    await apiClient.cancelTask("task/1", "cancel-key");

    assert.match(calls[1]!.url, /tasks\/task%2F1\/interactions\?cursor=before\+1$/);
    assert.deepEqual(calls.slice(2).map((call) => [call.init.method, new Headers(call.init.headers).get("idempotency-key")]), [["POST", "send-key"], ["PATCH", "edit-key"], ["DELETE", "delete-key"], ["POST", "abort-key"], ["POST", "stop-key"], ["POST", "cancel-key"]]);
    assert.match(calls[6]!.url, /tasks\/task%2F1\/work\/interaction%2F1\/stop$/);
    assert.equal(sent.disposition, "queued_for_active_run");
    assert.equal(edited.messageId, "message_1");
    assert.equal(deleted.messageId, "message_1");
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
    const capabilities = { sendMessage: true, editQueuedMessage: true, abortTurn: false, cancelTask: true, openTerminal: true, deleteTask: true };
    const state = { queuedMessages, capabilities };
    const runState = { runState:"running" };
    const connection = { connectionState:"connected", runtimeReachability:"reachable", historyStatus:"complete", lastSyncedAt:"2026-07-13T00:00:01.000Z", message:null };
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify(state)}\n\nevent: run_state\ndata: ${JSON.stringify(runState)}\n\nevent: connection\ndata: ${JSON.stringify(connection)}\n\n`));
      controller.close();
    } }));
    const events: unknown[] = [];
    await apiClient.streamTaskInteractions("task_1", undefined, new AbortController().signal, (event) => events.push(event));
    assert.deepEqual(events, [{ type:"state", ...state }, { type:"run_state", ...runState }, { type:"connection", ...connection }]);
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
