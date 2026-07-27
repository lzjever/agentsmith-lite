"use client";

import { Banner, Button, Text } from "@astryxdesign/core";
import { ChevronDown, CircleAlert, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from "react";
import type {
  TaskInteractionItem,
  TaskInteractionSnapshot,
  TaskInteractionStreamEvent,
  TaskMessageReceipt
} from "../../lib/api/client";
import { ApiError, apiClient, taskCommandOutcomeError } from "../../lib/api/client";
import { TaskComposer } from "./TaskComposer";
import { TaskInteractionList } from "./TaskInteractionList";
import {
  convergeRequiredTaskRefresh,
  createSingleFlightTaskRefresh,
  taskMessageReceiptError,
  type TaskAssistantPreview,
  type TaskCommandFence,
  type TaskPresentationAction,
  type TaskPresentationDispatch,
  type TaskPresentationState
} from "./task-conversation-state";
import { useTaskMutationKeys } from "./task-mutation-key";
import { TaskConnectionNotice, TaskPreviewNotice } from "./TaskRunStatus";
import {
  clearTaskCommandMetadata,
  persistTaskCommandMetadata,
  readTaskCommandMetadata,
  retireTaskCommandMetadata,
  taskCommandRemountDecision,
  taskRuntimeCommandRemountDecision,
  TaskCommandStorageUnavailableError,
  taskCommandFingerprint,
  type TaskBackgroundWorkStopCommandMetadata
} from "./task-command-storage";
import {
  clearTaskMessageCommandAttempt,
  clearTaskMessageCommandPair,
  persistTaskMessageCommandAttempt,
  restoreTaskDraft,
  taskDraftStorage
} from "./task-draft-snapshot";

type WorkspaceHandlers = {
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
  state,
  dispatch,
  captureCommandFence,
  acceptCanonicalMutation,
  requestCanonicalRefresh,
  commandBusy = false,
  onUnavailable,
  onArtifactPublished
}: {
  taskId: string;
  userId: string;
  projectId: string;
  activeSandboxesHref: string;
  canManagePolicy: boolean;
  policyHref: string;
  state: TaskPresentationState;
  dispatch: TaskPresentationDispatch;
  captureCommandFence: () => TaskCommandFence;
  acceptCanonicalMutation: (
    kind: Extract<TaskPresentationAction, { type: "canonical_mutation_accepted" }>["kind"],
    fence: TaskCommandFence,
    options?: { targetRunId?: string; interaction?: TaskInteractionItem | null }
  ) => TaskPresentationState;
  requestCanonicalRefresh: (quiet?: boolean) => Promise<{
    snapshot: TaskInteractionSnapshot;
    applied: boolean;
  } | undefined>;
  commandBusy?: boolean;
  onUnavailable?: (reason: ApiError) => void;
  onArtifactPublished: () => void;
}) {
  const mutationKeys = useTaskMutationKeys();
  const mutationKeysRef = useRef(mutationKeys);
  mutationKeysRef.current = mutationKeys;

  const handlers = useRef<WorkspaceHandlers>({
    onUnavailable,
    onArtifactPublished
  });
  handlers.current = {
    onUnavailable,
    onArtifactPublished
  };

  const viewport = useRef<HTMLDivElement>(null);
  const streamCursor = useRef<string | undefined>(state.streamCursor);
  const streamController = useRef<AbortController | undefined>(undefined);
  const streamGeneration = useRef(0);
  const streamEventSequence = useRef(0);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const reconnectCount = useRef(0);
  const singleFlightCanonicalRefresh = useRef<ReturnType<
    typeof createSingleFlightTaskRefresh
  > | null>(null);
  singleFlightCanonicalRefresh.current ??= createSingleFlightTaskRefresh();
  const badCursorRecoveryUsed = useRef(false);
  const initialScrollPending = useRef(true);
  const loadingEarlierRef = useRef(false);
  const historyAnchor = useRef<HistoryAnchor | undefined>(undefined);
  const previewTimer = useRef<number | undefined>(undefined);
  const latestPreview = useRef<TaskAssistantPreview>(null);
  const stateRef = useRef<TaskPresentationState>(state);
  stateRef.current = state;
  const restoredStopRoute=useRef<string|null>(null);

  useEffect(() => {
    streamCursor.current = state.streamCursor;
  }, [state.streamCursor]);

  const [error, setError] = useState("");
  const [previewUnavailable, setPreviewUnavailable] = useState("");
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [anchorGeneration, setAnchorGeneration] = useState(0);
  const [messagePayloadLocked, setMessagePayloadLocked] = useState(false);
  const [messageStorageUnavailable, setMessageStorageUnavailable] = useState(false);

  useEffect(() => {
    const storage = taskDraftStorage();
    const identity = { userId, projectId, taskId };
    const metadataRead = readTaskCommandMetadata(
      storage,
      "task-message",
      identity
    );
    if (metadataRead.status === "unavailable") {
      setMessagePayloadLocked(true);
      setMessageStorageUnavailable(true);
      return;
    }
    const draftRead = restoreTaskDraft(storage, identity);
    const draftStatus = draftRead.status === "restored"
      ? "found"
      : draftRead.status === "empty"
        ? "missing"
        : draftRead.status;
    const decision = taskCommandRemountDecision(metadataRead, draftStatus);
    if (decision.status === "locked_unavailable") {
      setMessagePayloadLocked(true);
      setMessageStorageUnavailable(true);
      return;
    }
    if (decision.status === "fresh") {
      mutationKeys.clear("task-message");
      setMessagePayloadLocked(false);
      setMessageStorageUnavailable(false);
      return;
    }
    if (decision.status === "cleanup") {
      const cleared = clearTaskMessageCommandPair(storage, identity);
      if (cleared) mutationKeys.clear("task-message");
      setMessagePayloadLocked(!cleared);
      setMessageStorageUnavailable(!cleared);
      return;
    }
    if (decision.status !== "restore" || draftRead.status !== "restored") return;
    const metadata = decision.metadata;

    let cancelled = false;
    setMessagePayloadLocked(true);
    setMessageStorageUnavailable(false);
    void taskCommandFingerprint({ content: draftRead.draft.trim() }).then((fingerprint) => {
      if (cancelled) return;
      if (fingerprint !== metadata.fingerprint) {
        const cleared = clearTaskMessageCommandPair(storage, identity);
        if (cleared) mutationKeys.clear("task-message");
        setMessagePayloadLocked(!cleared);
        setMessageStorageUnavailable(!cleared);
        return;
      }
      mutationKeys.restore("task-message", taskId, metadata);
    }).catch(() => {
      if (cancelled) return;
      setMessagePayloadLocked(true);
      setMessageStorageUnavailable(true);
    });
    return () => { cancelled = true; };
  }, [mutationKeys, projectId, taskId, userId]);

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

  const applyCanonicalRefreshResult = useCallback((next: TaskInteractionSnapshot) => {
    preserveReadingAnchor();
    clearPreviewTimer();
    streamCursor.current = next.streamCursor;
    setPreviewUnavailable("");
    if (stateRef.current.followMode === "following") scrollToLatest();
  }, [clearPreviewTimer, preserveReadingAnchor, scrollToLatest]);

  const recoverFreshSnapshot = useCallback(async () => {
    const result = await requestCanonicalRefresh(true);
    if (result?.applied) applyCanonicalRefreshResult(result.snapshot);
    return result;
  }, [applyCanonicalRefreshResult, requestCanonicalRefresh]);

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
      streamEventSequence.current = 0;
      controller = nextController;
      streamController.current = nextController;
      dispatch({
        type: "stream_started",
        taskId,
        streamGeneration: generation
      });
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
            const streamSequence = ++streamEventSequence.current;
            applyStreamEvent(event, {
              taskId,
              dispatch,
              streamGeneration: generation,
              streamSequence,
              clearPreviewTimer,
              queuePreview,
              setError,
              setPreviewUnavailable,
              handlers,
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
  }, [clearPreviewTimer, dispatch, queuePreview, recoverFreshSnapshot, refreshGeneration, scrollToLatest, taskId]);

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
        type: "history_prepend_received",
        taskId,
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

  async function send(content: string, submittedDraft: string) {
    const storage = taskDraftStorage();
    const storageIdentity = { userId, projectId, taskId };
    const fingerprint = await taskCommandFingerprint({ content });
    const metadataRead = readTaskCommandMetadata(
      storage,
      "task-message",
      storageIdentity
    );
    if (
      metadataRead.status === "unavailable"
      || metadataRead.status === "corrupt"
    ) {
      setMessagePayloadLocked(true);
      setMessageStorageUnavailable(true);
      throw new TaskCommandStorageUnavailableError();
    }
    const restored = metadataRead.status === "found"
      ? metadataRead.metadata
      : null;
    if (restored) {
      mutationKeysRef.current.restore("task-message", taskId, restored);
    }
    const attempt = mutationKeysRef.current.fingerprintKey(
      "task-message",
      taskId,
      fingerprint
    );
    const metadata = {
      ...storageIdentity,
      ...attempt,
      createdAt: restored?.fingerprint === fingerprint
        ? restored.createdAt
        : new Date().toISOString()
    };
    try {
      persistTaskMessageCommandAttempt(
        storage,
        storageIdentity,
        submittedDraft,
        metadata
      );
    } catch (reason) {
      const retain = restored !== null
        || reason instanceof TaskCommandStorageUnavailableError
          && reason.attemptDisposition === "retain";
      if (retain) {
        setMessagePayloadLocked(true);
        setMessageStorageUnavailable(true);
      } else {
        mutationKeysRef.current.discard("task-message", taskId, attempt);
        setMessagePayloadLocked(false);
      }
      throw reason;
    }
    setMessageStorageUnavailable(false);
    setMessagePayloadLocked(true);
    const commandFence = captureCommandFence();
    const outcome = await apiClient.sendTaskMessage(taskId, content, attempt.key);
    const retireRejection = outcome.outcome === "rejected_before_acceptance"
      && outcome.keyDisposition === "retire";
    if (!retireRejection) {
      mutationKeysRef.current.transition(
        "task-message",
        taskId,
        attempt,
        outcome
      );
    }

    if (outcome.outcome !== "completed") {
      if (retireRejection) {
        if (
          !retireTaskCommandMetadata(
            storage,
            "task-message",
            storageIdentity,
            attempt
          )
        ) {
          setMessagePayloadLocked(true);
          setMessageStorageUnavailable(true);
          throw new TaskCommandStorageUnavailableError("retain");
        }
        mutationKeysRef.current.transition(
          "task-message",
          taskId,
          attempt,
          outcome
        );
        setMessagePayloadLocked(false);
        setMessageStorageUnavailable(false);
      }
      const reason = taskCommandOutcomeError(outcome);
      const canonical = reason instanceof ApiError ? reason.presentation ?? undefined : undefined;
      dispatch({
        type: "canonical_mutation_rejected",
        taskId,
        fence: commandFence,
        ...(canonical ? { presentation: canonical } : {})
      });
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

    const receipt: TaskMessageReceipt = outcome;
    const safeError = taskMessageReceiptError(receipt);
    stateRef.current = acceptCanonicalMutation("message", commandFence, {
      interaction: receipt.interaction
    });
    if (
      !clearTaskMessageCommandAttempt(
        storage,
        storageIdentity,
        attempt,
        submittedDraft
      )
    ) throw new TaskCommandStorageUnavailableError();
    mutationKeysRef.current.canonicalAbsorbed(
      "task-message",
      taskId,
      attempt
    );
    setMessagePayloadLocked(false);
    if (safeError) throw new Error(safeError);
    scrollToLatest();
    void refreshAfterMessageMutation();
  }

  async function updateQueued(messageId: string, content: string) {
    const identity = `${messageId}:${content}`;
    let receipt: TaskMessageReceipt;
    const commandFence = captureCommandFence();
    try {
      receipt = await apiClient.updateTaskMessage(
        taskId,
        messageId,
        content,
        mutationKeysRef.current.key("task-message-edit", identity)
      );
      mutationKeysRef.current.complete("task-message-edit", identity);
      stateRef.current = acceptCanonicalMutation("message_edit", commandFence);
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
    const commandFence = captureCommandFence();
    try {
      receipt = await apiClient.deleteTaskMessage(
        taskId,
        messageId,
        mutationKeysRef.current.key("task-message-delete", messageId)
      );
      mutationKeysRef.current.complete("task-message-delete", messageId);
      stateRef.current = acceptCanonicalMutation("message_delete", commandFence);
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

  const performCanonicalRefresh = useCallback(async () => {
    const controller = streamController.current;
    streamController.current = undefined;
    streamGeneration.current += 1;
    controller?.abort();
    clearPreviewTimer();
    if (reconnectTimer.current !== undefined) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = undefined;
    }

    let applied = false;
    try {
      const result = await requestCanonicalRefresh(true);
      applied = result?.applied === true;
      if (result?.applied) applyCanonicalRefreshResult(result.snapshot);
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
    return applied;
  }, [applyCanonicalRefreshResult, clearPreviewTimer, requestCanonicalRefresh]);

  const runRequiredCanonicalRefresh = useCallback(
    () => singleFlightCanonicalRefresh.current!(async () => {
      const before = stateRef.current;
      const started = dispatch({
        type: "canonical_refresh_started",
        taskId
      });
      stateRef.current = started;
      if (started === before || !started.canonicalRefreshInFlight) return false;
      try {
        return await performCanonicalRefresh();
      } finally {
        stateRef.current = dispatch({
          type: "canonical_refresh_finished",
          taskId
        });
      }
    }),
    [dispatch, performCanonicalRefresh, taskId]
  );

  const refreshAfterMessageMutation = useCallback(
    () => runRequiredCanonicalRefresh().then(() => undefined),
    [runRequiredCanonicalRefresh]
  );

  useEffect(() => {
    if (!state.canonicalRefreshRequired) return;
    let disposed = false;
    let retryTimer: number | undefined;
    let resolveRetry: (() => void) | undefined;

    void convergeRequiredTaskRefresh(
      runRequiredCanonicalRefresh,
      () => !disposed && stateRef.current.canonicalRefreshRequired,
      (delay) => new Promise((resolve) => {
        if (disposed) {
          resolve();
          return;
        }
        resolveRetry = resolve;
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined;
          resolveRetry = undefined;
          resolve();
        }, delay);
      })
    );
    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      retryTimer = undefined;
      resolveRetry?.();
      resolveRetry = undefined;
    };
  }, [runRequiredCanonicalRefresh, state.canonicalRefreshRequired]);

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

  const stopWork = useCallback(async(interactionId:string,restored?:TaskBackgroundWorkStopCommandMetadata)=>{
    const presentation=stateRef.current.presentation;
    const expectedRunId=restored?.request.expectedRunId??presentation?.sandboxState.runId;
    const exactInteractionId=restored?.request.interactionId??interactionId;
    if(!expectedRunId||!exactInteractionId)throw new Error("Background work no longer has an exact Run target.");
    const request={expectedRunId,interactionId:exactInteractionId};
    const fingerprint=JSON.stringify(request);
    const identity={userId,projectId,taskId};
    if(restored&&restored.fingerprint!==fingerprint)throw new Error("Stored background Stop identity is invalid.");
    if(restored)mutationKeysRef.current.restore("task-work-stop",taskId,restored);
    const attempt=mutationKeysRef.current.fingerprintKey("task-work-stop",taskId,fingerprint);
    const commandFence = captureCommandFence();
    try {
      if(!restored)persistTaskCommandMetadata(taskDraftStorage(),"task-work-stop",{
        ...identity,...attempt,request,createdAt:new Date().toISOString()
      });
      const outcome=await apiClient.stopTaskWork(taskId,request,attempt.key);
      mutationKeysRef.current.transition("task-work-stop",taskId,attempt,outcome);
      if(outcome.outcome==="outcome_unknown")throw outcome.error;
      if(outcome.keyDisposition==="retire"){
        retireTaskCommandMetadata(taskDraftStorage(),"task-work-stop",identity,attempt);
        mutationKeysRef.current.canonicalAbsorbed("task-work-stop",taskId,attempt);
      }
      if(outcome.outcome==="rejected_before_acceptance")throw taskCommandOutcomeError(outcome);
      if(outcome.outcome==="completed"&&outcome.result==="conflict"){
        throw new ApiError(409,"The exact background work target is no longer active.",outcome.code);
      }
      stateRef.current = acceptCanonicalMutation("stop", commandFence);
    } catch (reason) {
      await recoverMutation(reason);
      throw reason;
    }
  },[acceptCanonicalMutation,captureCommandFence,projectId,recoverMutation,taskId,userId]);

  useEffect(()=>{
    if(!state.initialized||!state.presentation)return;
    const route=`${userId}:${projectId}:${taskId}`;
    if(restoredStopRoute.current===route)return;
    restoredStopRoute.current=route;
    const storage=taskDraftStorage(),identity={userId,projectId,taskId};
    const decision=taskRuntimeCommandRemountDecision(
      readTaskCommandMetadata(storage,"task-work-stop",identity)
    );
    if(decision.status==="cleanup"){
      clearTaskCommandMetadata(storage,"task-work-stop",identity);
      mutationKeysRef.current.clear("task-work-stop");
      return;
    }
    if(decision.status!=="restore")return;
    const metadata=decision.metadata;
    if(metadata.fingerprint!==JSON.stringify(metadata.request)){
      clearTaskCommandMetadata(storage,"task-work-stop",identity);
      mutationKeysRef.current.clear("task-work-stop");
      return;
    }
    void stopWork(metadata.request.interactionId,metadata).catch(()=>undefined);
  },[projectId,state.initialized,state.presentation,stopWork,taskId,userId]);

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

  const currentPresentation = state.presentation;
  if (!state.initialized || !currentPresentation) {
    const canRetryRuntime = currentPresentation?.sandboxState.state === "starting"
      || currentPresentation?.sandboxState.state === "active";
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
        payloadLocked={messagePayloadLocked}
        storageUnavailable={messageStorageUnavailable}
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
    taskId: string;
    dispatch: TaskPresentationDispatch;
    streamGeneration: number;
    streamSequence: number;
    clearPreviewTimer: (interactionId?: string) => void;
    queuePreview: (preview: Exclude<TaskAssistantPreview, null>) => void;
    setError: Dispatch<SetStateAction<string>>;
    setPreviewUnavailable: Dispatch<SetStateAction<string>>;
    handlers: MutableRefObject<WorkspaceHandlers>;
    streamCursor: MutableRefObject<string | undefined>;
    reconnectCount: MutableRefObject<number>;
    badCursorRecoveryUsed: MutableRefObject<boolean>;
    followMode: TaskPresentationState["followMode"];
    scrollToLatest: (behavior?: ScrollBehavior) => void;
  }
) {
  switch (event.type) {
    case "interaction": {
      context.streamCursor.current = event.cursor;
      if (event.item.kind === "assistant_message") context.clearPreviewTimer();
      context.dispatch({
        type: "interaction_received",
        taskId: context.taskId,
        item: event.item
      });
      context.dispatch({ type: "stream_cursor_changed", streamCursor: event.cursor });
      if (context.followMode === "following") context.scrollToLatest();
      if (event.item.kind === "file") context.handlers.current.onArtifactPublished();
      return;
    }
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
    case "state": {
      context.dispatch({
        type: "stream_state_received",
        taskId: context.taskId,
        streamGeneration: context.streamGeneration,
        streamSequence: context.streamSequence,
        runId: event.presentation.sandboxState.runId,
        queuedMessages: event.queuedMessages,
        presentation: event.presentation
      });
      return;
    }
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
    case "reset": {
      context.streamCursor.current = event.snapshot.streamCursor;
      context.dispatch({
        type: "stream_snapshot_received",
        taskId: context.taskId,
        streamGeneration: context.streamGeneration,
        streamSequence: context.streamSequence,
        snapshot: event.snapshot
      });
      return;
    }
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
