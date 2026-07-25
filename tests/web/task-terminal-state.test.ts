import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskDetail } from "../../src/lib/api/client.js";
import {
  createTerminalIntentState,
  reduceTerminalIntent,
  terminalSurfaceState,
  terminalTransportEnabled
} from "../../src/components/tasks/task-terminal-state.js";

describe("task terminal surface state", () => {
  it("keeps Terminal selectable while making unavailable, start, and cleanup states explicit", () => {
    assert.equal(terminalSurfaceState(presentation("released", false), false).kind, "unavailable");
    assert.equal(terminalSurfaceState(presentation("released"), false).kind, "start");
    assert.equal(terminalSurfaceState(presentation("starting"), false).kind, "starting");
    assert.equal(terminalSurfaceState(presentation("active"), true).kind, "starting");
    assert.equal(terminalSurfaceState(presentation("failed", false), false).kind, "unavailable");
    assert.equal(terminalSurfaceState(presentation("release_requested", false), false).kind, "unavailable");
    assert.equal(terminalSurfaceState(presentation("failed"), false).kind, "cleanup_pending");
    assert.equal(terminalSurfaceState(presentation("release_requested"), false).kind, "cleanup_pending");
  });

  it("mounts transport only for a canonical active presentation", () => {
    assert.equal(terminalTransportEnabled(terminalSurfaceState(presentation("active"), false)), true);
    assert.equal(terminalTransportEnabled(terminalSurfaceState(presentation("active"), false), false), false);
    assert.equal(terminalTransportEnabled(terminalSurfaceState(presentation("starting"), true)), false);
    assert.equal(terminalTransportEnabled(terminalSurfaceState(presentation("released"), false)), false);
    assert.equal(terminalTransportEnabled(terminalSurfaceState(presentation("failed"), false)), false);
  });

  it("arms transport only from explicit Connect or a final active Start receipt", () => {
    const initial = createTerminalIntentState();
    for (const type of ["terminal_selected", "history_restored", "task_refreshed"] as const) {
      const next = reduceTerminalIntent({ transportRequested: true }, { type });
      assert.equal(next.transportRequested, false, type);
    }
    assert.equal(
      reduceTerminalIntent(initial, { type: "connect_requested" }).transportRequested,
      true
    );
    assert.equal(
      reduceTerminalIntent(initial, { type: "start_progressed" }).transportRequested,
      false
    );
    assert.equal(
      reduceTerminalIntent(initial, {
        type: "start_completed",
        receiptStatus: "active",
        sandboxState: "active"
      }).transportRequested,
      true
    );
    assert.equal(
      reduceTerminalIntent(initial, {
        type: "start_completed",
        receiptStatus: "in_progress",
        sandboxState: "starting"
      }).transportRequested,
      false
    );
  });
});

function presentation(
  state: "starting" | "active" | "release_requested" | "released" | "failed",
  openTerminal = true
): TaskDetail {
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
    currentTurn: { state: state === "active" ? "running" : state === "starting" ? "starting" : "ready" },
    sandboxState: {
      state,
      runId: "run_1",
      cause: state === "failed" || state === "release_requested"
        ? { code: "cleanup_failed", message: "Cleanup is pending" }
        : null
    },
    capabilities: {
      sendMessage: true,
      editQueuedMessage: false,
      abortTurn: false,
      stopWork: false,
      openTerminal,
      releaseSandbox: state === "active",
      editTask: true,
      archiveTask: true,
      deleteTask: true
    }
  };
}
