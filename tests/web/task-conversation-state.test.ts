import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  TaskCapabilities,
  TaskDetail,
  TaskInteractionItem,
  TaskInteractionSnapshot,
  TaskMessageReceipt,
  TaskQueuedMessage
} from "../../src/lib/api/client.js";
import {
  captureTaskCommandFence as captureFence,
  convergeRequiredTaskRefresh,
  createSingleFlightTaskRefresh,
  createSerialTaskRefreshTail,
  createTaskPresentationState,
  isNearHistoryTop,
  reduceTaskAssistantPreview,
  reduceTaskPresentationState,
  retainedHistoryScrollTop,
  taskMessageReceiptError,
  type TaskPresentationAction,
  type TaskPresentationState
} from "../../src/components/tasks/task-conversation-state.js";

const capabilities: TaskCapabilities = {
  sendMessage: true,
  editQueuedMessage: true,
  abortTurn: true,
  openTerminal: true,
  releaseSandbox: true,
  editTask: true,
  archiveTask: true,
  deleteTask: true
};

const presentation = (overrides: Partial<TaskCapabilities> = {}): TaskDetail => ({
  task: {
    id: "task_1",
    workspaceId: "workspace_1",
    projectId: "project_1",
    endpointId: "endpoint_1",
    fileLibraryId: "library_1",
    title: "Task",
    prompt: "Prompt",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z"
  },
  lifecycle: { state: "active" },
  currentTurn:{state:"running"},
  sandboxState: { state: "active", runId: "run_1", cause: null },
  capabilities: { ...capabilities, ...overrides }
});

const snapshot = (items: TaskInteractionItem[]): TaskInteractionSnapshot => ({
  items,
  nextPageCursor: null,
  hasMoreBefore: false,
  streamCursor: "cursor_1",
  historyStatus: "complete",
  queuedMessages: [],
  runtimeReachability: "reachable",
  lastSyncedAt: null,
  presentation: presentation()
});

const queued = (content: string, updatedAt: string): TaskQueuedMessage => ({
  id: "message_1",
  content,
  deliveryStatus: "pending",
  editable: true,
  deletable: true,
  updatedAt
});

const interaction = (
  id: string,
  revision: number,
  position: number,
  body: string
): Extract<TaskInteractionItem, { kind: "user_message" }> => ({
  id,
  revision,
  taskId: "task_1",
  kind: "user_message",
  title: "You",
  body,
  contentMode: "full",
  position,
  occurredAt: `2026-07-13T00:${String(position).padStart(2, "0")}:00.000Z`,
  updatedAt: "2026-07-13T00:00:00.000Z",
  status: "queued"
});

const assistantInteraction = (
  id: string,
  revision: number,
  position: number,
  body: string
): Extract<TaskInteractionItem, { kind: "assistant_message" }> => ({
  id,
  revision,
  taskId: "task_1",
  kind: "assistant_message",
  title: "Assistant",
  body,
  contentMode: "full",
  position,
  occurredAt: `2026-07-13T00:${String(position).padStart(2, "0")}:30.000Z`,
  updatedAt: "2026-07-13T00:00:00.000Z",
  status: "completed"
});

const preview = (body: string) => ({
  type: "assistant_preview" as const,
  interactionId: "assistant_1",
  body,
  occurredAt: "2026-07-13T00:02:00.000Z"
});

