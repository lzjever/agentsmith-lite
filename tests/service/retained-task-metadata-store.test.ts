import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import type { AgentTask } from "../../packages/contracts/src/api.js";

describe("retained chat, task, and artifact store metadata", () => {
  it("orders active threads by pin/activity and hides soft-deleted threads", async () => {
    const store = createLocalInMemoryProductStore();
    await store.createProjectChatThread(thread("chat_old", "2026-07-01T00:00:00.000Z"));
    await store.createProjectChatThread(thread("chat_new", "2026-07-02T00:00:00.000Z"));
    await store.updateProjectChatThreadMetadata("chat_old", { title: "Release notes", pinnedAt: "2026-07-03T00:00:00.000Z" }, "2026-07-03T00:00:00.000Z");

    assert.deepEqual((await store.searchProjectChatThreads("project_1", "release")).map((value) => value.id), ["chat_old"]);
    assert.deepEqual((await store.listProjectChatThreads("project_1")).map((value) => value.id), ["chat_old", "chat_new"]);
    await store.deleteProjectChatThread("chat_old", "2026-07-04T00:00:00.000Z");
    assert.deepEqual((await store.listProjectChatThreads("project_1")).map((value) => value.id), ["chat_new"]);
  });

  it("persists follow-ups and computes task summaries from task-owned activity", async () => {
    const store = createLocalInMemoryProductStore();
    await store.createTask(task("task_1", "2026-07-01T00:00:00.000Z"));
    await store.appendTaskEvents([{ id: "event_1", taskId: "task_1", kind: "assistant_message", cursor: "1", botifiedSeq: 1, botifiedType: "assistant", sessionId: "session", payload: {}, createdAt: "2026-07-01T00:00:01.000Z" }]);
    await store.appendTaskArtifacts([{ id: "artifact_1", taskId: "task_1", fileId: "file_1", name: "result.txt", bytes: 3, mediaType: "text/plain", previewText: "ok", createdAt: "2026-07-01T00:00:02.000Z" }]);
    await store.createTaskFollowUp({ id: "follow_1", taskId: "task_1", prompt: "continue", followUpTaskId: "task_2", createdAt: "2026-07-01T00:00:03.000Z" });

    assert.deepEqual(await store.findTaskSummary("task_1"), { taskId: "task_1", eventCount: 1, artifactCount: 1, updatedAt: "2026-07-01T00:00:00.000Z" });
    assert.deepEqual((await store.listTaskFollowUps("task_1")).map((value) => [value.prompt, value.followUpTaskId]), [["continue", "task_2"]]);
  });
});

function thread(id: string, timestamp: string) {
  return { id, projectId: "project_1", endpointId: "endpoint_1", title: null, pinnedAt: null, deletedAt: null, createdAt: timestamp, updatedAt: timestamp };
}

function task(id: string, timestamp: string): AgentTask {
  return { id, workspaceId: "workspace_1", projectId: "project_1", endpointId: "endpoint_1", prompt: "do work", status: "completed", runId: `run_${id}`, executionMode: "dry-run", sandbox: { namespace: "agentsmith", resources: [] }, createdAt: timestamp, updatedAt: timestamp };
}
