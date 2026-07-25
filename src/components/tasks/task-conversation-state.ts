import type {
  TaskDetail,
  TaskInteractionItem,
  TaskInteractionSnapshot,
  TaskInteractionStreamEvent,
  TaskMessageReceipt,
  TaskQueuedMessage
} from "../../lib/api/client.js";

export type TaskAssistantPreview = Extract<TaskInteractionStreamEvent, { type: "assistant_preview" }> | null;
export type TaskConnectionState = "connecting" | "reconnecting" | "connected" | "disconnected" | "recovered";
export type TaskFollowMode = "following" | "reading";

type ItemLocation = { index: number; revision: number };

export interface TaskPresentationState {
  initialized: boolean;
  items: TaskInteractionItem[];
  itemIndex: ReadonlyMap<string, ItemLocation>;
  queuedMessages: TaskQueuedMessage[];
  presentation: TaskDetail | undefined;
  connection: TaskConnectionState;
  runtimeReachability: TaskInteractionSnapshot["runtimeReachability"];
  historyStatus: TaskInteractionSnapshot["historyStatus"];
  lastSyncedAt: string | null;
  nextPageCursor: string | null;
  hasMoreBefore: boolean;
  streamCursor?: string;
  preview: TaskAssistantPreview;
  pendingPreview: TaskAssistantPreview;
  followMode: TaskFollowMode;
  newActivityCount: number;
}

export type TaskPresentationAction =
  | { type: "interaction_received"; item: TaskInteractionItem }
  | { type: "state_received"; queuedMessages: TaskQueuedMessage[]; presentation: TaskDetail }
  | { type: "presentation_received"; presentation: TaskDetail }
  | {
      type: "connection_changed";
      connection: TaskConnectionState;
      runtimeReachability?: TaskInteractionSnapshot["runtimeReachability"];
      historyStatus?: TaskInteractionSnapshot["historyStatus"];
      lastSyncedAt?: string | null;
    }
  | { type: "stream_cursor_changed"; streamCursor: string }
  | { type: "snapshot_reset"; snapshot: TaskInteractionSnapshot }
  | {
      type: "earlier_prepend";
      items: TaskInteractionItem[];
      nextPageCursor?: string | null;
      hasMoreBefore?: boolean;
    }
  | { type: "assistant_preview_received"; preview: Exclude<TaskAssistantPreview, null> }
  | { type: "assistant_preview_flushed" }
  | { type: "assistant_preview_cleared"; interactionId: string }
  | { type: "reading_started" }
  | { type: "jump_to_latest" }
  | { type: "message_send_requested" }
  | { type: "message_accepted"; receipt: TaskMessageReceipt }
  | { type: "message_rejected"; presentation?: TaskDetail };

export function createTaskPresentationState(
  initial: Partial<Pick<TaskPresentationState, "items" | "queuedMessages" | "presentation" | "connection" | "followMode">>
    & { snapshot?: TaskInteractionSnapshot } = {}
): TaskPresentationState {
  const source = initial.snapshot;
  const items = source?.items ?? reconcileTaskInteractions([], initial.items ?? []);
  const itemIndex = createItemIndex(items);
  return {
    initialized: Boolean(source),
    items,
    itemIndex,
    queuedMessages: source?.queuedMessages ?? initial.queuedMessages ?? [],
    presentation: source?.presentation ?? initial.presentation,
    connection: initial.connection ?? "connecting",
    runtimeReachability: source?.runtimeReachability ?? "unknown",
    historyStatus: source?.historyStatus ?? "complete",
    lastSyncedAt: source?.lastSyncedAt ?? null,
    nextPageCursor: source?.nextPageCursor ?? null,
    hasMoreBefore: source?.hasMoreBefore ?? false,
    ...(source ? { streamCursor: source.streamCursor } : {}),
    preview: null,
    pendingPreview: null,
    followMode: initial.followMode ?? "following",
    newActivityCount: 0
  };
}

