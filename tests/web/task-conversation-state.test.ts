import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskCapabilities, TaskInteractionItem, TaskMessageReceipt, TaskQueuedMessage } from "../../src/lib/api/client.js";
import { applyTaskMessageReceipt, isNearHistoryTop, reduceTaskAssistantPreview, retainedHistoryScrollTop, taskMessageReceiptError } from "../../src/components/tasks/task-conversation-state.js";

const capabilities: TaskCapabilities = { sendMessage: true, editQueuedMessage: true, abortTurn: true, cancelTask: true, openTerminal: true, editTask:true, archiveTask:true, deleteTask: true };
const queued = (content: string, updatedAt: string): TaskQueuedMessage => ({ id: "message_1", content, deliveryStatus: "pending", editable: true, deletable: true, updatedAt });
const interaction = (revision: number, body: string): Extract<TaskInteractionItem, { kind: "user_message" }> => ({ id: "interaction_1", revision, taskId: "task_1", kind: "user_message", title: "You", body, contentMode: "full", position: 1, occurredAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z", status: "queued" });

describe("task conversation state", () => {
  it("applies receipts without allowing an older receipt to replace newer live state", () => {
    const liveCapabilities = { ...capabilities, abortTurn: false };
    const receipt: TaskMessageReceipt = { messageId: "message_1", disposition: "queued_for_active_run", duplicate: false, queuedMessage: queued("Receipt content", "2026-07-13T00:01:00.000Z"), interaction: interaction(2, "Receipt interaction"), capabilities };
    const result = applyTaskMessageReceipt({ items: [interaction(3, "Live interaction")], queuedMessages: [queued("Live content", "2026-07-13T00:02:00.000Z")], capabilities: liveCapabilities }, receipt, false);
    assert.equal(result.items[0]?.revision, 3);
    assert.equal(result.queuedMessages[0]?.content, "Live content");
    assert.equal(result.capabilities.abortTurn, false);
  });

  it("removes a settled queue entry and exposes only the receipt safe error", () => {
    const accepted: TaskMessageReceipt = { messageId: "message_1", disposition: "accepted_by_active_run", duplicate: false, queuedMessage: null, interaction: interaction(2, "Accepted"), capabilities };
    assert.deepEqual(applyTaskMessageReceipt({ items: [], queuedMessages: [queued("Queued", "2026-07-13T00:01:00.000Z")], capabilities }, accepted).queuedMessages, []);
    const failed = { ...accepted, disposition: "failed", safeError: "Delivery is unavailable." } as TaskMessageReceipt & { safeError: string };
    assert.equal(taskMessageReceiptError(failed), "Delivery is unavailable.");
  });

  it("detects the history threshold and retains the visible anchor after prepending", () => {
    assert.equal(isNearHistoryTop(80), true);
    assert.equal(isNearHistoryTop(81), false);
    assert.equal(retainedHistoryScrollTop(24, 600, 980), 404);
  });

  it("clears only the matching preview on a typed clear, durable assistant message, or reset", () => {
    const preview = { type: "assistant_preview" as const, interactionId: "preview_provider-request", body: "Working", occurredAt: "2026-07-13T00:00:00.000Z" };
    const matchingClear = { type: "assistant_preview_clear" as const, interactionId: preview.interactionId };
    const staleClear = { type: "assistant_preview_clear" as const, interactionId: "preview_older-request" };
    const assistant = { type: "interaction" as const, cursor: "cursor_2", item: { ...interaction(1, "Final response"), id: "assistant_message_9", kind: "assistant_message" as const, title: "Assistant", status: "completed" as const } };
    const reset = { type: "reset" as const, snapshot: { items: [], nextPageCursor: null, hasMoreBefore: false, streamCursor: "cursor_3", historyStatus: "complete" as const, queuedMessages: [], runState: "idle" as const, runtimeReachability: "reachable" as const, lastSyncedAt: null, capabilities } };

    assert.equal(reduceTaskAssistantPreview(preview, matchingClear), null);
    assert.equal(reduceTaskAssistantPreview(preview, staleClear), preview);
    assert.equal(reduceTaskAssistantPreview(preview, assistant), null);
    assert.equal(reduceTaskAssistantPreview(preview, reset), null);
  });
});
