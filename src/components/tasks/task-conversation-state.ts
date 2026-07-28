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
type SandboxLifecycle = TaskDetail["sandboxState"]["state"];

export type TaskCommandFence = {
  taskId: string;
  startedAtCanonicalEpoch: number;
  expectedRunId: string | null;
  expectedSandboxState: SandboxLifecycle;
};

export type TaskRunFence = {
  currentRunId: string | null;
  lifecycle: SandboxLifecycle | null;
  retiredRunIds: ReadonlySet<string>;
};

export interface TaskPresentationState {
  taskId: string;
  canonicalEpoch: number;
  latestCanonicalReadId: number;
  streamGeneration: number;
  streamSequence: number;
  runFence: TaskRunFence;
  canonicalRefreshRequired: boolean;
  canonicalRefreshInFlight: boolean;
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
  | {
      type: "canonical_read_started";
      taskId: string;
      readId: number;
      baseCanonicalEpoch: number;
    }
  | {
      type: "canonical_snapshot_received";
      taskId: string;
      readId: number;
      baseCanonicalEpoch: number;
      snapshot: TaskInteractionSnapshot;
    }
  | {
      type: "stream_started";
      taskId: string;
      streamGeneration: number;
    }
  | {
      type: "stream_state_received";
      taskId: string;
      streamGeneration: number;
      streamSequence: number;
      runId: string | null;
      queuedMessages: TaskQueuedMessage[];
      presentation: TaskDetail;
    }
  | {
      type: "stream_snapshot_received";
      taskId: string;
      streamGeneration: number;
      streamSequence: number;
      snapshot: TaskInteractionSnapshot;
    }
  | { type: "canonical_refresh_started"; taskId: string }
  | { type: "canonical_refresh_finished"; taskId: string }
  | {
      type: "canonical_mutation_accepted";
      taskId: string;
      kind: "message" | "message_edit" | "message_delete" | "release" | "terminal_start" | "abort";
      fence: TaskCommandFence;
      targetRunId?: string;
      interaction?: TaskInteractionItem | null;
    }
  | {
      type: "canonical_mutation_rejected";
      taskId: string;
      fence: TaskCommandFence;
      presentation?: TaskDetail;
    }
  | {
      type: "interaction_received";
      taskId: string;
      item: TaskInteractionItem;
    }
  | {
      type: "connection_changed";
      connection: TaskConnectionState;
      runtimeReachability?: TaskInteractionSnapshot["runtimeReachability"];
      historyStatus?: TaskInteractionSnapshot["historyStatus"];
      lastSyncedAt?: string | null;
    }
  | { type: "stream_cursor_changed"; streamCursor: string }
  | {
      type: "history_prepend_received";
      taskId: string;
      items: TaskInteractionItem[];
      nextPageCursor?: string | null;
      hasMoreBefore?: boolean;
    }
  | { type: "assistant_preview_received"; preview: Exclude<TaskAssistantPreview, null> }
  | { type: "assistant_preview_flushed" }
  | { type: "assistant_preview_cleared"; interactionId: string }
  | { type: "reading_started" }
  | { type: "jump_to_latest" };

export type TaskPresentationDispatch = (
  action: TaskPresentationAction
) => TaskPresentationState;

export function createTaskPresentationState(
  initial: Partial<Pick<TaskPresentationState, "items" | "queuedMessages" | "presentation" | "connection" | "followMode">>
    & { taskId?: string; canonicalEpoch?: number; snapshot?: TaskInteractionSnapshot } = {}
): TaskPresentationState {
  const source = initial.snapshot;
  const items = source?.items ?? reconcileTaskInteractions([], initial.items ?? []);
  const itemIndex = createItemIndex(items);
  const taskId = initial.taskId
    ?? source?.presentation.task.id
    ?? initial.presentation?.task.id
    ?? items[0]?.taskId
    ?? "";
  return {
    taskId,
    canonicalEpoch: initial.canonicalEpoch ?? (source ? 1 : 0),
    latestCanonicalReadId: 0,
    streamGeneration: 0,
    streamSequence: 0,
    runFence: createRunFence(source?.presentation ?? initial.presentation),
    canonicalRefreshRequired: false,
    canonicalRefreshInFlight: false,
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
    case "canonical_read_started":
      if (
        action.taskId !== state.taskId
        || action.readId <= state.latestCanonicalReadId
        || action.baseCanonicalEpoch !== state.canonicalEpoch
      ) return state;
      return { ...state, latestCanonicalReadId: action.readId };
    case "canonical_snapshot_received":
      return reduceCanonicalSnapshot(state, action);
    case "stream_started":
      if (action.taskId !== state.taskId || action.streamGeneration <= state.streamGeneration) return state;
      return {
        ...state,
        streamGeneration: action.streamGeneration,
        streamSequence: 0
      };
    case "stream_state_received":
      return reduceStreamState(state, action);
    case "stream_snapshot_received":
      return reduceStreamSnapshot(state, action);
    case "canonical_refresh_started":
      return action.taskId === state.taskId
        && state.canonicalRefreshRequired
        && !state.canonicalRefreshInFlight
        ? { ...state, canonicalRefreshInFlight: true }
        : state;
    case "canonical_refresh_finished":
      return action.taskId === state.taskId && state.canonicalRefreshInFlight
        ? { ...state, canonicalRefreshInFlight: false }
        : state;
    case "canonical_mutation_accepted":
      return reduceAcceptedMutation(state, action);
    case "canonical_mutation_rejected":
      return state;
    case "interaction_received": {
      if (action.taskId !== state.taskId || action.item.taskId !== action.taskId) return state;
      return reduceInteraction(state, action.item);
    }
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
    case "history_prepend_received": {
      if (action.taskId !== state.taskId || action.items.some((item) => item.taskId !== action.taskId)) return state;
      const items = reconcileTaskInteractions(state.items, action.items);
      const nextPageCursor = action.nextPageCursor === undefined ? state.nextPageCursor : action.nextPageCursor;
      const hasMoreBefore = action.hasMoreBefore ?? state.hasMoreBefore;
      if (
        items === state.items
        && nextPageCursor === state.nextPageCursor
        && hasMoreBefore === state.hasMoreBefore
      ) return state;
      return {
        ...state,
        items,
        itemIndex: createItemIndex(items),
        nextPageCursor,
        hasMoreBefore
      };
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

export function createSerialTaskRefreshTail(): <T>(
  refresh: () => Promise<T>
) => Promise<T> {
  let tail = Promise.resolve();
  return <T>(refresh: () => Promise<T>) => {
    const result = tail.then(refresh, refresh);
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
}

export function createSingleFlightTaskRefresh(): (
  refresh: () => Promise<boolean>
) => Promise<boolean> {
  let inFlight: Promise<boolean> | null = null;
  return (refresh) => {
    if (inFlight) return inFlight;
    const result = Promise.resolve().then(refresh);
    const tracked = result.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  };
}

export async function convergeRequiredTaskRefresh(
  refresh: () => Promise<boolean>,
  isRequired: () => boolean,
  wait: (delay: number) => Promise<void>
): Promise<void> {
  let retryAttempt = 0;
  while (isRequired()) {
    await refresh();
    if (!isRequired()) return;
    retryAttempt += 1;
    await wait(Math.min(5_000, retryAttempt * 1_000));
  }
}

export function captureTaskCommandFence(state: TaskPresentationState): TaskCommandFence {
  return {
    taskId: state.taskId,
    startedAtCanonicalEpoch: state.canonicalEpoch,
    expectedRunId: state.runFence.currentRunId,
    expectedSandboxState: state.runFence.lifecycle ?? "released"
  };
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

function reduceCanonicalSnapshot(
  state: TaskPresentationState,
  action: Extract<TaskPresentationAction, { type: "canonical_snapshot_received" }>
): TaskPresentationState {
  if (
    action.taskId !== state.taskId
    || action.readId !== state.latestCanonicalReadId
    || action.baseCanonicalEpoch !== state.canonicalEpoch
    || action.snapshot.items.some((item) => item.taskId !== action.taskId)
    || action.snapshot.presentation.task.id !== action.taskId
  ) return state;
  return applyCanonicalSnapshot(
    state,
    action.snapshot,
    rebuildRunFence(state.runFence, action.snapshot.presentation)
  );
}

function reduceStreamState(
  state: TaskPresentationState,
  action: Extract<TaskPresentationAction, { type: "stream_state_received" }>
): TaskPresentationState {
  if (
    action.taskId !== state.taskId
    || action.streamGeneration !== state.streamGeneration
    || action.streamSequence <= state.streamSequence
    || action.presentation.task.id !== action.taskId
    || action.presentation.sandboxState.runId !== action.runId
  ) return state;
  const admitted = admitRunPresentation(state.runFence, action.presentation, action.taskId);
  if (!admitted) {
    return {
      ...state,
      streamSequence: action.streamSequence,
      canonicalRefreshRequired: true
    };
  }
  return {
    ...state,
    canonicalEpoch: state.canonicalEpoch + 1,
    streamSequence: action.streamSequence,
    runFence: admitted,
    queuedMessages: action.queuedMessages,
    presentation: action.presentation
  };
}

function reduceStreamSnapshot(
  state: TaskPresentationState,
  action: Extract<TaskPresentationAction, { type: "stream_snapshot_received" }>
): TaskPresentationState {
  if (
    action.taskId !== state.taskId
    || action.streamGeneration !== state.streamGeneration
    || action.streamSequence <= state.streamSequence
    || action.snapshot.items.some((item) => item.taskId !== action.taskId)
    || action.snapshot.presentation.task.id !== action.taskId
  ) return state;
  return {
    ...applyCanonicalSnapshot(
      state,
      action.snapshot,
      rebuildRunFence(state.runFence, action.snapshot.presentation)
    ),
    streamSequence: action.streamSequence
  };
}

function reduceAcceptedMutation(
  state: TaskPresentationState,
  action: Extract<TaskPresentationAction, { type: "canonical_mutation_accepted" }>
): TaskPresentationState {
  if (
    action.taskId !== state.taskId
    || action.fence.taskId !== state.taskId
    || action.fence.startedAtCanonicalEpoch > state.canonicalEpoch
    || !acceptedMutationMatchesCurrentRun(state, action)
  ) return state;
  const interaction = action.interaction;
  const items = interaction?.taskId === state.taskId
    ? reconcileTaskInteractions(state.items, [interaction])
    : state.items;
  const runFence = action.kind === "release"
    ? advanceAcceptedReleaseFence(state.runFence)
    : state.runFence;
  return {
    ...state,
    canonicalEpoch: state.canonicalEpoch + 1,
    runFence,
    canonicalRefreshRequired: true,
    items,
    itemIndex: items === state.items ? state.itemIndex : createItemIndex(items),
    followMode: action.kind === "message" ? "following" : state.followMode,
    newActivityCount: action.kind === "message" ? 0 : state.newActivityCount
  };
}

function advanceAcceptedReleaseFence(runFence: TaskRunFence): TaskRunFence {
  if (
    runFence.lifecycle === null
    || lifecycleRank(runFence.lifecycle) >= lifecycleRank("release_requested")
  ) return runFence;
  return {
    ...runFence,
    lifecycle: "release_requested"
  };
}

function acceptedMutationMatchesCurrentRun(
  state: TaskPresentationState,
  action: Extract<TaskPresentationAction, { type: "canonical_mutation_accepted" }>
): boolean {
  if (
    action.kind === "message"
    || action.kind === "message_edit"
    || action.kind === "message_delete"
  ) return true;
  if (action.kind === "terminal_start") {
    return typeof action.targetRunId === "string"
      && !state.runFence.retiredRunIds.has(action.targetRunId)
      && (
        state.runFence.currentRunId === action.fence.expectedRunId
        || state.runFence.currentRunId === action.targetRunId
      );
  }
  return state.runFence.currentRunId === action.fence.expectedRunId
    && state.runFence.lifecycle !== null
    && lifecycleRank(state.runFence.lifecycle) >= lifecycleRank(action.fence.expectedSandboxState);
}

function applyCanonicalSnapshot(
  state: TaskPresentationState,
  snapshot: TaskInteractionSnapshot,
  runFence: TaskRunFence
): TaskPresentationState {
  const items = reconcileTaskInteractions(state.items, snapshot.items);
  const newActivityCount = state.followMode === "reading"
    ? state.newActivityCount + countNewTailInteractions(state, snapshot.items)
    : state.newActivityCount;
  return {
    ...state,
    canonicalEpoch: state.canonicalEpoch + 1,
    runFence,
    canonicalRefreshRequired: false,
    canonicalRefreshInFlight: false,
    initialized: true,
    items,
    itemIndex: createItemIndex(items),
    queuedMessages: snapshot.queuedMessages,
    presentation: snapshot.presentation,
    runtimeReachability: snapshot.runtimeReachability,
    historyStatus: snapshot.historyStatus,
    lastSyncedAt: snapshot.lastSyncedAt,
    nextPageCursor: snapshot.nextPageCursor,
    hasMoreBefore: snapshot.hasMoreBefore,
    streamCursor: snapshot.streamCursor,
    preview: null,
    pendingPreview: null,
    newActivityCount
  };
}

function rebuildRunFence(
  current: TaskRunFence,
  presentation: TaskDetail
): TaskRunFence {
  const incomingRunId = presentation.sandboxState.runId;
  const retiredRunIds = new Set(current.retiredRunIds);
  if (current.currentRunId && current.currentRunId !== incomingRunId) {
    retiredRunIds.add(current.currentRunId);
  }
  if (incomingRunId) retiredRunIds.delete(incomingRunId);
  return {
    currentRunId: incomingRunId,
    lifecycle: presentation.sandboxState.state,
    retiredRunIds
  };
}

function admitRunPresentation(
  current: TaskRunFence,
  presentation: TaskDetail,
  taskId: string
): TaskRunFence | null {
  if (presentation.task.id !== taskId) return null;
  const incomingRunId = presentation.sandboxState.runId;
  const incomingLifecycle = presentation.sandboxState.state;
  if (current.lifecycle === null) {
    return {
      currentRunId: incomingRunId,
      lifecycle: incomingLifecycle,
      retiredRunIds: current.retiredRunIds
    };
  }
  if (incomingRunId === current.currentRunId) {
    if (lifecycleRank(incomingLifecycle) < lifecycleRank(current.lifecycle)) return null;
    return {
      currentRunId: incomingRunId,
      lifecycle: incomingLifecycle,
      retiredRunIds: current.retiredRunIds
    };
  }
  if (
    current.lifecycle !== "released"
    || incomingRunId !== null && current.retiredRunIds.has(incomingRunId)
  ) return null;
  const retiredRunIds = new Set(current.retiredRunIds);
  if (current.currentRunId) retiredRunIds.add(current.currentRunId);
  return {
    currentRunId: incomingRunId,
    lifecycle: incomingLifecycle,
    retiredRunIds
  };
}

function createRunFence(presentation: TaskDetail | undefined): TaskRunFence {
  return {
    currentRunId: presentation?.sandboxState.runId ?? null,
    lifecycle: presentation?.sandboxState.state ?? null,
    retiredRunIds: new Set()
  };
}

function lifecycleRank(lifecycle: SandboxLifecycle): number {
  switch (lifecycle) {
    case "starting": return 0;
    case "active": return 1;
    case "failed": return 2;
    case "release_requested": return 3;
    case "released": return 4;
    default: return assertNever(lifecycle);
  }
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