export function reduceTaskPresentationState(
  state: TaskPresentationState,
  action: TaskPresentationAction
): TaskPresentationState {
  switch (action.type) {
    case "interaction_received":
      return reduceInteraction(state, action.item);
    case "state_received":
      if (state.queuedMessages === action.queuedMessages && state.presentation === action.presentation) return state;
      return { ...state, queuedMessages: action.queuedMessages, presentation: action.presentation };
    case "presentation_received":
      return state.presentation === action.presentation ? state : { ...state, presentation: action.presentation };
    case "connection_changed": {
      const connection = state.connection === "reconnecting" && action.connection === "connected"
        ? "recovered"
        : action.connection;
      const runtimeReachability = action.runtimeReachability ?? state.runtimeReachability;
      const historyStatus = action.historyStatus ?? state.historyStatus;
      const lastSyncedAt = action.lastSyncedAt === undefined ? state.lastSyncedAt : action.lastSyncedAt;
      if (
        state.connection === connection
        && state.runtimeReachability === runtimeReachability
        && state.historyStatus === historyStatus
        && state.lastSyncedAt === lastSyncedAt
      ) return state;
      return { ...state, connection, runtimeReachability, historyStatus, lastSyncedAt };
    }
    case "stream_cursor_changed":
      return state.streamCursor === action.streamCursor ? state : { ...state, streamCursor: action.streamCursor };
    case "snapshot_reset": {
      const items = reconcileTaskInteractions(state.items, action.snapshot.items);
      const newActivityCount = state.followMode === "reading"
        ? state.newActivityCount + countNewTailInteractions(state, action.snapshot.items)
        : state.newActivityCount;
      return {
        ...state,
        initialized: true,
        items,
        itemIndex: createItemIndex(items),
        queuedMessages: action.snapshot.queuedMessages,
        presentation: action.snapshot.presentation,
        runtimeReachability: action.snapshot.runtimeReachability,
        historyStatus: action.snapshot.historyStatus,
        lastSyncedAt: action.snapshot.lastSyncedAt,
        nextPageCursor: action.snapshot.nextPageCursor,
        hasMoreBefore: action.snapshot.hasMoreBefore,
        streamCursor: action.snapshot.streamCursor,
        preview: null,
        pendingPreview: null,
        newActivityCount
      };
    }
    case "earlier_prepend": {
      const items = reconcileTaskInteractions(state.items, action.items);
      const nextPageCursor = action.nextPageCursor === undefined ? state.nextPageCursor : action.nextPageCursor;
      const hasMoreBefore = action.hasMoreBefore ?? state.hasMoreBefore;
      if (
        items === state.items
        && nextPageCursor === state.nextPageCursor
        && hasMoreBefore === state.hasMoreBefore
      ) return state;
      return { ...state, items, itemIndex: createItemIndex(items), nextPageCursor, hasMoreBefore };
    }
    case "assistant_preview_received":
      if (state.pendingPreview === action.preview) return state;
      return { ...state, pendingPreview: action.preview };
    case "assistant_preview_flushed":
      if (!state.pendingPreview) return state;
      return { ...state, preview: state.pendingPreview, pendingPreview: null };
    case "assistant_preview_cleared": {
      const clearsVisible = state.preview?.interactionId === action.interactionId;
      const clearsPending = state.pendingPreview?.interactionId === action.interactionId;
      if (!clearsVisible && !clearsPending) return state;
      return {
        ...state,
        preview: clearsVisible ? null : state.preview,
        pendingPreview: clearsPending ? null : state.pendingPreview
      };
    }
    case "reading_started":
      return state.followMode === "reading" ? state : { ...state, followMode: "reading" };
    case "jump_to_latest":
      if (state.followMode === "following" && state.newActivityCount === 0) return state;
      return { ...state, followMode: "following", newActivityCount: 0 };
    case "message_send_requested":
      return state;
    case "message_accepted": {
      const items = action.receipt.interaction
        ? reconcileTaskInteractions(state.items, [action.receipt.interaction])
        : state.items;
      const queuedMessages = action.receipt.queuedMessage
        ? [
            ...state.queuedMessages.filter((message) => message.id !== action.receipt.queuedMessage?.id),
            action.receipt.queuedMessage
          ]
        : state.queuedMessages;
      return {
        ...state,
        items,
        itemIndex: items === state.items ? state.itemIndex : createItemIndex(items),
        queuedMessages,
        presentation: action.receipt.presentation,
        followMode: "following",
        newActivityCount: 0
      };
    }
    case "message_rejected":
      return action.presentation && action.presentation !== state.presentation
        ? { ...state, presentation: action.presentation }
        : state;
    default:
      return assertNever(action);
  }
}

