"use client";

import { ChevronUp, CircleAlert, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { Button } from "@astryxdesign/core";
import type { TaskDetail, TaskInteractionItem, TaskInteractionSnapshot, TaskInteractionStreamEvent, TaskMessageReceipt } from "../../lib/api/client";
import { ApiError, apiClient } from "../../lib/api/client";
import { useTaskMutationKeys } from "./task-mutation-key";
import { TaskComposer } from "./TaskComposer";
import { type AssistantPreview, TaskInteractionList } from "./TaskInteractionList";
import { applyTaskMessageReceipt, isNearHistoryTop, reduceTaskAssistantPreview, retainedHistoryScrollTop, taskMessageReceiptError, upsertTaskInteractions } from "./task-conversation-state";
import { TaskConnectionNotice, TaskPreviewNotice, TaskRunStatus } from "./TaskRunStatus";

type ConnectionState = "connecting" | "reconnecting" | "connected" | "disconnected" | "recovered";

export function TaskConversationWorkspace({ taskId, presentation, onPresentationChange, onProjectionChange, onUnavailable, onArtifactPublished }: { taskId: string; presentation:TaskDetail; onPresentationChange:(presentation:TaskDetail)=>void; onProjectionChange: () => void; onUnavailable?: () => void; onArtifactPublished: () => void }) {
  const mutationKeys = useTaskMutationKeys();
  const viewport = useRef<HTMLDivElement>(null);
  const streamCursor = useRef<string | undefined>(undefined);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const reconnectCount = useRef(0);
  const authoritativeStateVersion = useRef(0);
  const initialScrollPending = useRef(true);
  const loadingEarlierRef = useRef(false);
  const [snapshot, setSnapshot] = useState<TaskInteractionSnapshot>();
  const [items, setItems] = useState<TaskInteractionItem[]>([]);
  const [preview, setPreview] = useState<AssistantPreview>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState("");
  const [previewUnavailable, setPreviewUnavailable] = useState("");
  const [newActivity, setNewActivity] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [aborting, setAborting] = useState(false);
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  const applySnapshot = useCallback((next: TaskInteractionSnapshot) => {
    setSnapshot(next);
    streamCursor.current = next.streamCursor;
    setItems(next.items);
  }, []);

  const load = useCallback(async () => {
    const next = await apiClient.getTaskInteractions(taskId);
    applySnapshot(next);
    onPresentationChange(next.presentation);
    return next;
  }, [applySnapshot,onPresentationChange,taskId]);

  useLayoutEffect(() => {
    if (!snapshot || !initialScrollPending.current) return;
    initialScrollPending.current = false;
    const element = viewport.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [snapshot]);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | undefined;
    const connect = async () => {
      let done = false;
      controller?.abort();
      controller = new AbortController();
      setConnection(reconnectCount.current > 0 ? "reconnecting" : "connecting");
      setPreviewUnavailable("");
      try {
        if (!streamCursor.current) await load();
        if (disposed) return;
        setError("");
        await apiClient.streamTaskInteractions(taskId, streamCursor.current, controller.signal, (event) => {
          if (event.type === "done") done = true;
          if (!disposed) applyStreamEvent(event, { setItems, setPreview, setSnapshot, setConnection, setError, setPreviewUnavailable, setNewActivity, onPresentationChange, onProjectionChange, onArtifactPublished, authoritativeStateVersion, streamCursor, viewport });
        });
        if (disposed || done) return;
        reconnectCount.current += 1;
        reconnectTimer.current = window.setTimeout(() => void connect(), 1_000);
      } catch (reason) {
        if (disposed || controller.signal.aborted) return;
        if (reason instanceof ApiError && (reason.status === 403 || reason.status === 404)) {
          setConnection("disconnected");
          setError(reason.message);
          onUnavailable?.();
          return;
        }
        reconnectCount.current += 1;
        setConnection("disconnected");
        setError(reason instanceof Error ? reason.message : "Conversation updates are unavailable.");
        reconnectTimer.current = window.setTimeout(() => void connect(), Math.min(5_000, reconnectCount.current * 1_000));
      }
    };
    void connect();
    return () => { disposed = true; controller?.abort(); if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current); };
  }, [load, onArtifactPublished, onPresentationChange, onProjectionChange, onUnavailable, refreshGeneration, taskId]);

  async function loadEarlier() {
    if (!snapshot?.nextPageCursor || loadingEarlierRef.current) return;
    const element = viewport.current;
    const previousHeight = element?.scrollHeight ?? 0;
    const previousTop = element?.scrollTop ?? 0;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    setHistoryError("");
    try {
      const older = await apiClient.getTaskInteractions(taskId, snapshot.nextPageCursor);
      setSnapshot((current) => current ? { ...older, items: current.items, queuedMessages: current.queuedMessages, streamCursor: current.streamCursor, runtimeReachability: current.runtimeReachability, historyStatus: current.historyStatus, lastSyncedAt: current.lastSyncedAt, presentation: current.presentation } : older);
      setItems((current) => upsertTaskInteractions(current, older.items));
      requestAnimationFrame(() => { if (element) element.scrollTop = retainedHistoryScrollTop(previousTop, previousHeight, element.scrollHeight); });
    } catch (reason) {
      setHistoryError(reason instanceof Error ? reason.message : "Earlier conversation history could not be loaded.");
    } finally { loadingEarlierRef.current = false; setLoadingEarlier(false); }
  }

  async function send(content: string) {
    const identity = `${taskId}:${content}`;
    const stateVersion = authoritativeStateVersion.current;
    try {
      const receipt = await apiClient.sendTaskMessage(taskId, content, mutationKeys.key("task-message", identity));
      mutationKeys.complete("task-message", identity);
      applyReceipt(receipt, stateVersion);
      onPresentationChange(receipt.presentation);
      const safeError = taskMessageReceiptError(receipt);
      if (safeError) throw new Error(safeError);
      onProjectionChange();
    } catch (reason) { mutationKeys.completeApiFailure(reason, "task-message", identity); await recoverMutation(reason); throw reason; }
  }
  async function updateQueued(messageId: string, content: string) {
    const identity = `${messageId}:${content}`;
    const stateVersion = authoritativeStateVersion.current;
    try {
      const receipt = await apiClient.updateTaskMessage(taskId, messageId, content, mutationKeys.key("task-message-edit", identity));
      mutationKeys.complete("task-message-edit", identity);
      applyReceipt(receipt, stateVersion);
      onPresentationChange(receipt.presentation);
      const safeError = taskMessageReceiptError(receipt);
      if (safeError) throw new Error(safeError);
    } catch (reason) { mutationKeys.completeApiFailure(reason, "task-message-edit", identity); const recovered = await recoverMutation(reason); if (reason instanceof ApiError && reason.status === 404 && recovered) return; throw reason; }
  }
  async function deleteQueued(messageId: string) {
    const stateVersion = authoritativeStateVersion.current;
    try {
      const receipt = await apiClient.deleteTaskMessage(taskId, messageId, mutationKeys.key("task-message-delete", messageId));
      mutationKeys.complete("task-message-delete", messageId);
      applyReceipt(receipt, stateVersion);
      onPresentationChange(receipt.presentation);
      const safeError = taskMessageReceiptError(receipt);
      if (safeError) throw new Error(safeError);
      await load();
    } catch (reason) { mutationKeys.completeApiFailure(reason, "task-message-delete", messageId); const recovered = await recoverMutation(reason); if (reason instanceof ApiError && reason.status === 404 && recovered) return; throw reason; }
  }
  async function recoverMutation(reason: unknown): Promise<boolean> {
    if (!(reason instanceof ApiError) || (reason.status !== 403 && reason.status !== 404 && reason.status !== 409)) return false;
    try { await load(); return true; }
    catch (refreshReason) {
      if (refreshReason instanceof ApiError && (refreshReason.status === 403 || refreshReason.status === 404)) onUnavailable?.();
      return false;
    }
  }
  function applyReceipt(receipt: TaskMessageReceipt, stateVersion: number) {
    if (receipt.interaction) {
      const atBottom = isAtBottom(viewport.current);
      setItems((current) => upsertTaskInteractions(current, [receipt.interaction!]));
      if (atBottom) requestAnimationFrame(() => { const element = viewport.current; if (element) element.scrollTo({ top: element.scrollHeight }); });
      else setNewActivity(true);
    }
    setSnapshot((current) => {
      if (!current) return current;
      const reduced = applyTaskMessageReceipt({ items: [], queuedMessages: current.queuedMessages, presentation: current.presentation }, receipt, stateVersion === authoritativeStateVersion.current);
      return { ...current, queuedMessages: reduced.queuedMessages, presentation: reduced.presentation };
    });
  }
  async function abort() {
    setAborting(true);
    try { await apiClient.abortTaskTurn(taskId, mutationKeys.key("task-turn-abort", taskId)); mutationKeys.complete("task-turn-abort", taskId); onProjectionChange(); }
    catch (reason) { mutationKeys.completeApiFailure(reason, "task-turn-abort", taskId); await recoverMutation(reason); throw reason; }
    finally { setAborting(false); }
  }
  async function stopWork(interactionId: string) {
    try {
      await apiClient.stopTaskWork(taskId, interactionId, mutationKeys.key("task-work-stop", interactionId));
      mutationKeys.complete("task-work-stop", interactionId);
    } catch (reason) { mutationKeys.completeApiFailure(reason, "task-work-stop", interactionId); await recoverMutation(reason); throw reason; }
  }
  function retry() { reconnectCount.current = 0; streamCursor.current = undefined; setError(""); setRefreshGeneration((value) => value + 1); }
  function onScroll() { const element = viewport.current; if (!element) return; if (isNearHistoryTop(element.scrollTop)) void loadEarlier(); if (element.scrollHeight - element.scrollTop - element.clientHeight < 96) setNewActivity(false); }
  function showNewActivity() { const element = viewport.current; if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" }); setNewActivity(false); }

  if (!snapshot) {
    const canRetryRuntime=presentation.sandboxState.state==="starting"||presentation.sandboxState.state==="active";
    return <section className="grid h-full min-h-0 flex-1 place-items-center border border-border bg-surface-low px-5">{error ? <div className="max-w-md text-center" role="alert"><CircleAlert className="mx-auto size-5 text-error" /><p className="mt-2 text-sm font-medium text-foreground">Conversation could not be loaded.</p><p className="mt-1 break-words text-sm text-secondary">{error}</p>{canRetryRuntime?<Button className="mt-4" label="Retry" icon={<RefreshCw size={14} />} variant="ghost" size="md" onClick={retry} />:null}</div> : <p className="text-sm text-secondary">Loading conversation...</p>}</section>;
  }
  const {currentTurn,sandboxState,capabilities}=presentation;
  const runtimeAvailable=sandboxState.state==="starting"||sandboxState.state==="active";
  const unavailableMessage = sandboxState.state === "released" ? "Sandbox has been released" : sandboxState.state === "failed" ? "Sandbox is unavailable" : sandboxState.state === "release_requested" ? "Sandbox is being released" : "Messaging is unavailable";
  return <section className="flex min-h-0 flex-1 flex-col overflow-hidden border border-border bg-surface-low" aria-label="Task conversation workspace"><TaskRunStatus currentTurn={currentTurn} sandboxState={sandboxState} capabilities={capabilities} aborting={aborting} onAbort={abort} /><TaskConnectionNotice connection={connection} historyStatus={snapshot.historyStatus} runtimeReachability={snapshot.runtimeReachability} runtimeAvailable={runtimeAvailable} error={error} onRetry={retry} />{previewUnavailable && runtimeAvailable && (connection === "connected" || connection === "recovered") ? <TaskPreviewNotice message={previewUnavailable} onRetry={retry} /> : null}<div ref={viewport} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5" onScroll={onScroll}>{snapshot.hasMoreBefore ? <div className="mb-4 text-center">{historyError ? <p className="mb-2 text-sm text-error" role="alert">{historyError}</p> : null}<Button label={loadingEarlier ? "Loading..." : "Load earlier messages"} variant="ghost" size="md" isDisabled={loadingEarlier} onClick={() => void loadEarlier()} /></div> : null}<TaskInteractionList taskId={taskId} items={items} preview={preview} allowStopWork={capabilities.stopWork} onStopWork={stopWork} /></div>{newActivity ? <div className="shrink-0 border-t border-border bg-background py-2 text-center"><Button label="New activity" icon={<ChevronUp size={14} />} variant="secondary" size="md" onClick={showNewActivity} /></div> : null}<TaskComposer capabilities={capabilities} queuedMessages={snapshot.queuedMessages} busy={aborting} unavailableMessage={unavailableMessage} onSend={send} onUpdateQueued={updateQueued} onDeleteQueued={deleteQueued} /></section>;
}

