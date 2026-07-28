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
  it("waits for canonical exact target Run before connecting after Terminal Start", () => {
    let intent = observe(
      createTerminalIntentState(),
      canonicalObservation({
        canonicalEpoch: 1,
        runId: "run_1",
        sandboxState: "released"
      })
    );
    const fence = {
      taskId: "task_1",
      startedAtCanonicalEpoch: 1,
      expectedRunId: "run_1",
      expectedSandboxState: "released" as const
    };
    intent = observe(intent, canonicalObservation({
      canonicalEpoch: 2,
      runId: "run_1",
      sandboxState: "released"
    }));
    intent = reduceExpectedTerminalAction(intent, {
      type: "start_target_recorded",
      fence,
      targetRunId: "run_2"
    });
    intent = observe(intent, canonicalObservation({
      canonicalEpoch: 3,
      runId: "run_2",
      sandboxState: "starting"
    }));
    assert.equal(intent.transportRequested, false);
    intent = observe(intent, canonicalObservation({
      canonicalEpoch: 4,
      runId: "run_2",
      sandboxState: "active"
    }));
    assert.equal(intent.transportRequested, true);

    let thirdRun = observe(createTerminalIntentState(), canonicalObservation({
      canonicalEpoch: 1,
      runId: "run_1",
      sandboxState: "released"
    }));
    thirdRun = reduceExpectedTerminalAction(thirdRun, {
      type: "start_target_recorded",
      fence,
      targetRunId: "run_2"
    });
    thirdRun = observe(thirdRun, canonicalObservation({
      canonicalEpoch: 2,
      runId: "run_3",
      sandboxState: "active"
    }));
    thirdRun = observe(thirdRun, canonicalObservation({
      canonicalEpoch: 3,
      runId: "run_2",
      sandboxState: "active"
    }));
    assert.equal(thirdRun.transportRequested, false);
  });

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
    let intent = observe(createTerminalIntentState(), canonicalObservation());
    intent = reduceTerminalIntent(intent, {
      type: "connect_requested",
      observation: canonicalObservation()
    });
    assert.equal(terminalTransportEnabled(terminalSurfaceState(presentation("active"), false), intent), true);
    assert.equal(terminalTransportEnabled(terminalSurfaceState(presentation("active", false), false), intent), false);
    assert.equal(terminalTransportEnabled(terminalSurfaceState(presentation("starting"), true), intent), false);
    assert.equal(terminalTransportEnabled(terminalSurfaceState(presentation("released"), false), intent), false);
    assert.equal(terminalTransportEnabled(terminalSurfaceState(presentation("failed"), false), intent), false);
  });

  it("terminates transport intent when canonical Terminal capability is removed", () => {
    let intent = observe(createTerminalIntentState(), canonicalObservation());
    intent = reduceTerminalIntent(intent, {
      type: "connect_requested",
      observation: canonicalObservation()
    });
    assert.equal(intent.transportRequested, true);

    intent = observe(intent, canonicalObservation({ canonicalEpoch: 2, openTerminal: false }));

    assert.equal(intent.transportRequested, false);
    assert.equal(
      terminalTransportEnabled(terminalSurfaceState(presentation("active", false), false), intent),
      false
    );
  });

  it("arms ordinary transport only from explicit Connect", () => {
    const initial = createTerminalIntentState();
    for (const type of [
      "terminal_selected",
      "history_restored",
      "task_refreshed",
      "view_left",
      "start_failed",
      "transport_terminated"
    ] as const) {
      const observed = observe(createTerminalIntentState(), canonicalObservation());
      const connected = reduceTerminalIntent(observed, {
        type: "connect_requested",
        observation: canonicalObservation()
      });
      const next = reduceTerminalIntent(connected, { type });
      assert.equal(next.transportRequested, false, type);
    }
    assert.equal(reduceTerminalIntent(initial, {
      type: "connect_requested",
      observation: canonicalObservation()
    }).transportRequested, true);
    assert.equal(
      reduceTerminalIntent(initial, { type: "start_progressed" }).transportRequested,
      false
    );
  });

  it("disarms transport on non-active, run change, and task change observations", () => {
    let epoch = 1;
    for (const sandboxState of [
      "starting",
      "release_requested",
      "released",
      "failed"
    ] as const) {
      let intent = observe(createTerminalIntentState(), canonicalObservation({ canonicalEpoch: epoch++ }));
      intent = reduceTerminalIntent(intent, {
        type: "connect_requested",
        observation: canonicalObservation({ canonicalEpoch: epoch - 1 })
      });
      const next = observe(intent, canonicalObservation({ canonicalEpoch: epoch++, sandboxState }));
      assert.equal(next.transportRequested, false, sandboxState);
    }

    let intent = observe(createTerminalIntentState(), canonicalObservation({ canonicalEpoch: epoch++ }));
    intent = reduceTerminalIntent(intent, {
      type: "connect_requested",
      observation: canonicalObservation({ canonicalEpoch: epoch - 1 })
    });
    intent = observe(intent, canonicalObservation({ canonicalEpoch: epoch++, runId: "run_2" }));
    assert.equal(intent.transportRequested, false);

    intent = reduceTerminalIntent(intent, {
      type: "connect_requested",
      observation: canonicalObservation({ canonicalEpoch: epoch - 1, runId: "run_2" })
    });
    intent = observe(intent, canonicalObservation({
      canonicalEpoch: 1,
      taskId: "task_2",
      runId: "run_3"
    }));
    assert.equal(intent.transportRequested, false);
  });

  it("does not let a late Run-A observation restore intent after Run-B", () => {
    let intent = observe(createTerminalIntentState(), canonicalObservation({ canonicalEpoch: 1 }));
    intent = reduceTerminalIntent(intent, {
      type: "connect_requested",
      observation: canonicalObservation({ canonicalEpoch: 1 })
    });
    intent = observe(intent, canonicalObservation({ canonicalEpoch: 3, runId: "run_2" }));
    assert.equal(intent.transportRequested, false);

    const afterRunB = intent;
    intent = observe(intent, canonicalObservation({ canonicalEpoch: 2, runId: "run_1" }));

    assert.strictEqual(intent, afterRunB);
    assert.equal(intent.transportRequested, false);
  });
});

function canonicalObservation(overrides: Partial<{
  taskId: string;
  canonicalEpoch: number;
  runId: string;
  sandboxState: TaskDetail["sandboxState"]["state"];
  openTerminal: boolean;
}> = {}) {
  return {
    taskId: "task_1",
    canonicalEpoch: overrides.canonicalEpoch ?? 1,
    runId: "run_1",
    sandboxState: "active" as const,
    openTerminal: true,
    ...overrides
  };
}

function reduceExpectedTerminalAction(
  state: ReturnType<typeof createTerminalIntentState>,
  action: unknown
) {
  return reduceTerminalIntent(state, action as Parameters<typeof reduceTerminalIntent>[1]);
}

function observe(
  state: ReturnType<typeof createTerminalIntentState>,
  observation: ReturnType<typeof canonicalObservation>
) {
  return reduceTerminalIntent(state, {
    type: "canonical_observed",
    observation
  });
}

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
    currentTurn:{state:state==="active"?"running":state==="starting"?"starting":"ready"},
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
      openTerminal,
      releaseSandbox: state === "active",
      editTask: true,
      archiveTask: true,
      deleteTask: true
    }
  };
}
