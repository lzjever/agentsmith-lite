import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { apiClient, type TaskTranscriptEntry } from "../../src/lib/api/client.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("task lifecycle API client", () => {
  it("uses server list query parameters and idempotency headers for task mutations", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/me")) return Response.json({ user: { id: "user_1", email: "user@example.test" }, csrfToken: "csrf" });
      if (url.includes("/projects/project_1/tasks?")) return Response.json({ items: [], total: 0, nextCursor: null });
      return Response.json({ id: "task_1", taskId: "task_1", followUpId: "follow_1", deleted: true });
    };

    await apiClient.currentIdentity();
    await apiClient.tasks("project_1", { search: "release", statuses: ["failed"], archived: "only", sort: "title", direction: "asc", cursor: "cursor-1", limit: 20 });
    await apiClient.updateTask("task_1", "Release notes", "edit-key");
    await apiClient.archiveTask("task_1", "archive-key");
    await apiClient.deleteTask("task_1", "delete-key");
    await apiClient.retryTask("task_1", "retry-key");
    await apiClient.duplicateTask("task_1", "duplicate-key");
    await apiClient.cancelTask("task_1", "cancel-key");
    await apiClient.followUpTask("task_1", "Continue", "follow-key");
    await apiClient.updateTaskFollowUp("task_1", "follow_1", "Updated", "follow-edit-key");
    await apiClient.deleteTaskFollowUp("task_1", "follow_1", "follow-delete-key");

    const query = new URL(calls[1]!.url, "https://app.test").searchParams;
    assert.deepEqual(Object.fromEntries(query), { search: "release", status: "failed", archived: "only", sort: "title", direction: "asc", cursor: "cursor-1", limit: "20" });
    assert.deepEqual(calls.slice(2).map((call) => [call.init.method, new Headers(call.init.headers).get("idempotency-key")]), [
      ["PATCH", "edit-key"], ["POST", "archive-key"], ["DELETE", "delete-key"], ["POST", "retry-key"], ["POST", "duplicate-key"], ["POST", "cancel-key"], ["POST", "follow-key"], ["PATCH", "follow-edit-key"], ["DELETE", "follow-delete-key"]
    ]);
  });

  it("parses authorized transcript and cursor SSE frames", async () => {
    const encoder = new TextEncoder();
    const entry: TaskTranscriptEntry = { id: "entry_1", taskId: "task_1", role: "assistant", text: "Finished", cursor: "cursor-1", eventKind: "assistant_message", createdAt: "2026-07-12T00:00:00.000Z" };
    globalThis.fetch = async (_input, init = {}) => {
      assert.equal(new Headers(init.headers).get("accept"), "text/event-stream");
      assert.equal(init.credentials, "same-origin");
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(`event: transcript\r\ndata: ${JSON.stringify(entry)}\r\n\r\nevent: cursor\r\ndata: {"nextCursor":"cursor-1"}\r\n\r\n`)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    };
    const entries: TaskTranscriptEntry[] = [];
    const cursors: Array<string | null> = [];
    await apiClient.streamTaskTranscript("task_1", undefined, new AbortController().signal, (value) => entries.push(value), (value) => cursors.push(value));
    assert.deepEqual(entries, [entry]);
    assert.deepEqual(cursors, ["cursor-1"]);
  });
});