function applyStreamEvent(event: TaskInteractionStreamEvent, context: { setItems: Dispatch<SetStateAction<TaskInteractionItem[]>>; setPreview: Dispatch<SetStateAction<AssistantPreview>>; setSnapshot: Dispatch<SetStateAction<TaskInteractionSnapshot | undefined>>; setConnection: Dispatch<SetStateAction<ConnectionState>>; setError: Dispatch<SetStateAction<string>>; setPreviewUnavailable: Dispatch<SetStateAction<string>>; setNewActivity: Dispatch<SetStateAction<boolean>>; onPresentationChange:(presentation:TaskDetail)=>void; onProjectionChange: () => void; onArtifactPublished: () => void; authoritativeStateVersion: MutableRefObject<number>; streamCursor: MutableRefObject<string | undefined>; viewport: RefObject<HTMLDivElement | null> }) {
  switch (event.type) {
    case "interaction": {
      context.streamCursor.current = event.cursor;
      const atBottom = isAtBottom(context.viewport.current);
      context.setItems((current) => upsertTaskInteractions(current, [event.item]));
      context.setPreview((current) => reduceTaskAssistantPreview(current, event));
      if (atBottom) requestAnimationFrame(() => { const viewport = context.viewport.current; if (viewport) viewport.scrollTo({ top: viewport.scrollHeight }); });
      else context.setNewActivity(true);
      context.setSnapshot((current) => current ? { ...current, streamCursor: event.cursor } : current);
      if (event.item.kind === "file") context.onArtifactPublished();
      return;
    }
    case "assistant_preview": context.setPreview((current) => reduceTaskAssistantPreview(current, event)); return;
    case "assistant_preview_clear": context.setPreview((current) => reduceTaskAssistantPreview(current, event)); return;
    case "state": context.authoritativeStateVersion.current += 1; context.setSnapshot((current) => current ? { ...current, queuedMessages:event.queuedMessages, presentation:event.presentation } : current); context.onPresentationChange(event.presentation); return;
    case "connection": context.setSnapshot((current) => current ? { ...current, runtimeReachability:event.runtimeReachability, historyStatus:event.historyStatus, lastSyncedAt:event.lastSyncedAt } : current); context.setConnection((current) => current === "reconnecting" && event.connectionState === "connected" ? "recovered" : event.connectionState); context.setError(event.message ?? ""); return;
    case "preview_status": context.setPreviewUnavailable(event.previewStatus === "unavailable" ? event.message ?? "Live assistant preview is unavailable. Final responses and conversation updates remain available." : ""); return;
    case "reset": context.authoritativeStateVersion.current += 1; context.streamCursor.current = event.snapshot.streamCursor; context.setSnapshot(event.snapshot); context.setItems(event.snapshot.items); context.setPreview((current) => reduceTaskAssistantPreview(current, event)); context.setPreviewUnavailable(""); context.onPresentationChange(event.snapshot.presentation); return;
    case "reconnect": context.setConnection("reconnecting"); return;
    case "done": return;
    default: return assertNever(event);
  }
}

function isAtBottom(element: HTMLDivElement | null): boolean { return !element || element.scrollHeight - element.scrollTop - element.clientHeight < 96; }
function assertNever(value: never): never { throw new ApiError(502, `Unsupported task interaction stream event: ${String(value)}`); }
