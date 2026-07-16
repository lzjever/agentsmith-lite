import type { TaskCapabilities, TaskInteractionItem, TaskInteractionStreamEvent, TaskMessageReceipt, TaskQueuedMessage } from "../../lib/api/client.js";

export type TaskAssistantPreview = Extract<TaskInteractionStreamEvent, { type: "assistant_preview" }> | null;

export function upsertTaskInteractions(items: TaskInteractionItem[], incoming: TaskInteractionItem[]): TaskInteractionItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of incoming) {
    const current = byId.get(item.id);
    if (!current || item.revision >= current.revision) byId.set(item.id, item);
  }
  return [...byId.values()].sort((left, right) => left.position - right.position || left.occurredAt.localeCompare(right.occurredAt));
}

export function isNearHistoryTop(scrollTop: number): boolean {
  return scrollTop <= 80;
}

export function retainedHistoryScrollTop(previousTop: number, previousHeight: number, nextHeight: number): number {
  return previousTop + Math.max(0, nextHeight - previousHeight);
}

export function applyTaskMessageReceipt(state: { items: TaskInteractionItem[]; queuedMessages: TaskQueuedMessage[]; capabilities: TaskCapabilities }, receipt: TaskMessageReceipt, applyCapabilities = true): { items: TaskInteractionItem[]; queuedMessages: TaskQueuedMessage[]; capabilities: TaskCapabilities } {
  return {
    items: receipt.interaction ? upsertTaskInteractions(state.items, [receipt.interaction]) : state.items,
    queuedMessages: receipt.queuedMessage ? upsertQueuedMessage(state.queuedMessages, receipt.queuedMessage) : state.queuedMessages.filter((message) => message.id !== receipt.messageId),
    capabilities: applyCapabilities ? receipt.capabilities : state.capabilities
  };
}

export function taskMessageReceiptError(receipt: TaskMessageReceipt): string | null {
  if (receipt.disposition !== "failed") return null;
  const safeError = "safeError" in receipt && typeof receipt.safeError === "string" ? receipt.safeError.trim() : "";
  return safeError || "Message delivery failed.";
}

export function reduceTaskAssistantPreview(preview: TaskAssistantPreview, event: TaskInteractionStreamEvent): TaskAssistantPreview {
  if (event.type === "assistant_preview") return event;
  if (event.type === "assistant_preview_clear" && preview?.interactionId === event.interactionId) return null;
  if (event.type === "reset") return null;
  if (event.type === "interaction" && event.item.kind === "assistant_message") return null;
  return preview;
}

function upsertQueuedMessage(messages: TaskQueuedMessage[], incoming: TaskQueuedMessage): TaskQueuedMessage[] {
  const current = messages.find((message) => message.id === incoming.id);
  if (current && current.updatedAt > incoming.updatedAt) return messages;
  return [...messages.filter((message) => message.id !== incoming.id), incoming].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
}
