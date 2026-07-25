import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskTerminalStartReceipt } from "../../src/lib/api/client.js";
import { convergeTerminalStart } from "../../src/components/tasks/task-terminal-start.js";

describe("terminal start convergence", () => {
  it("keeps the same key through nine 202 receipts and converges on the tenth 200", async () => {
    const keys: string[] = [];
    const delays: number[] = [];
    const receipts: TaskTerminalStartReceipt[] = [];
    let attempt = 0;
    const active = await convergeTerminalStart({
      taskId: "task_1",
      idempotencyKey: "terminal-key",
      signal: new AbortController().signal,
      start: async (_taskId, key) => {
        keys.push(key);
        attempt += 1;
        return attempt < 10 ? pendingReceipt() : activeReceipt();
      },
      wait: async (delay) => { delays.push(delay); },
      onReceipt: (receipt) => { receipts.push(receipt); }
    });

    assert.equal(active.status, "active");
    assert.equal(keys.length, 10);
    assert.deepEqual(new Set(keys), new Set(["terminal-key"]));
    assert.equal(delays.length, 9);
    assert.ok(delays.every((delay) => delay <= 2_000));
    assert.equal(receipts.length, 10);
  });

  it("aborts without another poll after the Terminal view unmounts", async () => {
    const controller = new AbortController();
    let starts = 0;
    await assert.rejects(
      convergeTerminalStart({
        taskId: "task_1",
        idempotencyKey: "terminal-key",
        signal: controller.signal,
        start: async () => {
          starts += 1;
          return pendingReceipt();
        },
        wait: async () => { controller.abort(); },
        onReceipt: () => undefined
      }),
      (error: unknown) => error instanceof DOMException && error.name === "AbortError"
    );
    assert.equal(starts, 1);
  });
});

function pendingReceipt(): TaskTerminalStartReceipt {
  return {
    status: "in_progress",
    runId: "run_1",
    presentation: presentation("starting")
  };
}

function activeReceipt(): TaskTerminalStartReceipt {
  return {
    status: "active",
    runId: "run_1",
    presentation: presentation("active")
  };
}

function presentation(state: "starting" | "active"): TaskTerminalStartReceipt["presentation"] {
  return {
    task: {
      id: "task_1",
      workspaceId: "workspace_1",
      projectId: "project_1",
      endpointId: "endpoint_1",
      fileLibraryId: "library_1",
      title: "Task",
      prompt: "Prompt",
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z"
    },
    lifecycle: { state: "active" },
    currentTurn: { state: state === "active" ? "running" : "starting" },
    sandboxState: { state, runId: "run_1", cause: null },
    capabilities: {
      sendMessage: true,
      editQueuedMessage: false,
      abortTurn: false,
      stopWork: false,
      openTerminal: true,
      releaseSandbox: state === "active",
      editTask: true,
      archiveTask: true,
      deleteTask: true
    }
  };
}
