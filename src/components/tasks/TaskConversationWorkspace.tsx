"use client";

import { Banner, Button, Text } from "@astryxdesign/core";
import { ChevronDown, CircleAlert, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from "react";
import type {
  TaskDetail,
  TaskInteractionSnapshot,
  TaskInteractionStreamEvent,
  TaskMessageReceipt
} from "../../lib/api/client";
import { ApiError, apiClient } from "../../lib/api/client";
import { TaskComposer } from "./TaskComposer";
import { TaskInteractionList } from "./TaskInteractionList";
import {
  createTaskPresentationState,
  reduceTaskPresentationState,
  taskMessageReceiptError,
  type TaskAssistantPreview,
  type TaskPresentationAction,
  type TaskPresentationState
} from "./task-conversation-state";
import { useTaskMutationKeys } from "./task-mutation-key";
import { TaskConnectionNotice, TaskPreviewNotice } from "./TaskRunStatus";

type WorkspaceHandlers = {
  onPresentationChange: (presentation: TaskDetail) => void;
  onUnavailable: ((reason: ApiError) => void) | undefined;
  onArtifactPublished: () => void;
};

type HistoryAnchor = { interactionId: string; offset: number };

export function TaskConversationWorkspace({
  taskId,
  userId,
  projectId,
  activeSandboxesHref,
  canManagePolicy,
  policyHref,
  initialSnapshot,
  presentation,
  commandBusy = false,
  onPresentationChange,
  onUnavailable,
  onArtifactPublished
}: {
  taskId: string;
  userId: string;
  projectId: string;
  activeSandboxesHref: string;
  canManagePolicy: boolean;
  policyHref: string;
  initialSnapshot: TaskInteractionSnapshot;
  presentation: TaskDetail;
  commandBusy?: boolean;
  onPresentationChange: (presentation: TaskDetail) => void;
  onUnavailable?: (reason: ApiError) => void;
  onArtifactPublished: () => void;
}) {
  const mutationKeys = useTaskMutationKeys();
  const mutationKeysRef = useRef(mutationKeys);
  mutationKeysRef.current = mutationKeys;

  const handlers = useRef<WorkspaceHandlers>({
    onPresentationChange,
    onUnavailable,
    onArtifactPublished
  });
  handlers.current = {
    onPresentationChange,
    onUnavailable,
    onArtifactPublished
  };

  const viewport = useRef<HTMLDivElement>(null);
  const streamCursor = useRef<string | undefined>(initialSnapshot.streamCursor);
  const streamController = useRef<AbortController | undefined>(undefined);
  const streamGeneration = useRef(0);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const reconnectCount = useRef(0);
  const badCursorRecoveryUsed = useRef(false);
  const appliedSnapshot = useRef(initialSnapshot);
  const initialScrollPending = useRef(true);
  const loadingEarlierRef = useRef(false);
  const historyAnchor = useRef<HistoryAnchor | undefined>(undefined);
  const previewTimer = useRef<number | undefined>(undefined);
  const latestPreview = useRef<TaskAssistantPreview>(null);
  const stateRef = useRef<TaskPresentationState>(
    createTaskPresentationState({ snapshot: initialSnapshot })
  );
  const [state, dispatch] = useReducer(
    reduceTaskPresentationState,
    stateRef.current
  );
  stateRef.current = state;

  const [error, setError] = useState("");
  const [previewUnavailable, setPreviewUnavailable] = useState("");
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [anchorGeneration, setAnchorGeneration] = useState(0);

  const clearPreviewTimer = useCallback((interactionId?: string) => {
    if (
      interactionId
      && latestPreview.current
      && latestPreview.current.interactionId !== interactionId
    ) return;
    if (previewTimer.current !== undefined) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = undefined;
    }
    latestPreview.current = null;
  }, []);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "auto") => {
    requestAnimationFrame(() => {
      const element = viewport.current;
      if (element) element.scrollTo({ top: element.scrollHeight, behavior });
    });
  }, []);

  const queuePreview = useCallback((preview: Exclude<TaskAssistantPreview, null>) => {
    latestPreview.current = preview;
    if (previewTimer.current !== undefined) return;
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = undefined;
      const next = latestPreview.current;
      latestPreview.current = null;
      if (!next) return;
      dispatch({ type: "assistant_preview_received", preview: next });
      dispatch({ type: "assistant_preview_flushed" });
      if (stateRef.current.followMode === "following") scrollToLatest();
    }, 50);
  }, [scrollToLatest]);

  const preserveReadingAnchor = useCallback(() => {
    if (stateRef.current.followMode !== "reading") return;
    const element = viewport.current;
    if (element) {
      historyAnchor.current = captureHistoryAnchor(element);
      setAnchorGeneration((value) => value + 1);
    }
  }, []);

  const applySnapshot = useCallback((next: TaskInteractionSnapshot) => {
    preserveReadingAnchor();
    clearPreviewTimer();
    streamCursor.current = next.streamCursor;
    dispatch({ type: "snapshot_reset", snapshot: next });
    handlers.current.onPresentationChange(next.presentation);
    setPreviewUnavailable("");
    if (stateRef.current.followMode === "following") scrollToLatest();
  }, [clearPreviewTimer, preserveReadingAnchor, scrollToLatest]);

  useEffect(() => {
    if (appliedSnapshot.current === initialSnapshot) return;
    appliedSnapshot.current = initialSnapshot;
    const controller = streamController.current;
    streamController.current = undefined;
    streamGeneration.current += 1;
    controller?.abort();
    badCursorRecoveryUsed.current = false;
    reconnectCount.current = 0;
    setError("");
    applySnapshot(initialSnapshot);
    setRefreshGeneration((value) => value + 1);
  }, [applySnapshot, initialSnapshot]);

  useLayoutEffect(() => {
    if (stateRef.current.presentation === presentation) return;
    dispatch({ type: "presentation_received", presentation });
  }, [presentation]);

  const recoverFreshSnapshot = useCallback(async () => {
    const next = await apiClient.getTaskInteractions(taskId);
    applySnapshot(next);
    return next;
  }, [applySnapshot, taskId]);

  useLayoutEffect(() => {
    const anchor = historyAnchor.current;
    const element = viewport.current;
    if (anchor && element) {
      const anchoredRow = findInteractionRow(element, anchor.interactionId);
      historyAnchor.current = undefined;
      if (anchoredRow) {
        const nextOffset = anchoredRow.getBoundingClientRect().top - element.getBoundingClientRect().top;
        element.scrollTop += nextOffset - anchor.offset;
      }
      return;
    }
    if (!state.initialized || !initialScrollPending.current) return;
    initialScrollPending.current = false;
    if (element) element.scrollTop = element.scrollHeight;
  }, [anchorGeneration, state.initialized, state.items]);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | undefined;

    const connect = async () => {
      let done = false;
      controller?.abort();
      const nextController = new AbortController();
      const generation = streamGeneration.current + 1;
      streamGeneration.current = generation;
      controller = nextController;
      streamController.current = nextController;
      dispatch({
        type: "connection_changed",
        connection: reconnectCount.current > 0 ? "reconnecting" : "connecting"
      });
      setPreviewUnavailable("");
      try {
        await apiClient.streamTaskInteractions(
          taskId,
          streamCursor.current,
          nextController.signal,
          (event) => {
            if (
              disposed
              || streamGeneration.current !== generation
              || streamController.current !== nextController
            ) return;
            if (event.type === "done") done = true;
            applyStreamEvent(event, {
              dispatch,
              clearPreviewTimer,
              queuePreview,
              setError,
              setPreviewUnavailable,
              handlers,
              applySnapshot,
              streamCursor,
              reconnectCount,
              badCursorRecoveryUsed,
              followMode: stateRef.current.followMode,
              scrollToLatest
            });
          }
        );
        if (
          disposed
          || done
          || streamGeneration.current !== generation
          || streamController.current !== nextController
        ) return;
        reconnectCount.current += 1;
        reconnectTimer.current = window.setTimeout(() => void connect(), 1_000);
      } catch (reason) {
        if (
          disposed
          || nextController.signal.aborted
          || streamGeneration.current !== generation
          || streamController.current !== nextController
        ) return;
        if (reason instanceof ApiError && (reason.status === 403 || reason.status === 404)) {
          dispatch({ type: "connection_changed", connection: "disconnected" });
          setError(reason.message);
          handlers.current.onUnavailable?.(reason);
          return;
        }
        if (reason instanceof ApiError && reason.status === 400) {
          if (badCursorRecoveryUsed.current) {
            dispatch({ type: "connection_changed", connection: "disconnected" });
            setError(reason.message);
            return;
          }
          badCursorRecoveryUsed.current = true;
          try {
            await recoverFreshSnapshot();
            if (disposed) return;
            reconnectCount.current = 0;
            setError("");
            reconnectTimer.current = window.setTimeout(() => void connect(), 0);
          } catch (refreshReason) {
            if (disposed) return;
            dispatch({ type: "connection_changed", connection: "disconnected" });
            setError(refreshReason instanceof Error
              ? refreshReason.message
              : "Conversation could not be recovered.");
            if (
              refreshReason instanceof ApiError
              && (refreshReason.status === 403 || refreshReason.status === 404)
            ) handlers.current.onUnavailable?.(refreshReason);
          }
          return;
        }
        reconnectCount.current += 1;
        dispatch({ type: "connection_changed", connection: "disconnected" });
        setError(reason instanceof Error ? reason.message : "Conversation updates are unavailable.");
        reconnectTimer.current = window.setTimeout(
          () => void connect(),
          Math.min(5_000, reconnectCount.current * 1_000)
        );
      }
    };

    void connect();
    return () => {
      disposed = true;
      controller?.abort();
      if (streamController.current === controller) streamController.current = undefined;
      if (reconnectTimer.current !== undefined) window.clearTimeout(reconnectTimer.current);
    };
  }, [applySnapshot, clearPreviewTimer, queuePreview, recoverFreshSnapshot, refreshGeneration, scrollToLatest, taskId]);

  useEffect(() => () => clearPreviewTimer(), [clearPreviewTimer]);

  async function loadEarlier() {
    if (!state.nextPageCursor || loadingEarlierRef.current) return;
    const element = viewport.current;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    setHistoryError("");
    dispatch({ type: "reading_started" });
    try {
      const older = await apiClient.getTaskInteractions(taskId, state.nextPageCursor);
      if (element) {
        historyAnchor.current = captureHistoryAnchor(element);
        setAnchorGeneration((value) => value + 1);
      }
      dispatch({
        type: "earlier_prepend",
        items: older.items,
        nextPageCursor: older.nextPageCursor,
        hasMoreBefore: older.hasMoreBefore
      });
    } catch (reason) {
      historyAnchor.current = undefined;
      setHistoryError(reason instanceof Error
        ? reason.message
        : "Earlier conversation history could not be loaded.");
    } finally {
      loadingEarlierRef.current = false;
      setLoadingEarlier(false);
    }
  }

  async function send(content: string) {
    const identity = `${taskId}:${content}`;
    dispatch({ type: "message_send_requested" });
    let receipt: TaskMessageReceipt;
    try {
      receipt = await apiClient.sendTaskMessage(
        taskId,
        content,
        mutationKeysRef.current.key("task-message", identity)
      );
      mutationKeysRef.current.complete("task-message", identity);
    } catch (reason) {
      mutationKeysRef.current.completeApiFailure(reason, "task-message", identity);
      const canonical = reason instanceof ApiError ? reason.presentation ?? undefined : undefined;
      dispatch({ type: "message_rejected", ...(canonical ? { presentation: canonical } : {}) });
      if (canonical) handlers.current.onPresentationChange(canonical);
      if (
        reason instanceof ApiError
        && (
          reason.code === "project_sandbox_capacity_reached"
          || reason.code === "substrate_sandbox_capacity_reached"
          || reason.code === "sandbox_start_failed"
        )
      ) throw reason;
      await recoverMutation(reason);
      throw reason;
    }
    const safeError = taskMessageReceiptError(receipt);
    if (safeError) throw new Error(safeError);
    dispatch({ type: "message_accepted", receipt });
    scrollToLatest();
    void refreshAfterMessageMutation();
  }

  async function updateQueued(messageId: string, content: string) {
    const identity = `${messageId}:${content}`;
    let receipt: TaskMessageReceipt;
    try {
      receipt = await apiClient.updateTaskMessage(
        taskId,
        messageId,
        content,
        mutationKeysRef.current.key("task-message-edit", identity)
      );
      mutationKeysRef.current.complete("task-message-edit", identity);
    } catch (reason) {
      mutationKeysRef.current.completeApiFailure(reason, "task-message-edit", identity);
      const recovered = await recoverMutation(reason);
      if (reason instanceof ApiError && reason.status === 404 && recovered) return;
      throw reason;
    }
    await refreshAfterMessageMutation();
    const safeError = taskMessageReceiptError(receipt);
    if (safeError) throw new Error(safeError);
  }

  async function deleteQueued(messageId: string) {
    let receipt: TaskMessageReceipt;
    try {
      receipt = await apiClient.deleteTaskMessage(
        taskId,
        messageId,
        mutationKeysRef.current.key("task-message-delete", messageId)
      );
      mutationKeysRef.current.complete("task-message-delete", messageId);
    } catch (reason) {
      mutationKeysRef.current.completeApiFailure(reason, "task-message-delete", messageId);
      const recovered = await recoverMutation(reason);
      if (reason instanceof ApiError && reason.status === 404 && recovered) return;
      throw reason;
    }
    await refreshAfterMessageMutation();
    const safeError = taskMessageReceiptError(receipt);
    if (safeError) throw new Error(safeError);
  }

  const refreshAfterMessageMutation = useCallback(async () => {
    const controller = streamController.current;
    streamController.current = undefined;
    streamGeneration.current += 1;
    controller?.abort();
    clearPreviewTimer();
    if (reconnectTimer.current !== undefined) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = undefined;
    }

    try {
      const next = await apiClient.getTaskInteractions(taskId);
      applySnapshot(next);
      badCursorRecoveryUsed.current = false;
      reconnectCount.current = 0;
      setError("");
    } catch (reason) {
      reconnectCount.current = Math.max(1, reconnectCount.current);
      const detail = reason instanceof Error ? ` ${reason.message}` : "";
      setError(
        "Conversation state could not be refreshed after the command completed. "
        + `Reconnecting from the last known update.${detail}`
      );
    } finally {
      setRefreshGeneration((value) => value + 1);
    }
  }, [applySnapshot, clearPreviewTimer, taskId]);

  const recoverMutation = useCallback(async (reason: unknown): Promise<boolean> => {
    if (
      !(reason instanceof ApiError)
      || (reason.status !== 403 && reason.status !== 404 && reason.status !== 409)
    ) return false;
    try {
      await recoverFreshSnapshot();
      return true;
    } catch (refreshReason) {
      if (
        refreshReason instanceof ApiError
        && (refreshReason.status === 403 || refreshReason.status === 404)
      ) handlers.current.onUnavailable?.(refreshReason);
      return false;
    }
  }, [recoverFreshSnapshot]);

  const stopWork = useCallback(async (interactionId: string) => {
    try {
      await apiClient.stopTaskWork(
        taskId,
        interactionId,
        mutationKeysRef.current.key("task-work-stop", interactionId)
      );
      mutationKeysRef.current.complete("task-work-stop", interactionId);
    } catch (reason) {
      mutationKeysRef.current.completeApiFailure(reason, "task-work-stop", interactionId);
      await recoverMutation(reason);
      throw reason;
    }
  }, [recoverMutation, taskId]);

  function retry() {
    reconnectCount.current = 0;
    setError("");
    setRefreshGeneration((value) => value + 1);
  }

  function onScroll() {
    const element = viewport.current;
    if (!element) return;
    if (stateRef.current.followMode === "following" && !isAtBottom(element)) {
      dispatch({ type: "reading_started" });
    }
  }

  function showNewActivity() {
    dispatch({ type: "jump_to_latest" });
    scrollToLatest("smooth");
  }

  if (!state.initialized) {
    const canRetryRuntime = initialSnapshot.presentation.sandboxState.state === "starting"
      || initialSnapshot.presentation.sandboxState.state === "active";
    return (
      <section className="grid h-full min-h-0 flex-1 place-items-center border border-border bg-muted px-5">
        {error ? (
          <div className="max-w-md text-center">
            <Banner
              status="error"
              icon={<CircleAlert size={16} />}
              title="Conversation could not be loaded"
              description={error}
            />
            {canRetryRuntime ? (
              <Button
                className="mt-4"
                label="Retry"
                icon={<RefreshCw size={14} />}
                variant="ghost"
                size="md"
                onClick={retry}
              />
            ) : null}
          </div>
        ) : (
          <Text type="supporting" color="secondary">Loading conversation...</Text>
        )}
      </section>
    );
  }

  const currentPresentation = state.presentation ?? initialSnapshot.presentation;
  const { currentTurn, sandboxState, capabilities } = currentPresentation;
  const runtimeAvailable = sandboxState.state === "starting" || sandboxState.state === "active";
  const unavailableMessage = sandboxState.state === "released"
    ? "Sandbox has been released"
    : sandboxState.state === "failed"
      ? "Sandbox is unavailable"
      : sandboxState.state === "release_requested"
        ? "Sandbox is being released"
        : "Messaging is unavailable";
  const activityLabel = state.newActivityCount === 1
    ? "1 new activity"
    : `${state.newActivityCount} new activities`;

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden border border-border bg-muted"
      aria-label="Task conversation workspace"
    >
      <TaskConnectionNotice
        connection={state.connection}
        historyStatus={state.historyStatus}
        runtimeReachability={state.runtimeReachability}
        runtimeAvailable={runtimeAvailable}
        error={error}
        onRetry={retry}
      />
      {previewUnavailable
        && runtimeAvailable
        && (state.connection === "connected" || state.connection === "recovered") ? (
          <TaskPreviewNotice message={previewUnavailable} onRetry={retry} />
        ) : null}
      <div
        ref={viewport}
        className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5"
        onScroll={onScroll}
      >
        {state.hasMoreBefore ? (
          <div className="mb-4 text-center">
            {historyError ? (
              <Banner
                className="mb-2 text-left"
                status="error"
                title="Earlier messages unavailable"
                description={historyError}
              />
            ) : null}
            <Button
              label={loadingEarlier ? "Loading..." : "Load earlier messages"}
              variant="ghost"
              size="md"
              isDisabled={loadingEarlier}
              onClick={() => void loadEarlier()}
            />
          </div>
        ) : null}
        <TaskInteractionList
          taskId={taskId}
          items={state.items}
          preview={state.preview}
          allowStopWork={capabilities.stopWork}
          onStopWork={stopWork}
        />
      </div>
      {state.followMode === "reading" ? (
        <div className="shrink-0 border-t border-border bg-surface py-2 text-center">
          <Button
            label={state.newActivityCount > 0 ? activityLabel : "Jump to latest"}
            icon={<ChevronDown size={14} />}
            variant="secondary"
            size="md"
            onClick={showNewActivity}
          />
        </div>
      ) : null}
      <TaskComposer
        userId={userId}
        projectId={projectId}
        taskId={taskId}
        activeSandboxesHref={activeSandboxesHref}
        canManagePolicy={canManagePolicy}
        policyHref={policyHref}
        capabilities={capabilities}
        queuedMessages={state.queuedMessages}
        busy={commandBusy}
        unavailableMessage={unavailableMessage}
        onSend={send}
        onUpdateQueued={updateQueued}
        onDeleteQueued={deleteQueued}
      />
    </section>
  );
}

