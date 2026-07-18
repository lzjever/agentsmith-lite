"use client";

import { ChevronUp, CircleAlert, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import type { TaskCapabilities, TaskInteractionItem, TaskInteractionSnapshot, TaskInteractionStreamEvent, TaskMessageReceipt } from "../../lib/api/client";
import { ApiError, apiClient } from "../../lib/api/client";
import { Button } from "../ui/button";
import { useTaskMutationKeys } from "./task-mutation-key";
import { TaskComposer } from "./TaskComposer";
import { type AssistantPreview, TaskInteractionList } from "./TaskInteractionList";
import { applyTaskMessageReceipt, isNearHistoryTop, reduceTaskAssistantPreview, retainedHistoryScrollTop, taskMessageReceiptError, upsertTaskInteractions } from "./task-conversation-state";
import { TaskConnectionNotice, TaskRunStatus, type TaskRunResult } from "./TaskRunStatus";

type ConnectionState = "connecting" | "reconnecting" | "connected" | "disconnected" | "recovered";

export function TaskConversationWorkspace({ taskId, basePath, taskResult, onCapabilities, onRunState, onUnavailable, onArtifactPublished }: { taskId: string; basePath: string; taskResult?: TaskRunResult; onCapabilities: (capabilities: TaskCapabilities) => void; onRunState?: (runState: TaskInteractionSnapshot["runState"]) => void; onUnavailable?: () => void; onArtifactPublished: () => void }) {
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
  const [newActivity, setNewActivity] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [aborting, setAborting] = useState(false);
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  const applySnapshot = useCallback((next: TaskInteractionSnapshot) => {
    setSnapshot(next);
    onCapabilities(next.capabilities);
    onRunState?.(next.runState);
    streamCursor.current = next.streamCursor;
    setItems(next.items);
  }, [onCapabilities, onRunState]);

  const load = useCallback(async () => {
    const next = await apiClient.getTaskInteractions(taskId);
    applySnapshot(next);
    return next;
  }, [applySnapshot, taskId]);

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
      try {
        if (!streamCursor.current) await load();
        if (disposed) return;
        setError("");
        await apiClient.streamTaskInteractions(taskId, streamCursor.current, controller.signal, (event) => {
          if (event.type === "done") done = true;
          if (!disposed) applyStreamEvent(event, { setItems, setPreview, setSnapshot, setConnection, setError, setNewActivity, onCapabilities, onRunState, onArtifactPublished, authoritativeStateVersion, streamCursor, viewport });
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
  }, [load, onArtifactPublished, onCapabilities, onRunState, onUnavailable, refreshGeneration, taskId]);

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
      setSnapshot((current) => current ? { ...older, items: current.items, queuedMessages: current.queuedMessages, streamCursor: current.streamCursor, runState: current.runState, runtimeReachability: current.runtimeReachability, historyStatus: current.historyStatus, lastSyncedAt: current.lastSyncedAt, capabilities: current.capabilities } : older);
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
      const safeError = taskMessageReceiptError(receipt);
      if (safeError) throw new Error(safeError);
    } catch (reason) { mutationKeys.completeApiFailure(reason, "task-message", identity); await recoverMutation(reason); throw reason; }
  }
  async function updateQueued(messageId: string, content: string) {
    const identity = `${messageId}:${content}`;
    const stateVersion = authoritativeStateVersion.current;
    try {
      const receipt = await apiClient.updateTaskMessage(taskId, messageId, content, mutationKeys.key("task-message-edit", identity));
      mutationKeys.complete("task-message-edit", identity);
      applyReceipt(receipt, stateVersion);
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
      const reduced = applyTaskMessageReceipt({ items: [], queuedMessages: current.queuedMessages, capabilities: current.capabilities }, receipt, stateVersion === authoritativeStateVersion.current);
      return { ...current, queuedMessages: reduced.queuedMessages, capabilities: reduced.capabilities };
    });
    if (stateVersion === authoritativeStateVersion.current) onCapabilities(receipt.capabilities);
  }
  async function abort() {
    setAborting(true);
    try { await apiClient.abortTaskTurn(taskId, mutationKeys.key("task-turn-abort", taskId)); mutationKeys.complete("task-turn-abort", taskId); }
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

  if (!snapshot) return <section className="grid h-full min-h-0 flex-1 place-items-center border border-border bg-surface-low px-5">{error ? <div className="max-w-md text-center" role="alert"><CircleAlert className="mx-auto size-5 text-error" /><p className="mt-2 text-sm font-medium text-foreground">Conversation could not be loaded.</p><p className="mt-1 break-words text-sm text-secondary">{error}</p><Button className="mt-4" variant="quiet" size="sm" onClick={retry}><RefreshCw size={14} />Retry</Button></div> : <p className="text-sm text-secondary">Loading conversation...</p>}</section>;
  return <section className="flex min-h-0 flex-1 flex-col overflow-hidden border border-border bg-surface-low" aria-label="Task conversation workspace"><TaskRunStatus runState={snapshot.runState} {...(taskResult?{taskResult}:{})} capabilities={snapshot.capabilities} aborting={aborting} onAbort={abort} /><TaskConnectionNotice connection={connection} historyStatus={snapshot.historyStatus} runtimeReachability={snapshot.runtimeReachability} error={error} onRetry={retry} /><div ref={viewport} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5" onScroll={onScroll}>{snapshot.hasMoreBefore ? <div className="mb-4 text-center">{historyError ? <p className="mb-2 text-sm text-error" role="alert">{historyError}</p> : null}<Button variant="quiet" size="sm" disabled={loadingEarlier} onClick={() => void loadEarlier()}>{loadingEarlier ? "Loading..." : "Load earlier messages"}</Button></div> : null}<TaskInteractionList taskId={taskId} items={items} preview={preview} basePath={basePath} onStopWork={stopWork} /></div>{newActivity ? <div className="shrink-0 border-t border-border bg-background py-2 text-center"><Button size="sm" onClick={showNewActivity}><ChevronUp size={14} />New activity</Button></div> : null}<TaskComposer capabilities={snapshot.capabilities} queuedMessages={snapshot.queuedMessages} busy={aborting} onSend={send} onUpdateQueued={updateQueued} onDeleteQueued={deleteQueued} /></section>;
}