describe("task presentation reducer", () => {
  it("does not admit a later active state frame after Release is accepted", () => {
    const active = presentationFor("run_1", "active");
    let state = createTaskPresentationState({
      taskId: "task_1",
      snapshot: {
        ...snapshotWith(active),
        queuedMessages: [queued("newer queue", "2026-07-13T00:02:00.000Z")]
      }
    });
    const fence = commandFence(state, "run_1", "active");

    state = applyExpectedAction(state, {
      type: "canonical_mutation_accepted",
      taskId: "task_1",
      kind: "release",
      fence
    });
    state = applyExpectedAction(state, {
      type: "canonical_refresh_started",
      taskId: "task_1"
    });
    state = applyExpectedAction(state, {
      type: "stream_started",
      taskId: "task_1",
      streamGeneration: 1
    });
    state = applyExpectedAction(state, {
      type: "stream_state_received",
      taskId: "task_1",
      streamGeneration: 1,
      streamSequence: 1,
      runId: "run_1",
      queuedMessages: [],
      presentation: active
    });

    assert.equal(state.runFence.lifecycle, "release_requested");
    assert.equal(state.queuedMessages[0]?.content, "newer queue");
    assert.equal(stateRefreshRequired(state), true);
  });

  it("uses a current-fence full GET to rebuild Run-B over a missed active Run-A", () => {
    const activeA = presentationFor("run_1", "active");
    const activeB = presentationFor("run_2", "active");
    let state = createTaskPresentationState({
      taskId: "task_1",
      snapshot: snapshotWith(activeA)
    });
    const base = stateCanonicalEpoch(state);
    state = applyExpectedAction(state, {
      type: "canonical_read_started",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch: base
    });
    state = applyExpectedAction(state, {
      type: "canonical_snapshot_received",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch: base,
      snapshot: snapshotWith(activeB)
    });

    assert.equal(state.presentation?.sandboxState.runId, "run_2");
    assert.equal(state.runFence.lifecycle, "active");
    assert.equal(stateRetiredRunIds(state).has("run_1"), true);

    state = applyExpectedAction(state, {
      type: "stream_started",
      taskId: "task_1",
      streamGeneration: 1
    });
    state = applyExpectedAction(state, {
      type: "stream_state_received",
      taskId: "task_1",
      streamGeneration: 1,
      streamSequence: 1,
      runId: "run_1",
      queuedMessages: [],
      presentation: activeA
    });
    assert.equal(state.presentation?.sandboxState.runId, "run_2");
  });

  it("uses a current-generation reset to rebuild Run-B and reject late Run-A deltas", () => {
    const activeA = presentationFor("run_1", "active");
    const activeB = presentationFor("run_2", "active");
    let state = createTaskPresentationState({
      taskId: "task_1",
      snapshot: snapshotWith(activeA)
    });
    state = applyExpectedAction(state, {
      type: "stream_started",
      taskId: "task_1",
      streamGeneration: 1
    });
    state = applyExpectedAction(state, {
      type: "stream_snapshot_received",
      taskId: "task_1",
      streamGeneration: 1,
      streamSequence: 1,
      snapshot: snapshotWith(activeB)
    });

    assert.equal(state.presentation?.sandboxState.runId, "run_2");
    assert.equal(stateRetiredRunIds(state).has("run_1"), true);

    state = applyExpectedAction(state, {
      type: "stream_state_received",
      taskId: "task_1",
      streamGeneration: 1,
      streamSequence: 2,
      runId: "run_1",
      queuedMessages: [],
      presentation: activeA
    });
    assert.equal(state.presentation?.sandboxState.runId, "run_2");
  });

  it("retires Run-A after Run-B and permits a new Run only from released state", () => {
    const releasedA = presentationFor("run_1", "released");
    const startingB = presentationFor("run_2", "starting");
    let state = createTaskPresentationState({
      taskId: "task_1",
      snapshot: snapshotWith(releasedA)
    });
    state = applyExpectedAction(state, {
      type: "stream_started",
      taskId: "task_1",
      streamGeneration: 1
    });
    state = applyExpectedAction(state, {
      type: "stream_state_received",
      taskId: "task_1",
      streamGeneration: 1,
      streamSequence: 1,
      runId: "run_2",
      queuedMessages: [],
      presentation: startingB
    });
    state = applyExpectedAction(state, {
      type: "stream_state_received",
      taskId: "task_1",
      streamGeneration: 1,
      streamSequence: 2,
      runId: "run_1",
      queuedMessages: [],
      presentation: releasedA
    });

    assert.equal(state.presentation?.sandboxState.runId, "run_2");
    assert.equal(stateRetiredRunIds(state).has("run_1"), true);

    const activeA = createTaskPresentationState({
      taskId: "task_1",
      snapshot: snapshotWith(presentationFor("run_1", "active"))
    });
    const rejectedB = applyExpectedAction(
      applyExpectedAction(activeA, {
        type: "stream_started",
        taskId: "task_1",
        streamGeneration: 1
      }),
      {
        type: "stream_state_received",
        taskId: "task_1",
        streamGeneration: 1,
        streamSequence: 1,
        runId: "run_2",
        queuedMessages: [],
        presentation: startingB
      }
    );
    assert.equal(rejectedB.presentation?.sandboxState.runId, "run_1");
    assert.equal(stateRefreshRequired(rejectedB), true);

    let releasedNull = createTaskPresentationState({
      taskId: "task_1",
      snapshot: snapshotWith(presentationFor(null, "released"))
    });
    releasedNull = applyExpectedAction(releasedNull, {
      type: "canonical_read_started",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch: stateCanonicalEpoch(releasedNull)
    });
    releasedNull = applyExpectedAction(releasedNull, {
      type: "canonical_snapshot_received",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch: stateCanonicalEpoch(releasedNull),
      snapshot: snapshotWith(startingB)
    });
    assert.equal(releasedNull.presentation?.sandboxState.runId, "run_2");
  });

  it("fences full reads by latest read id and base canonical epoch", () => {
    const active = presentationFor("run_1", "active");
    const failed = presentationFor("run_1", "failed");
    const releaseRequested = presentationFor("run_1", "release_requested");
    let state = createTaskPresentationState({
      taskId: "task_1",
      snapshot: snapshotWith(active)
    });
    const base = stateCanonicalEpoch(state);
    state = applyExpectedAction(state, {
      type: "canonical_read_started",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch: base
    });
    state = applyExpectedAction(state, {
      type: "canonical_read_started",
      taskId: "task_1",
      readId: 2,
      baseCanonicalEpoch: base
    });
    state = applyExpectedAction(state, {
      type: "canonical_snapshot_received",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch: base,
      snapshot: snapshotWith(failed)
    });
    assert.equal(state.presentation?.sandboxState.state, "active");

    state = applyExpectedAction(state, {
      type: "canonical_snapshot_received",
      taskId: "task_1",
      readId: 2,
      baseCanonicalEpoch: base,
      snapshot: snapshotWith(failed)
    });
    assert.equal(state.presentation?.sandboxState.state, "failed");

    const stateEventBase = stateCanonicalEpoch(state);
    state = applyExpectedAction(state, {
      type: "canonical_read_started",
      taskId: "task_1",
      readId: 3,
      baseCanonicalEpoch: stateEventBase
    });
    state = applyExpectedAction(state, {
      type: "stream_started",
      taskId: "task_1",
      streamGeneration: 1
    });
    state = applyExpectedAction(state, {
      type: "stream_state_received",
      taskId: "task_1",
      streamGeneration: 1,
      streamSequence: 1,
      runId: "run_1",
      queuedMessages: [queued("newer state", "2026-07-13T00:05:00.000Z")],
      presentation: releaseRequested
    });
    state = applyExpectedAction(state, {
      type: "canonical_snapshot_received",
      taskId: "task_1",
      readId: 3,
      baseCanonicalEpoch: stateEventBase,
      snapshot: snapshotWith(failed)
    });

    assert.equal(state.presentation?.sandboxState.state, "release_requested");
    assert.equal(state.queuedMessages[0]?.content, "newer state");
  });

  it("invalidates an in-flight full read when a command is accepted", () => {
    const active = presentationFor("run_1", "active");
    let state = createTaskPresentationState({
      taskId: "task_1",
      snapshot: snapshotWith(active)
    });
    const fence = commandFence(state, "run_1", "active");
    const base = stateCanonicalEpoch(state);
    state = applyExpectedAction(state, {
      type: "canonical_read_started",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch: base
    });
    state = applyExpectedAction(state, {
      type: "canonical_mutation_accepted",
      taskId: "task_1",
      kind: "abort",
      fence
    });
    const accepted = state;
    state = applyExpectedAction(state, {
      type: "canonical_snapshot_received",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch: base,
      snapshot: snapshotWith(presentationFor("run_1", "failed"))
    });

    assert.strictEqual(state, accepted);
    assert.equal(state.presentation?.sandboxState.state, "active");
  });

  it("keeps refresh pending across failure or stale completion and clears it only on applied snapshot", () => {
    const active = presentationFor("run_1", "active");
    const createPending = () => {
      let pending = createTaskPresentationState({
        taskId: "task_1",
        snapshot: snapshotWith(active)
      });
      pending = applyExpectedAction(pending, {
        type: "canonical_mutation_accepted",
        taskId: "task_1",
        kind: "abort",
        fence: commandFence(pending, "run_1", "active")
      });
      return pending;
    };

    let failed = applyExpectedAction(createPending(), {
      type: "canonical_refresh_started",
      taskId: "task_1"
    });
    assert.equal(stateRefreshRequired(failed), true);
    assert.equal(stateRefreshInFlight(failed), true);
    failed = applyExpectedAction(failed, {
      type: "canonical_refresh_finished",
      taskId: "task_1"
    });
    assert.equal(stateRefreshRequired(failed), true);
    assert.equal(stateRefreshInFlight(failed), false);

    let stale = applyExpectedAction(createPending(), {
      type: "canonical_refresh_started",
      taskId: "task_1"
    });
    const staleBase = stateCanonicalEpoch(stale);
    stale = applyExpectedAction(stale, {
      type: "canonical_read_started",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch: staleBase
    });
    stale = applyExpectedAction(stale, {
      type: "stream_started",
      taskId: "task_1",
      streamGeneration: 1
    });
    stale = applyExpectedAction(stale, {
      type: "stream_state_received",
      taskId: "task_1",
      streamGeneration: 1,
      streamSequence: 1,
      runId: "run_1",
      queuedMessages: [],
      presentation: active
    });
    stale = applyExpectedAction(stale, {
      type: "canonical_snapshot_received",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch: staleBase,
      snapshot: snapshotWith(active)
    });
    stale = applyExpectedAction(stale, {
      type: "canonical_refresh_finished",
      taskId: "task_1"
    });
    assert.equal(stateRefreshRequired(stale), true);
    assert.equal(stateRefreshInFlight(stale), false);

    let applied = applyExpectedAction(createPending(), {
      type: "canonical_refresh_started",
      taskId: "task_1"
    });
    const appliedBase = stateCanonicalEpoch(applied);
    applied = applyExpectedAction(applied, {
      type: "canonical_read_started",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch: appliedBase
    });
    applied = applyExpectedAction(applied, {
      type: "canonical_snapshot_received",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch: appliedBase,
      snapshot: snapshotWith(active)
    });
    assert.equal(stateRefreshRequired(applied), false);
    assert.equal(stateRefreshInFlight(applied), false);
  });

  it("merges history interactions without invalidating an in-flight full read", () => {
    const active = presentationFor("run_1", "active");
    let state = createTaskPresentationState({
      taskId: "task_1",
      snapshot: snapshotWith(active)
    });
    const base = stateCanonicalEpoch(state);
    state = applyExpectedAction(state, {
      type: "canonical_read_started",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch: base
    });
    state = applyExpectedAction(state, {
      type: "history_prepend_received",
      taskId: "task_1",
      items: [interaction("history_1", 2, 1, "history")],
      nextPageCursor: null,
      hasMoreBefore: false
    });
    state = applyExpectedAction(state, {
      type: "canonical_snapshot_received",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch: base,
      snapshot: snapshotWith(active, [
        interaction("history_1", 1, 1, "stale history"),
        interaction("tail_1", 1, 2, "tail")
      ])
    });

    assert.equal(state.items.find((item) => item.id === "history_1")?.revision, 2);
    assert.equal(state.items.some((item) => item.id === "tail_1"), true);
  });

  it("accepts Release after intervening interaction and state events but never applies stale rejection payload", () => {
    const active = presentationFor("run_1", "active");
    let state = createTaskPresentationState({
      taskId: "task_1",
      snapshot: snapshotWith(active)
    });
    const fence = commandFence(state, "run_1", "active");
    state = applyExpectedAction(state, {
      type: "interaction_received",
      taskId: "task_1",
      item: interaction("during_command", 1, 1, "during command")
    });
    state = applyExpectedAction(
      applyExpectedAction(state, {
        type: "stream_started",
        taskId: "task_1",
        streamGeneration: 1
      }),
      {
        type: "stream_state_received",
        taskId: "task_1",
        streamGeneration: 1,
        streamSequence: 1,
        runId: "run_1",
        queuedMessages: [],
        presentation: active
      }
    );
    const beforeAcceptance = stateCanonicalEpoch(state);
    state = applyExpectedAction(state, {
      type: "canonical_mutation_accepted",
      taskId: "task_1",
      kind: "release",
      fence
    });
    assert.ok(stateCanonicalEpoch(state) > beforeAcceptance);
    assert.equal(stateRefreshRequired(state), true);

    const accepted = state;
    state = applyExpectedAction(state, {
      type: "canonical_mutation_rejected",
      taskId: "task_1",
      fence,
      presentation: presentationFor("run_1", "starting")
    });
    assert.strictEqual(state, accepted);

    state = applyExpectedAction(state, {
      type: "canonical_refresh_started",
      taskId: "task_1"
    });
    const refreshBase = stateCanonicalEpoch(state);
    state = applyExpectedAction(state, {
      type: "canonical_read_started",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch: refreshBase
    });
    state = applyExpectedAction(state, {
      type: "canonical_snapshot_received",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch: refreshBase,
      snapshot: snapshotWith(presentationFor("run_1", "released"))
    });
    assert.equal(state.presentation?.sandboxState.state, "released");
    assert.equal(state.items.some((item) => item.id === "during_command"), true);
  });

  it("serializes post-message canonical refreshes and keeps the newer result", async () => {
    const enqueue = createSerialTaskRefreshTail();
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let canonical = "";

    const first = enqueue(async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await firstGate.promise;
      canonical = "older";
      active -= 1;
    });
    const second = enqueue(async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await secondGate.promise;
      canonical = "newer";
      active -= 1;
    });

    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(active, 1);
    firstGate.resolve();
    await first;
    await Promise.resolve();
    assert.equal(calls, 2);
    assert.equal(active, 1);
    secondGate.resolve();
    await second;

    assert.equal(maxActive, 1);
    assert.equal(canonical, "newer");
  });

  it("continues the serial refresh tail after the first refresh rejects", async () => {
    const enqueue = createSerialTaskRefreshTail();
    const calls: string[] = [];
    const first = enqueue(async () => {
      calls.push("first");
      throw new Error("first failed");
    });
    const second = enqueue(async () => {
      calls.push("second");
    });

    await assert.rejects(first, /first failed/);
    await second;
    assert.deepEqual(calls, ["first", "second"]);
  });

  it("shares one required refresh flight and permits a later retry", async () => {
    const run = createSingleFlightTaskRefresh();
    const gate = deferred<void>();
    let calls = 0;
    let active = 0;
    let maxActive = 0;

    const first = run(async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate.promise;
      active -= 1;
      return false;
    });
    const duplicate = run(async () => {
      calls += 1;
      return true;
    });

    assert.strictEqual(duplicate, first);
    await Promise.resolve();
    assert.equal(calls, 1);
    gate.resolve();
    assert.equal(await first, false);

    assert.equal(await run(async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      return true;
    }), true);
    assert.equal(calls, 2);
    assert.equal(maxActive, 1);
  });

  it("starts a trailing flight when a new obligation appears before the shared flight settles", async () => {
    const runSingle = createSingleFlightTaskRefresh();
    const firstSnapshotApplied = deferred<void>();
    const firstSettle = deferred<void>();
    const delays: number[] = [];
    let pending = true;
    let calls = 0;
    let active = 0;
    let maxActive = 0;

    const refresh = () => runSingle(async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) {
        pending = false;
        firstSnapshotApplied.resolve();
        await firstSettle.promise;
      } else {
        pending = false;
      }
      active -= 1;
      return true;
    });
    const converge = () => convergeRequiredTaskRefresh(
      refresh,
      () => pending,
      async (delay) => {
        delays.push(delay);
      }
    );

    const first = converge();
    await firstSnapshotApplied.promise;
    pending = true;
    const second = converge();
    firstSettle.resolve();
    await Promise.all([first, second]);

    assert.equal(calls, 2);
    assert.equal(maxActive, 1);
    assert.ok(delays.length >= 1);
    assert.equal(delays.every((delay) => delay === 1_000), true);
  });

  it("initializes the complete presentation state from the Task detail snapshot", () => {
    const first = interaction("interaction_1", 2, 10, "First");
    const queuedMessage = queued("Continue after this turn", "2026-07-13T00:03:00.000Z");
    const initialPresentation = presentation({ abortTurn: false });
    const initialSnapshot: TaskInteractionSnapshot = {
      ...snapshot([first]),
      nextPageCursor: "history_cursor_1",
      hasMoreBefore: true,
      streamCursor: "stream_cursor_9",
      historyStatus: "gap",
      queuedMessages: [queuedMessage],
      runtimeReachability: "unreachable",
      lastSyncedAt: "2026-07-13T00:04:00.000Z",
      presentation: initialPresentation
    };

    const state = createTaskPresentationState({ snapshot: initialSnapshot });

    assert.equal(state.initialized, true);
    assert.deepEqual(state.items, [first]);
    assert.deepEqual(state.itemIndex.get(first.id), { index: 0, revision: 2 });
    assert.deepEqual(state.queuedMessages, [queuedMessage]);
    assert.strictEqual(state.presentation, initialPresentation);
    assert.equal(state.runtimeReachability, "unreachable");
    assert.equal(state.historyStatus, "gap");
    assert.equal(state.nextPageCursor, "history_cursor_1");
    assert.equal(state.hasMoreBefore, true);
    assert.equal(state.streamCursor, "stream_cursor_9");
    assert.equal(state.lastSyncedAt, "2026-07-13T00:04:00.000Z");
    assert.equal(state.followMode, "following");
    assert.equal(state.newActivityCount, 0);
    assert.equal(state.preview, null);
    assert.equal(state.pendingPreview, null);
  });

  it("preserves stale revisions and keeps ordinary interactions ordered with a rebuilt index", () => {
    const first = interaction("interaction_1", 2, 10, "First");
    const second = interaction("interaction_2", 4, 30, "Second");
    const initial = createTaskPresentationState({ items: [first, second], canonicalEpoch: 1 });

    const equal = reduceTaskPresentationState(initial, {
      type: "interaction_received",
      taskId: "task_1",
      item: { ...first, body: "Equal revision must not replace" }
    });
    assert.strictEqual(equal, initial);
    assert.strictEqual(equal.items, initial.items);

    const stale = reduceTaskPresentationState(initial, {
      type: "interaction_received",
      taskId: "task_1",
      item: { ...first, revision: 1, body: "Stale" }
    });
    assert.strictEqual(stale, initial);
    assert.strictEqual(stale.items, initial.items);

    const inserted = interaction("interaction_3", 1, 20, "Inserted");
    const afterInsert = reduceTaskPresentationState(initial, {
      type: "interaction_received",
      taskId: "task_1",
      item: inserted
    });
    assert.deepEqual(afterInsert.items.map((item) => item.id), [
      "interaction_1",
      "interaction_3",
      "interaction_2"
    ]);
    assert.strictEqual(afterInsert.items[0], first);
    assert.strictEqual(afterInsert.items[1], inserted);
    assert.strictEqual(afterInsert.items[2], second);
    assert.deepEqual(afterInsert.itemIndex.get("interaction_1"), { index: 0, revision: 2 });
    assert.deepEqual(afterInsert.itemIndex.get("interaction_3"), { index: 1, revision: 1 });
    assert.deepEqual(afterInsert.itemIndex.get("interaction_2"), { index: 2, revision: 4 });

    const replacement = { ...second, revision: 5, position: 5, body: "Revised second" };
    const afterReplace = reduceTaskPresentationState(afterInsert, {
      type: "interaction_received",
      taskId: "task_1",
      item: replacement
    });
    assert.deepEqual(afterReplace.items.map((item) => item.id), [
      "interaction_2",
      "interaction_1",
      "interaction_3"
    ]);
    assert.strictEqual(afterReplace.items[0], replacement);
    assert.strictEqual(afterReplace.items[1], first);
    assert.strictEqual(afterReplace.items[2], inserted);
    assert.deepEqual(afterReplace.itemIndex.get("interaction_2"), { index: 0, revision: 5 });
    assert.deepEqual(afterReplace.itemIndex.get("interaction_1"), { index: 1, revision: 2 });
    assert.deepEqual(afterReplace.itemIndex.get("interaction_3"), { index: 2, revision: 1 });
  });

  it("counts only durable tail appends while reading", () => {
    const settled = interaction("interaction_1", 2, 10, "Settled");
    let state = createTaskPresentationState({ items: [settled] });
    state = reduceTaskPresentationState(state, { type: "reading_started" });

    state = reduceTaskPresentationState(state, {
      type: "assistant_preview_received",
      preview: preview("Working")
    });
    state = reduceTaskPresentationState(state, { type: "assistant_preview_flushed" });
    assert.equal(state.followMode, "reading");
    assert.equal(state.newActivityCount, 0);

    const tail = interaction("interaction_2", 1, 20, "New tail");
    state = reduceTaskPresentationState(state, {
      type: "interaction_received",
      taskId: "task_1",
      item: tail
    });
    assert.equal(state.newActivityCount, 1);

    const equal = reduceTaskPresentationState(state, {
      type: "interaction_received",
      taskId: "task_1",
      item: { ...tail, body: "Equal revision" }
    });
    assert.strictEqual(equal, state);

    state = reduceTaskPresentationState(state, {
      type: "interaction_received",
      taskId: "task_1",
      item: { ...settled, revision: 3, body: "Revised settled row" }
    });
    assert.equal(state.newActivityCount, 1);
  });

  it("changes no conversation state before acceptance, then follows the accepted receipt", () => {
    const initial = createTaskPresentationState({
      items: [interaction("interaction_1", 1, 10, "First")],
      presentation: presentation()
    });
    const reading = reduceTaskPresentationState(initial, { type: "reading_started" });
    const active = reduceTaskPresentationState(reading, {
      type: "interaction_received",
      taskId: "task_1",
      item: interaction("interaction_2", 1, 20, "Second")
    });
    assert.equal(active.newActivityCount, 1);

    const jumped = reduceTaskPresentationState(active, { type: "jump_to_latest" });
    assert.equal(jumped.followMode, "following");
    assert.equal(jumped.newActivityCount, 0);

    const readingAgain = reduceTaskPresentationState(jumped, { type: "reading_started" });
    const activeAgain = reduceTaskPresentationState(readingAgain, {
      type: "interaction_received",
      taskId: "task_1",
      item: interaction("interaction_3", 1, 30, "Third")
    });
    const requested = activeAgain;
    assert.strictEqual(requested, activeAgain);
    const acceptedInteraction = interaction("interaction_accepted", 1, 40, "Accepted");
    const sent = reduceTaskPresentationState(requested, {
      type: "canonical_mutation_accepted",
      taskId: "task_1",
      kind: "message",
      fence: captureFence(requested),
      interaction: acceptedInteraction
    });
    assert.equal(sent.followMode, "following");
    assert.equal(sent.newActivityCount, 0);
    assert.strictEqual(sent.items.at(-1), acceptedInteraction);
  });

  it("keeps a rejection presentation out of canonical conversation state", () => {
    const initial = reduceTaskPresentationState(
      createTaskPresentationState({
        items: [interaction("interaction_1", 1, 10, "First")],
        presentation: presentation()
      }),
      { type: "reading_started" }
    );
    const rejectedPresentation = {
      ...presentation(),
      sandboxState: { state: "released", runId: "run_1", cause: null }
    } satisfies TaskDetail;
    const rejected = reduceTaskPresentationState(initial, {
      type: "canonical_mutation_rejected",
      taskId: "task_1",
      fence: captureFence(initial),
      presentation: rejectedPresentation
    });
    assert.equal(rejected.followMode, "reading");
    assert.equal(rejected.newActivityCount, 0);
    assert.strictEqual(rejected.items, initial.items);
    assert.strictEqual(rejected.presentation, initial.presentation);
  });

  it("treats a message receipt as admission without replacing authoritative queue or presentation state", () => {
    const dispatching={...queued("Continue","2026-07-13T00:02:00.000Z"),deliveryStatus:"dispatching" as const,editable:false};
    const activePresentation=presentation({abortTurn:false});
    const streamed=createTaskPresentationState({
      items:[interaction("interaction_existing",1,10,"Existing")],
      queuedMessages:[dispatching],
      presentation:activePresentation
    });
    const accepted=reduceTaskPresentationState(streamed,{
      type:"canonical_mutation_accepted",
      taskId:"task_1",
      kind:"message",
      fence:captureFence(streamed),
      interaction:null
    });

    assert.deepEqual(accepted.queuedMessages,[dispatching]);
    assert.strictEqual(accepted.presentation,activePresentation);
    assert.deepEqual(accepted.items,streamed.items);
  });

  it("applies authoritative snapshot state wholesale without replacing a newer interaction revision", () => {
    const earlier = interaction("interaction_earlier", 1, 5, "Already loaded earlier");
    const latestShared = interaction("interaction_shared", 3, 10, "Newest revision");
    const initial = createTaskPresentationState({
      items: [earlier, latestShared],
      queuedMessages: [queued("Previous queue", "2026-07-13T00:01:00.000Z")],
      presentation: presentation()
    });
    const authoritativeQueue = [queued("Authoritative queue", "2026-07-13T00:02:00.000Z")];
    const authoritativePresentation = presentation({ abortTurn: false });

    const baseCanonicalEpoch = initial.canonicalEpoch;
    const reading = reduceTaskPresentationState(initial, {
      type: "canonical_read_started",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch
    });
    const afterReset = reduceTaskPresentationState(reading, {
      type: "canonical_snapshot_received",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch,
      snapshot: {
        ...snapshot([
          interaction("interaction_shared", 2, 10, "Older snapshot revision"),
          interaction("interaction_tail", 1, 20, "Snapshot tail")
        ]),
        streamCursor: "cursor_authoritative",
        queuedMessages: authoritativeQueue,
        presentation: authoritativePresentation
      }
    });
    assert.deepEqual(afterReset.items.map((item) => item.id), [
      "interaction_earlier",
      "interaction_shared",
      "interaction_tail"
    ]);
    assert.strictEqual(afterReset.items[0], earlier);
    assert.strictEqual(afterReset.items[1], latestShared);
    assert.strictEqual(afterReset.queuedMessages, authoritativeQueue);
    assert.strictEqual(afterReset.presentation, authoritativePresentation);
    assert.equal(afterReset.streamCursor, "cursor_authoritative");

    const oldest = interaction("interaction_oldest", 1, 1, "Oldest");
    const afterPrepend = reduceTaskPresentationState(afterReset, {
      type: "history_prepend_received",
      taskId: "task_1",
      items: [
        oldest,
        interaction("interaction_shared", 1, 10, "Stale earlier revision")
      ]
    });
    assert.deepEqual(afterPrepend.items.map((item) => item.id), [
      "interaction_oldest",
      "interaction_earlier",
      "interaction_shared",
      "interaction_tail"
    ]);
    assert.strictEqual(afterPrepend.items[0], oldest);
    assert.strictEqual(afterPrepend.items[1], earlier);
    assert.strictEqual(afterPrepend.items[2], latestShared);
  });

  it("does not revive a queued preview after clear, final assistant, or reset", () => {
    let state = createTaskPresentationState({ taskId: "task_1", items: [] });

    state = reduceTaskPresentationState(state, {
      type: "assistant_preview_received",
      preview: preview("Queued frame")
    });
    assert.equal(state.preview, null);
    assert.equal(state.pendingPreview?.body, "Queued frame");

    state = reduceTaskPresentationState(state, {
      type: "assistant_preview_cleared",
      interactionId: "assistant_1"
    });
    state = reduceTaskPresentationState(state, { type: "assistant_preview_flushed" });
    assert.equal(state.preview, null);
    assert.equal(state.pendingPreview, null);

    state = reduceTaskPresentationState(state, {
      type: "assistant_preview_received",
      preview: preview("Visible frame")
    });
    state = reduceTaskPresentationState(state, { type: "assistant_preview_flushed" });
    assert.equal(state.preview?.body, "Visible frame");

    state = reduceTaskPresentationState(state, {
      type: "assistant_preview_received",
      preview: preview("Pending newer frame")
    });
    state = reduceTaskPresentationState(state, {
      type: "interaction_received",
      taskId: "task_1",
      item: assistantInteraction("assistant_1", 1, 20, "Final answer")
    });
    state = reduceTaskPresentationState(state, { type: "assistant_preview_flushed" });
    assert.equal(state.preview, null);
    assert.equal(state.pendingPreview, null);

    state = reduceTaskPresentationState(state, {
      type: "assistant_preview_received",
      preview: preview("Frame before reset")
    });
    const baseCanonicalEpoch = state.canonicalEpoch;
    state = reduceTaskPresentationState(state, {
      type: "canonical_read_started",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch
    });
    state = reduceTaskPresentationState(state, {
      type: "canonical_snapshot_received",
      taskId: "task_1",
      readId: 1,
      baseCanonicalEpoch,
      snapshot: snapshot([assistantInteraction("assistant_1", 2, 20, "Reset answer")])
    });
    state = reduceTaskPresentationState(state, { type: "assistant_preview_flushed" });
    assert.equal(state.preview, null);
    assert.equal(state.pendingPreview, null);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function applyExpectedAction(
  state: TaskPresentationState,
  action: unknown
): TaskPresentationState {
  return reduceTaskPresentationState(state, action as TaskPresentationAction);
}

function stateCanonicalEpoch(state: TaskPresentationState): number {
  return (state as TaskPresentationState & { canonicalEpoch: number }).canonicalEpoch;
}

function stateRetiredRunIds(state: TaskPresentationState): ReadonlySet<string> {
  return state.runFence.retiredRunIds;
}

function stateRefreshRequired(state: TaskPresentationState): boolean {
  return (state as TaskPresentationState & {
    canonicalRefreshRequired: boolean;
  }).canonicalRefreshRequired;
}

function stateRefreshInFlight(state: TaskPresentationState): boolean {
  return (state as TaskPresentationState & {
    canonicalRefreshInFlight: boolean;
  }).canonicalRefreshInFlight;
}

function commandFence(
  state: TaskPresentationState,
  expectedRunId: string | null,
  expectedSandboxState: TaskDetail["sandboxState"]["state"]
) {
  return {
    taskId: "task_1",
    startedAtCanonicalEpoch: stateCanonicalEpoch(state),
    expectedRunId,
    expectedSandboxState
  };
}

function presentationFor(
  runId: string | null,
  sandboxState: TaskDetail["sandboxState"]["state"]
): TaskDetail {
  return {
    ...presentation(),
    currentTurn: {
      state: sandboxState === "starting"
        ? "starting"
        : sandboxState === "active"
          ? "running"
          : "ready",
    },
    sandboxState: {
      state: sandboxState,
      runId,
      cause: sandboxState === "failed"
        ? { code: "runtime_unreachable", message: "Runtime unavailable" }
        : null
    },
    capabilities: {
      ...capabilities,
      openTerminal: sandboxState === "active",
      releaseSandbox: sandboxState !== "released"
    }
  };
}

function snapshotWith(
  taskPresentation: TaskDetail,
  items: TaskInteractionItem[] = []
): TaskInteractionSnapshot {
  return {
    ...snapshot(items),
    presentation: taskPresentation
  };
}

describe("existing task conversation helpers", () => {
  it("exposes only the receipt safe error", () => {
    const accepted: TaskMessageReceipt = {
      messageId: "message_1",
      disposition: "accepted_by_active_run",
      duplicate: false,
      queuedMessage: null,
      interaction: interaction("interaction_1", 2, 1, "Accepted"),
      presentation: presentation()
    };
    assert.equal(taskMessageReceiptError(accepted), null);
    const failed = {
      ...accepted,
      disposition: "failed",
      safeError: "Delivery is unavailable."
    } as TaskMessageReceipt & { safeError: string };
    assert.equal(taskMessageReceiptError(failed), "Delivery is unavailable.");
  });

  it("detects the history threshold and retains the visible anchor after prepending", () => {
    assert.equal(isNearHistoryTop(80), true);
    assert.equal(isNearHistoryTop(81), false);
    assert.equal(retainedHistoryScrollTop(24, 600, 980), 404);
  });

  it("clears only the matching preview on a typed clear, durable assistant message, or reset", () => {
    const currentPreview = preview("Working");
    const matchingClear = {
      type: "assistant_preview_clear" as const,
      interactionId: currentPreview.interactionId
    };
    const staleClear = {
      type: "assistant_preview_clear" as const,
      interactionId: "preview_older-request"
    };
    const assistant = {
      type: "interaction" as const,
      cursor: "cursor_2",
      item: assistantInteraction("assistant_message_9", 1, 2, "Final response")
    };
    const reset = {
      type: "reset" as const,
      snapshot: snapshot([])
    };

    assert.equal(reduceTaskAssistantPreview(currentPreview, matchingClear), null);
    assert.equal(reduceTaskAssistantPreview(currentPreview, staleClear), currentPreview);
    assert.equal(reduceTaskAssistantPreview(currentPreview, assistant), null);
    assert.equal(reduceTaskAssistantPreview(currentPreview, reset), null);
  });
});