function applyStreamEvent(
  event: TaskInteractionStreamEvent,
  context: {
    dispatch: Dispatch<TaskPresentationAction>;
    clearPreviewTimer: (interactionId?: string) => void;
    queuePreview: (preview: Exclude<TaskAssistantPreview, null>) => void;
    setError: Dispatch<SetStateAction<string>>;
    setPreviewUnavailable: Dispatch<SetStateAction<string>>;
    handlers: MutableRefObject<WorkspaceHandlers>;
    applySnapshot: (snapshot: TaskInteractionSnapshot) => void;
    streamCursor: MutableRefObject<string | undefined>;
    reconnectCount: MutableRefObject<number>;
    badCursorRecoveryUsed: MutableRefObject<boolean>;
    followMode: TaskPresentationState["followMode"];
    scrollToLatest: (behavior?: ScrollBehavior) => void;
  }
) {
  switch (event.type) {
    case "interaction":
      context.streamCursor.current = event.cursor;
      if (event.item.kind === "assistant_message") context.clearPreviewTimer();
      context.dispatch({ type: "interaction_received", item: event.item });
      context.dispatch({ type: "stream_cursor_changed", streamCursor: event.cursor });
      if (context.followMode === "following") context.scrollToLatest();
      if (event.item.kind === "file") context.handlers.current.onArtifactPublished();
      return;
    case "assistant_preview":
      context.queuePreview(event);
      return;
    case "assistant_preview_clear":
      context.clearPreviewTimer(event.interactionId);
      context.dispatch({
        type: "assistant_preview_cleared",
        interactionId: event.interactionId
      });
      return;
    case "state":
      context.dispatch({
        type: "state_received",
        queuedMessages: event.queuedMessages,
        presentation: event.presentation
      });
      context.handlers.current.onPresentationChange(event.presentation);
      return;
    case "connection":
      if (event.connectionState === "connected" || event.connectionState === "recovered") {
        context.reconnectCount.current = 0;
        context.badCursorRecoveryUsed.current = false;
      }
      context.dispatch({
        type: "connection_changed",
        connection: event.connectionState,
        runtimeReachability: event.runtimeReachability,
        historyStatus: event.historyStatus,
        lastSyncedAt: event.lastSyncedAt
      });
      context.setError(event.message ?? "");
      return;
    case "preview_status":
      context.setPreviewUnavailable(
        event.previewStatus === "unavailable"
          ? event.message
            ?? "Live assistant preview is unavailable. Final responses and conversation updates remain available."
          : ""
      );
      return;
    case "reset":
      context.applySnapshot(event.snapshot);
      return;
    case "reconnect":
      context.dispatch({ type: "connection_changed", connection: "reconnecting" });
      return;
    case "done":
      return;
    default:
      return assertNever(event);
  }
}

function captureHistoryAnchor(element: HTMLDivElement): HistoryAnchor | undefined {
  const viewportTop = element.getBoundingClientRect().top;
  const viewportBottom = element.getBoundingClientRect().bottom;
  for (const row of Array.from(element.querySelectorAll<HTMLElement>("[data-interaction-id]"))) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > viewportTop && rect.top < viewportBottom) {
      return {
        interactionId: row.dataset.interactionId!,
        offset: rect.top - viewportTop
      };
    }
  }
  return undefined;
}

function findInteractionRow(
  element: HTMLDivElement,
  interactionId: string
): HTMLElement | undefined {
  return Array.from(element.querySelectorAll<HTMLElement>("[data-interaction-id]"))
    .find((row) => row.dataset.interactionId === interactionId);
}

function isAtBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 96;
}

function assertNever(value: never): never {
  throw new ApiError(502, `Unsupported task interaction stream event: ${String(value)}`);
}