function applyStreamEvent(event: TaskInteractionStreamEvent, context: { setItems: Dispatch<SetStateAction<TaskInteractionItem[]>>; setPreview: Dispatch<SetStateAction<AssistantPreview>>; setSnapshot: Dispatch<SetStateAction<TaskInteractionSnapshot | undefined>>; setConnection: Dispatch<SetStateAction<ConnectionState>>; setError: Dispatch<SetStateAction<string>>; setNewActivity: Dispatch<SetStateAction<boolean>>; onCapabilities: (capabilities: TaskCapabilities) => void; onRunState: ((runState: TaskInteractionSnapshot["runState"]) => void) | undefined; onArtifactPublished: () => void; authoritativeStateVersion: MutableRefObject<number>; streamCursor: MutableRefObject<string | undefined>; viewport: RefObject<HTMLDivElement | null> }) {
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
    case "state": context.authoritativeStateVersion.current += 1; context.setSnapshot((current) => current ? { ...current, queuedMessages:event.queuedMessages, capabilities:event.capabilities } : current); context.onCapabilities(event.capabilities); return;
    case "run_state": context.setSnapshot((current) => current ? { ...current, runState:event.runState } : current); context.onRunState?.(event.runState); return;
    case "connection": context.setSnapshot((current) => current ? { ...current, runtimeReachability:event.runtimeReachability, historyStatus:event.historyStatus, lastSyncedAt:event.lastSyncedAt } : current); context.setConnection((current) => current === "reconnecting" && event.connectionState === "connected" ? "recovered" : event.connectionState); context.setError(event.message ?? ""); return;
    case "reset": context.authoritativeStateVersion.current += 1; context.streamCursor.current = event.snapshot.streamCursor; context.setSnapshot(event.snapshot); context.setItems(event.snapshot.items); context.setPreview((current) => reduceTaskAssistantPreview(current, event)); context.onCapabilities(event.snapshot.capabilities); context.onRunState?.(event.snapshot.runState); return;
    case "reconnect": context.setConnection("reconnecting"); return;
    case "done": return;
    default: return assertNever(event);
  }
}

function isAtBottom(element: HTMLDivElement | null): boolean { return !element || element.scrollHeight - element.scrollTop - element.clientHeight < 96; }
function assertNever(value: never): never { throw new ApiError(502, `Unsupported task interaction stream event: ${String(value)}`); }