export function upsertTaskInteractions(
  items: TaskInteractionItem[],
  incoming: TaskInteractionItem[]
): TaskInteractionItem[] {
  return reconcileTaskInteractions(items, incoming);
}

export function isNearHistoryTop(scrollTop: number): boolean {
  return scrollTop <= 80;
}

export function retainedHistoryScrollTop(
  previousTop: number,
  previousHeight: number,
  nextHeight: number
): number {
  return previousTop + Math.max(0, nextHeight - previousHeight);
}

export function taskMessageReceiptError(receipt: TaskMessageReceipt): string | null {
  if (receipt.disposition !== "failed") return null;
  const safeError = "safeError" in receipt && typeof receipt.safeError === "string"
    ? receipt.safeError.trim()
    : "";
  return safeError || "Message delivery failed.";
}

export function reduceTaskAssistantPreview(
  preview: TaskAssistantPreview,
  event: TaskInteractionStreamEvent
): TaskAssistantPreview {
  if (event.type === "assistant_preview") return event;
  if (event.type === "assistant_preview_clear" && preview?.interactionId === event.interactionId) return null;
  if (event.type === "reset") return null;
  if (event.type === "interaction" && event.item.kind === "assistant_message") return null;
  return preview;
}

function reduceInteraction(
  state: TaskPresentationState,
  item: TaskInteractionItem
): TaskPresentationState {
  const current = state.itemIndex.get(item.id);
  if (current && item.revision <= current.revision) return state;

  const items = reconcileTaskInteractions(state.items, [item]);
  const itemIndex = createItemIndex(items);
  const isTailAppend = !current && isAfterLastItem(state.items, item);
  const newActivityCount = state.followMode === "reading" && isTailAppend
    ? state.newActivityCount + 1
    : state.newActivityCount;
  const clearsPreview = item.kind === "assistant_message";

  return {
    ...state,
    items,
    itemIndex,
    newActivityCount,
    preview: clearsPreview ? null : state.preview,
    pendingPreview: clearsPreview ? null : state.pendingPreview
  };
}

function reconcileTaskInteractions(
  current: TaskInteractionItem[],
  incoming: TaskInteractionItem[]
): TaskInteractionItem[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((item) => [item.id, item]));
  let changed = false;
  for (const item of incoming) {
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      changed = true;
    } else if (item.revision > existing.revision) {
      byId.set(item.id, item);
      changed = true;
    }
  }
  if (!changed) return current;
  return [...byId.values()].sort(compareInteractions);
}

function createItemIndex(items: TaskInteractionItem[]): ReadonlyMap<string, ItemLocation> {
  return new Map(items.map((item, index) => [item.id, { index, revision: item.revision }]));
}

function isAfterLastItem(items: TaskInteractionItem[], item: TaskInteractionItem): boolean {
  const last = items.at(-1);
  return !last || compareInteractions(last, item) <= 0;
}

function countNewTailInteractions(
  state: TaskPresentationState,
  incoming: TaskInteractionItem[]
): number {
  return incoming.filter((item) => (
    !state.itemIndex.has(item.id)
    && isAfterLastItem(state.items, item)
  )).length;
}

function compareInteractions(left: TaskInteractionItem, right: TaskInteractionItem): number {
  return left.position - right.position
    || left.occurredAt.localeCompare(right.occurredAt)
    || left.id.localeCompare(right.id);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported task presentation action: ${String(value)}`);
}
