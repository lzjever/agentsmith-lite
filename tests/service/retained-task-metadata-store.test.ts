import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import type { PersistedAgentTask } from "../../packages/ports/src/store.js";

describe("retained chat, task, and artifact store metadata", () => {
  it("orders active threads by pin/activity and hides soft-deleted threads", async () => {
    const store = createLocalInMemoryProductStore();
    await store.createProjectChatThread(thread("chat_old", "2026-07-01T00:00:00.000Z"));
    await store.createProjectChatThread(thread("chat_new", "2026-07-02T00:00:00.000Z"));
    await store.updateProjectChatThreadMetadata("chat_old", { title: "Release notes", pinnedAt: "2026-07-03T00:00:00.000Z" }, "2026-07-03T00:00:00.000Z");

    assert.deepEqual((await store.searchProjectChatThreads("project_1", "user_1", "release")).map((value) => value.id), ["chat_old"]);
    assert.deepEqual((await store.listProjectChatThreads("project_1", "user_1")).map((value) => value.id), ["chat_old", "chat_new"]);
    await store.deleteProjectChatThread("chat_old", "2026-07-04T00:00:00.000Z");
    assert.deepEqual((await store.listProjectChatThreads("project_1", "user_1")).map((value) => value.id), ["chat_new"]);
  });

  it("persists queued messages and computes artifact-only task summaries", async () => {
    const store = createLocalInMemoryProductStore();
    const persisted=task("task_1","2026-07-01T00:00:00.000Z");
    await store.createFileLibrary({id:persisted.fileLibraryId!,workspaceId:persisted.workspaceId,projectId:persisted.projectId,name:"Library",rootSubPath:`libraries/${persisted.fileLibraryId}/home`,createdByUserId:"user_1",createdAt:persisted.createdAt,updatedAt:persisted.updatedAt});
    assert.equal((await store.createTaskAtomically({task:persisted,reserveActive:false})).kind,"created");
    await store.appendTaskArtifacts([{ id: "artifact_1", taskId: "task_1", fileId: "file_1", name: "result.txt", bytes: 3, mediaType: "text/plain", previewText: "ok", createdAt: "2026-07-01T00:00:02.000Z" }]);
    await store.createTaskMessage({ id: "message_1", taskId: "task_1", content: "continue", deliveryStatus:"pending", createdAt: "2026-07-01T00:00:03.000Z" });

    assert.deepEqual(await store.findTaskSummary("task_1"), { taskId: "task_1", artifactCount: 1, updatedAt: "2026-07-01T00:00:00.000Z" });
    assert.deepEqual((await store.listTaskMessages("task_1")).map((value) => [value.content,value.deliveryStatus]),[["continue","pending"]]);
  });
});

function thread(id: string, timestamp: string) {
  return { id, projectId: "project_1", ownerUserId: "user_1", endpointId: "endpoint_1", title: null, pinnedAt: null, deletedAt: null, createdAt: timestamp, updatedAt: timestamp };
}

function task(id: string, timestamp: string): PersistedAgentTask {
  return { id, workspaceId:"workspace_1",projectId:"project_1",endpointId:"endpoint_1",fileLibraryId:`library_${id}`,title:"Task",prompt:"do work",status:"completed",runId:`run_${id}`,executionMode:"dry-run",sandbox:{namespace:"agentsmith",resources:[]},terminalReason:"not_executed",cleanupStatus:"completed",createdAt:timestamp,updatedAt:timestamp };
}
