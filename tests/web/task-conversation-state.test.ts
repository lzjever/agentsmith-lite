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
  createTaskPresentationState,
  isNearHistoryTop,
  reduceTaskAssistantPreview,
  reduceTaskPresentationState,
  retainedHistoryScrollTop,
  taskMessageReceiptError
} from "../../src/components/tasks/task-conversation-state.js";

const capabilities: TaskCapabilities = {
  sendMessage: true,
  editQueuedMessage: true,
  abortTurn: true,
  stopWork: true,
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
  currentTurn: { state: "running" },
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
    const initial = createTaskPresentationState({ items: [first, second] });

    const equal = reduceTaskPresentationState(initial, {
      type: "interaction_received",
      item: { ...first, body: "Equal revision must not replace" }
    });
    assert.strictEqual(equal, initial);
    assert.strictEqual(equal.items, initial.items);

    const stale = reduceTaskPresentationState(initial, {
      type: "interaction_received",
      item: { ...first, revision: 1, body: "Stale" }
    });
    assert.strictEqual(stale, initial);
    assert.strictEqual(stale.items, initial.items);

    const inserted = interaction("interaction_3", 1, 20, "Inserted");
    const afterInsert = reduceTaskPresentationState(initial, {
      type: "interaction_received",
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
      item: tail
    });
    assert.equal(state.newActivityCount, 1);

    const equal = reduceTaskPresentationState(state, {
      type: "interaction_received",
      item: { ...tail, body: "Equal revision" }
    });
    assert.strictEqual(equal, state);

    state = reduceTaskPresentationState(state, {
      type: "interaction_received",
      item: { ...settled, revision: 3, body: "Revised settled row" }
    });
    assert.equal(state.newActivityCount, 1);
  });

  it("changes no conversation state before acceptance, then follows the accepted receipt", () => {
    const initial = createTaskPresentationState({
      items: [interaction("interaction_1", 1, 10, "First")]
    });
    const reading = reduceTaskPresentationState(initial, { type: "reading_started" });
    const active = reduceTaskPresentationState(reading, {
      type: "interaction_received",
      item: interaction("interaction_2", 1, 20, "Second")
    });
    assert.equal(active.newActivityCount, 1);

    const jumped = reduceTaskPresentationState(active, { type: "jump_to_latest" });
    assert.equal(jumped.followMode, "following");
    assert.equal(jumped.newActivityCount, 0);

    const readingAgain = reduceTaskPresentationState(jumped, { type: "reading_started" });
    const activeAgain = reduceTaskPresentationState(readingAgain, {
      type: "interaction_received",
      item: interaction("interaction_3", 1, 30, "Third")
    });
    const requested = reduceTaskPresentationState(activeAgain, { type: "message_send_requested" });
    assert.strictEqual(requested, activeAgain);
    const acceptedInteraction = interaction("interaction_accepted", 1, 40, "Accepted");
    const sent = reduceTaskPresentationState(requested, {
      type: "message_accepted",
      receipt: {
        messageId: "message_accepted",
        disposition: "accepted_by_active_run",
        duplicate: false,
        queuedMessage: null,
        interaction: acceptedInteraction,
        presentation: presentation()
      }
    });
    assert.equal(sent.followMode, "following");
    assert.equal(sent.newActivityCount, 0);
    assert.strictEqual(sent.items.at(-1), acceptedInteraction);
  });

  it("applies a canonical capacity rejection presentation without changing reading state", () => {
    const initial = reduceTaskPresentationState(
      createTaskPresentationState({ items: [interaction("interaction_1", 1, 10, "First")] }),
      { type: "reading_started" }
    );
    const rejectedPresentation = {
      ...presentation(),
      sandboxState: { state: "released", runId: "run_1", cause: null }
    } satisfies TaskDetail;
    const rejected = reduceTaskPresentationState(initial, {
      type: "message_rejected",
      presentation: rejectedPresentation
    });
    assert.equal(rejected.followMode, "reading");
    assert.equal(rejected.newActivityCount, 0);
    assert.strictEqual(rejected.items, initial.items);
    assert.strictEqual(rejected.presentation, rejectedPresentation);
  });

  it("treats a message receipt as admission without replacing authoritative queue or presentation state", () => {
    const dispatching={...queued("Continue","2026-07-13T00:02:00.000Z"),deliveryStatus:"dispatching" as const,editable:false};
    const activePresentation=presentation({abortTurn:false});
    const streamed=createTaskPresentationState({
      items:[interaction("interaction_existing",1,10,"Existing")],
      queuedMessages:[dispatching],
      presentation:activePresentation
    });
    const startingPresentation={
      ...presentation(),
      currentTurn:{state:"starting" as const},
      sandboxState:{state:"starting" as const,runId:"run_1",cause:null}
    };

    const accepted=reduceTaskPresentationState(streamed,{
      type:"message_accepted",
      receipt:{
        messageId:"message_1",
        disposition:"queued_for_active_run",
        duplicate:false,
        queuedMessage:queued("Continue","2026-07-13T00:01:00.000Z"),
        interaction:null,
        presentation:startingPresentation
      }
    });

    assert.deepEqual(accepted.queuedMessages,[dispatching]);
    assert.strictEqual(accepted.presentation,activePresentation);
    assert.deepEqual(accepted.items,streamed.items);
  });

  it("applies parent mutation presentations independently", () => {
    const initial = createTaskPresentationState({
      items: [],
      presentation: presentation()
    });
    const releasedPresentation: TaskDetail = {
      ...presentation({ abortTurn: false }),
      currentTurn: { state: "ready" },
      sandboxState: { state: "released", runId: "run_1", cause: null },
      capabilities: {
        ...capabilities,
        abortTurn: false,
        stopWork: false,
        openTerminal: true,
        releaseSandbox: false
      }
    };
    const afterRelease = reduceTaskPresentationState(initial, {
      type: "presentation_received",
      presentation: releasedPresentation
    });

    assert.strictEqual(afterRelease.presentation, releasedPresentation);
    assert.equal(afterRelease.presentation?.sandboxState.state, "released");
    assert.equal(afterRelease.presentation?.capabilities.releaseSandbox, false);
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

    const afterReset = reduceTaskPresentationState(initial, {
      type: "snapshot_reset",
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
      type: "earlier_prepend",
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
    let state = createTaskPresentationState({ items: [] });

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
      item: assistantInteraction("assistant_1", 1, 20, "Final answer")
    });
    state = reduceTaskPresentationState(state, { type: "assistant_preview_flushed" });
    assert.equal(state.preview, null);
    assert.equal(state.pendingPreview, null);

    state = reduceTaskPresentationState(state, {
      type: "assistant_preview_received",
      preview: preview("Frame before reset")
    });
    state = reduceTaskPresentationState(state, {
      type: "snapshot_reset",
      snapshot: snapshot([assistantInteraction("assistant_1", 2, 20, "Reset answer")])
    });
    state = reduceTaskPresentationState(state, { type: "assistant_preview_flushed" });
    assert.equal(state.preview, null);
    assert.equal(state.pendingPreview, null);
  });
});

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
