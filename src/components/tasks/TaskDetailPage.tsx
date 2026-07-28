"use client";

import { Archive, ArrowLeft, Info, RefreshCw, TerminalSquare } from "lucide-react";
import { Banner, Button as AstryxButton, Dialog, DialogHeader, Heading, IconButton, Tab, TabList, Text } from "@astryxdesign/core";
import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, restoredTaskReleaseTargetDisposition, taskCommandOutcomeError, type Task, type TaskArtifact, type TaskArtifactKind, type TaskInteractionItem, type TaskInteractionSnapshot } from "../../lib/api/client";
import { appPath } from "../../lib/navigation/app-path";
import { useCurrentUser } from "../app-shell/current-user";
import { DocumentTitle } from "../layout/DocumentTitle";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { RouteLoadingPage } from "../layout/RouteStatePage";
import { TaskArtifactsPanel } from "./TaskArtifactsPanel";
import { TaskConversationWorkspace } from "./TaskConversationWorkspace";
import { TaskLifecycleActions } from "./TaskLifecycleActions";
import { TaskRunStatus } from "./TaskRunStatus";
import { TaskTerminalPanel } from "./TaskTerminalPanel";
import {
  captureTaskCommandFence,
  createSerialTaskRefreshTail,
  createTaskPresentationState,
  reduceTaskPresentationState,
  type TaskCommandFence,
  type TaskPresentationAction
} from "./task-conversation-state";
import { clearTaskDraft, shouldClearTaskDraftForAccessStatus, taskDraftStorage, type TaskDraftIdentity } from "./task-draft-snapshot";
import { useTaskMutationKeys } from "./task-mutation-key";
import {
  clearTaskCommandMetadata,
  persistTaskCommandMetadata,
  readTaskCommandMetadata,
  retireTaskCommandMetadata,
  taskRuntimeCommandRemountDecision,
  type TaskSandboxReleaseCommandMetadata,
  type TaskTurnAbortCommandMetadata
} from "./task-command-storage";
import {
  createTerminalIntentState,
  reduceTerminalIntent
} from "./task-terminal-state";
import {
  canonicalTaskHref,
  taskViewFromSearch,
  type TaskPathScope,
  type TaskWorkspaceView
} from "./task-peer-navigation";

type LoadState = "idle" | "loading" | "ready" | "error";
type TaskLoadState = LoadState | "missing" | "forbidden";
type ArtifactFilter = "all" | TaskArtifactKind;
type ArtifactPageState = {
  items: TaskArtifact[];
  filter: ArtifactFilter;
  cursor: string | null;
  cursorStack: Array<string | null>;
  nextCursor: string | null;
};
type CanonicalRefreshResult =
  | { snapshot: TaskInteractionSnapshot; applied: boolean }
  | { error: unknown };

export function TaskDetailPage({ workspaceId, projectId, taskId }: { workspaceId: string; projectId: string; taskId: string }) {
  return <TaskDetail key={`${workspaceId}:${projectId}:${taskId}`} workspaceId={workspaceId} projectId={projectId} taskId={taskId} />;
}

function TaskDetail({ workspaceId, projectId, taskId }: { workspaceId: string; projectId: string; taskId: string }) {
  const currentUser = useCurrentUser();
  const mounted = useRef(true);
  const mutationKeys = useTaskMutationKeys();
  const [taskPresentation, reactDispatchTaskPresentation] = useReducer(
    reduceTaskPresentationState,
    { taskId },
    createTaskPresentationState
  );
  const taskPresentationRef = useRef(taskPresentation);
  taskPresentationRef.current = taskPresentation;
  const canonicalReadId = useRef(0);
  const canonicalRefreshTail = useRef<ReturnType<typeof createSerialTaskRefreshTail> | null>(null);
  canonicalRefreshTail.current ??= createSerialTaskRefreshTail();
  const [artifactPage, setArtifactPage] = useState<ArtifactPageState>({
    items: [],
    filter: "all",
    cursor: null,
    cursorStack: [],
    nextCursor: null
  });
  const [taskState, setTaskState] = useState<TaskLoadState>("loading");
  const [artifactsState, setArtifactsState] = useState<LoadState>("idle");
  const [taskError, setTaskError] = useState("");
  const [artifactsError, setArtifactsError] = useState("");
  const [mode, setMode] = useState<TaskWorkspaceView>("conversation");
  const [taskPathScope, setTaskPathScope] = useState<TaskPathScope>({
    appBasePath: "",
    workspaceId,
    projectId,
    taskId
  });
  const [canonicalHref, setCanonicalHref] = useState(
    `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`
  );
  const [terminalIntent, dispatchTerminalIntent] = useReducer(
    reduceTerminalIntent,
    undefined,
    createTerminalIntentState
  );
  const [canManagePolicy, setCanManagePolicy] = useState(false);
  const [refreshingArtifacts, setRefreshingArtifacts] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [turnAborting, setTurnAborting] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const taskLoadVersion = useRef(0);
  const restoredReleaseRoute=useRef<string|null>(null);
  const restoredAbortRoute=useRef<string|null>(null);
  const artifactsLoadVersion = useRef(0);
  const taskWorkspaceRef = useRef<HTMLDivElement>(null);
  const detailsTriggerRef = useRef<HTMLButtonElement>(null);
  const basePath = `/workspaces/${workspaceId}/projects/${projectId}/tasks`;
  const draftIdentity: TaskDraftIdentity = {
    userId: currentUser.id,
    projectId,
    taskId
  };

  const dispatchTaskPresentation = useCallback((action: TaskPresentationAction) => {
    const next = reduceTaskPresentationState(taskPresentationRef.current, action);
    taskPresentationRef.current = next;
    reactDispatchTaskPresentation(action);
    return next;
  }, []);

  const captureCommandFence = useCallback(
    () => captureTaskCommandFence(taskPresentationRef.current),
    []
  );

  const acceptCanonicalMutation = useCallback((
    kind: Extract<TaskPresentationAction, { type: "canonical_mutation_accepted" }>["kind"],
    fence: TaskCommandFence,
    options: { targetRunId?: string; interaction?: TaskInteractionItem | null } = {}
  ) => dispatchTaskPresentation({
    type: "canonical_mutation_accepted",
    taskId,
    kind,
    fence,
    ...options
  }), [dispatchTaskPresentation, taskId]);

  const loadSnapshot = useCallback(async (quiet = false) => {
    const version = ++taskLoadVersion.current;
    const readId = ++canonicalReadId.current;
    const baseCanonicalEpoch = taskPresentationRef.current.canonicalEpoch;
    dispatchTaskPresentation({
      type: "canonical_read_started",
      taskId,
      readId,
      baseCanonicalEpoch
    });
    if (!quiet) setTaskState("loading");
    setTaskError("");
    try {
      const snapshot = await apiClient.getTaskInteractions(taskId);
      const detail = snapshot.presentation;
      if (
        !mounted.current
        || version !== taskLoadVersion.current
        || taskPresentationRef.current.latestCanonicalReadId !== readId
      ) return;
      if (detail.task.id !== taskId || detail.task.workspaceId !== workspaceId || detail.task.projectId !== projectId) {
        throw new ApiError(404, "This task does not belong to this project.");
      }
      const before = taskPresentationRef.current;
      const next = dispatchTaskPresentation({
        type: "canonical_snapshot_received",
        taskId,
        readId,
        baseCanonicalEpoch,
        snapshot
      });
      if (next.initialized) setTaskState("ready");
      return {
        snapshot,
        applied: next !== before && next.canonicalEpoch > before.canonicalEpoch
      };
    } catch (reason) {
      if (
        !mounted.current
        || version !== taskLoadVersion.current
        || taskPresentationRef.current.latestCanonicalReadId !== readId
      ) return;
      setTaskError(message(reason));
      if (reason instanceof ApiError && (reason.status === 403 || reason.status === 404)) {
        if (shouldClearTaskDraftForAccessStatus(reason.status)) {
          clearTaskDraft(taskDraftStorage(), draftIdentity);
        }
        setTaskState(reason.status === 404 ? "missing" : "forbidden");
      } else if (!quiet) {
        setTaskState("error");
      }
      return { error: reason };
    }
  }, [currentUser.id, dispatchTaskPresentation, projectId, taskId, workspaceId]);

  const requestCanonicalRefresh = useCallback(
    (quiet = true) => canonicalRefreshTail.current!(() => loadSnapshot(quiet)),
    [loadSnapshot]
  );
  const requestConversationCanonicalRefresh = useCallback(async (
    quiet = true
  ): Promise<Exclude<CanonicalRefreshResult, { error: unknown }> | undefined> => {
    const result: CanonicalRefreshResult | undefined = await requestCanonicalRefresh(quiet);
    if (result && "error" in result) throw result.error;
    return result;
  }, [requestCanonicalRefresh]);

  const loadArtifacts = useCallback(async (quiet = false, options: {
    cursor?: string | null;
    filter?: ArtifactFilter;
    cursorStack?: Array<string | null>;
  } = {}) => {
    const version = ++artifactsLoadVersion.current;
    const cursor = "cursor" in options ? options.cursor ?? null : artifactPage.cursor;
    const filter = options.filter ?? artifactPage.filter;
    const cursorStack = options.cursorStack ?? artifactPage.cursorStack;
    setRefreshingArtifacts(true);
    setArtifactsError("");
    if (!quiet) setArtifactsState("loading");
    try {
      const loaded = await apiClient.taskArtifacts(taskId,{
        ...(cursor?{cursor}:{}),
        ...(filter==="all"?{}:{kind:filter}),
        limit:20
      });
      if (!mounted.current || version !== artifactsLoadVersion.current) return;
      setArtifactPage({
        items: loaded.items,
        filter,
        cursor,
        cursorStack,
        nextCursor: loaded.nextCursor
      });
      setArtifactsState("ready");
    } catch (reason) {
      if (!mounted.current || version !== artifactsLoadVersion.current) return;
      setArtifactsError(message(reason));
      setArtifactsState("error");
      if (reason instanceof ApiError && (reason.status === 403 || reason.status === 404)) {
        await requestCanonicalRefresh(true);
      }
    } finally {
      if (mounted.current && version === artifactsLoadVersion.current) setRefreshingArtifacts(false);
    }
  }, [artifactPage.cursor, artifactPage.cursorStack, artifactPage.filter, requestCanonicalRefresh, taskId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    void requestCanonicalRefresh(false);
  }, [requestCanonicalRefresh]);
  useEffect(() => {
    let disposed = false;
    void apiClient.projectCapabilities(projectId).then((capabilities) => {
      if (!disposed) setCanManagePolicy(capabilities.canManagePolicy);
    }).catch(() => {
      if (!disposed) setCanManagePolicy(false);
    });
    return () => { disposed = true; };
  }, [projectId]);
  useEffect(() => {
    function restoreView() {
      const route = `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
      const appBasePath = window.location.pathname.endsWith(route)
        ? window.location.pathname.slice(0, -route.length)
        : "";
      const scope = { appBasePath, workspaceId, projectId, taskId };
      const view = taskViewFromSearch(window.location.search);
      const href = canonicalTaskHref(scope, view, window.location.hash);
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (current !== href) window.history.replaceState(window.history.state, "", href);
      setTaskPathScope(scope);
      setMode(view);
      setCanonicalHref(href);
      dispatchTerminalIntent({ type: "history_restored" });
    }
    restoreView();
    window.addEventListener("popstate", restoreView);
    return () => window.removeEventListener("popstate", restoreView);
  }, [projectId, taskId, workspaceId]);
  useEffect(() => {
    if(taskState==="ready"&&artifactsState==="idle"&&mode==="artifacts")void loadArtifacts();
  },[artifactsState,loadArtifacts,mode,taskState]);
  async function refresh() {
    dispatchTerminalIntent({ type: "task_refreshed" });
    await requestCanonicalRefresh(true);
    if (artifactsState !== "idle") {
      await loadArtifacts(false, { cursor: null, cursorStack: [] });
    }
  }
  const handleArtifactPublished = useCallback(() => {
    if (artifactsState === "idle") return;
    void loadArtifacts(true, { cursor: null, cursorStack: [] });
  }, [artifactsState, loadArtifacts]);
  const refreshArtifacts = useCallback(async () => {
    await loadArtifacts(false, { cursor: null, cursorStack: [] });
  }, [loadArtifacts]);
  const retryArtifacts = useCallback(async () => {
    await loadArtifacts(false);
  }, [loadArtifacts]);
  const changeArtifactFilter = useCallback(async (filter: ArtifactFilter) => {
    await loadArtifacts(false, { cursor: null, filter, cursorStack: [] });
  }, [loadArtifacts]);
  const nextArtifactPage = useCallback(async () => {
    if (!artifactPage.nextCursor) return;
    await loadArtifacts(false, {
      cursor: artifactPage.nextCursor,
      cursorStack: [...artifactPage.cursorStack, artifactPage.cursor]
    });
  }, [artifactPage.cursor, artifactPage.cursorStack, artifactPage.nextCursor, loadArtifacts]);
  const previousArtifactPage = useCallback(async () => {
    const previous = artifactPage.cursorStack.at(-1);
    if (previous === undefined) return;
    await loadArtifacts(false, {
      cursor: previous,
      cursorStack: artifactPage.cursorStack.slice(0, -1)
    });
  }, [artifactPage.cursorStack, loadArtifacts]);
  const handleConversationUnavailable = useCallback((reason: ApiError) => {
    if (shouldClearTaskDraftForAccessStatus(reason.status)) {
      clearTaskDraft(taskDraftStorage(), draftIdentity);
    }
    setTaskError(reason.message);
    setTaskState(reason.status === 404 ? "missing" : "forbidden");
  }, [currentUser.id, projectId, taskId]);

  async function deleteTask() {
    const detail = taskPresentationRef.current.presentation;
    if (!detail?.capabilities.deleteTask || deleting || releasing || lifecycleBusy) return;
    setDeleting(true);
    try {
      await apiClient.deleteTask(taskId, mutationKeys.key("task-delete", taskId));
      mutationKeys.complete("task-delete", taskId);
      if (!mounted.current) return;
      clearTaskDraft(taskDraftStorage(), draftIdentity);
      window.location.assign(appPath(basePath));
    } catch (reason) {
      if (!mounted.current) return;
      mutationKeys.completeApiFailure(reason, "task-delete", taskId);
      if (isReadOnlyMutationError(reason)) {
        await requestCanonicalRefresh(true);
      }
      throw reason;
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }

  async function abortTaskTurn(restored?:TaskTurnAbortCommandMetadata) {
    const detail = taskPresentationRef.current.presentation;
    if((!restored&&!detail?.capabilities.abortTurn)||turnAborting)return;
    const expectedRunId=restored?.request.expectedRunId??detail?.sandboxState.runId;
    const turnId=restored?.request.turnId??detail?.currentTurn.turnId;
    if(!expectedRunId||!turnId)return;
    const request={expectedRunId,turnId};
    const fingerprint=JSON.stringify(request);
    const identity={userId:currentUser.id,projectId,taskId};
    if(restored&&restored.fingerprint!==fingerprint)return;
    if(restored)mutationKeys.restore("task-turn-abort",taskId,restored);
    const attempt=mutationKeys.fingerprintKey("task-turn-abort",taskId,fingerprint);
    const fence = captureCommandFence();
    setTurnAborting(true);
    try {
      if(!restored)persistTaskCommandMetadata(taskDraftStorage(),"task-turn-abort",{
        ...identity,...attempt,request,createdAt:new Date().toISOString()
      });
      const outcome=await apiClient.abortTaskTurn(taskId,request,attempt.key);
      mutationKeys.transition("task-turn-abort",taskId,attempt,outcome);
      if(outcome.outcome==="outcome_unknown")throw outcome.error;
      if(outcome.keyDisposition==="retire"){
        retireTaskCommandMetadata(taskDraftStorage(),"task-turn-abort",identity,attempt);
        mutationKeys.canonicalAbsorbed("task-turn-abort",taskId,attempt);
      }
      if(outcome.outcome==="rejected_before_acceptance")throw taskCommandOutcomeError(outcome);
      if(outcome.outcome==="completed"&&outcome.result==="conflict"){
        throw new ApiError(409,"The exact turn is no longer active.",outcome.code);
      }
      acceptCanonicalMutation("abort", fence);
    } catch (reason) {
      if (
        reason instanceof ApiError
        && (reason.status === 403 || reason.status === 404 || reason.status === 409)
      ) await requestCanonicalRefresh(true);
      throw reason;
    } finally {
      if (mounted.current) setTurnAborting(false);
    }
  }

  useEffect(()=>{
    if(!taskPresentation.initialized||!taskPresentation.presentation)return;
    const route=`${currentUser.id}:${projectId}:${taskId}`;
    if(restoredAbortRoute.current===route)return;
    restoredAbortRoute.current=route;
    const storage=taskDraftStorage(),identity={userId:currentUser.id,projectId,taskId};
    const decision=taskRuntimeCommandRemountDecision(
      readTaskCommandMetadata(storage,"task-turn-abort",identity)
    );
    if(decision.status==="cleanup"){
      clearTaskCommandMetadata(storage,"task-turn-abort",identity);
      mutationKeys.clear("task-turn-abort");
      return;
    }
    if(decision.status!=="restore")return;
    const metadata=decision.metadata;
    if(metadata.fingerprint!==JSON.stringify(metadata.request)){
      clearTaskCommandMetadata(storage,"task-turn-abort",identity);
      mutationKeys.clear("task-turn-abort");
      return;
    }
    void abortTaskTurn(metadata).catch(()=>undefined);
  },[currentUser.id,mutationKeys,projectId,taskId,taskPresentation.initialized,taskPresentation.presentation]);

  async function releaseSandbox(expectedRunId:string,restored?:TaskSandboxReleaseCommandMetadata) {
    const detail = taskPresentationRef.current.presentation;
    if ((!restored&&!detail?.capabilities.releaseSandbox) || releasing || deleting || lifecycleBusy) return;
    const targetRunId=restored?.request.expectedRunId??expectedRunId;
    const request={expectedRunId:targetRunId};
    const fingerprint=JSON.stringify(request);
    const identity={userId:currentUser.id,projectId,taskId};
    if(restored&&restored.fingerprint!==fingerprint)return;
    if(restored&&restoredTaskReleaseTargetDisposition(detail?.sandboxState.runId??null,targetRunId)==="retire"){
      mutationKeys.restore("task-sandbox-release",taskId,restored);
      retireTaskCommandMetadata(taskDraftStorage(),"task-sandbox-release",identity,restored);
      mutationKeys.canonicalAbsorbed("task-sandbox-release",taskId,restored);
      if(mounted.current)await requestCanonicalRefresh(true);
      return;
    }
    const fence = captureCommandFence();
    if(restored)mutationKeys.restore("task-sandbox-release",taskId,restored);
    const attempt=mutationKeys.fingerprintKey("task-sandbox-release",taskId,fingerprint);
    setReleasing(true);
    try {
      if(!restored)persistTaskCommandMetadata(taskDraftStorage(),"task-sandbox-release",{
        ...identity,...attempt,request,createdAt:new Date().toISOString()
      });
      const outcome=await apiClient.releaseTaskSandbox(taskId,request,attempt.key);
      mutationKeys.transition("task-sandbox-release",taskId,attempt,outcome);
      if(outcome.outcome==="outcome_unknown")throw outcome.error;
      if(outcome.outcome==="rejected_before_acceptance"){
        retireTaskCommandMetadata(taskDraftStorage(),"task-sandbox-release",identity,attempt);
        throw taskCommandOutcomeError(outcome);
      }
      if(outcome.outcome==="accepted_in_progress"){
        if(mounted.current)await requestCanonicalRefresh(true);
        return;
      }
      retireTaskCommandMetadata(taskDraftStorage(),"task-sandbox-release",identity,attempt);
      mutationKeys.canonicalAbsorbed("task-sandbox-release",taskId,attempt);
      if (!mounted.current) return;
      acceptCanonicalMutation("release", fence);
    } catch (reason) {
      if (!mounted.current) return;
      if (
        reason instanceof ApiError
        && (reason.status === 403 || reason.status === 404 || reason.status === 409)
      ) await requestCanonicalRefresh(true);
      throw reason;
    } finally {
      if (mounted.current) setReleasing(false);
    }
  }

  useEffect(()=>{
    if(!taskPresentation.initialized||!taskPresentation.presentation)return;
    const route=`${currentUser.id}:${projectId}:${taskId}`;
    if(restoredReleaseRoute.current===route)return;
    restoredReleaseRoute.current=route;
    const storage=taskDraftStorage(),identity={userId:currentUser.id,projectId,taskId};
    const decision=taskRuntimeCommandRemountDecision(
      readTaskCommandMetadata(storage,"task-sandbox-release",identity)
    );
    if(decision.status==="cleanup"){
      clearTaskCommandMetadata(storage,"task-sandbox-release",identity);
      mutationKeys.clear("task-sandbox-release");
      return;
    }
    if(decision.status!=="restore")return;
    const metadata=decision.metadata;
    if(metadata.fingerprint!==JSON.stringify(metadata.request)){
      clearTaskCommandMetadata(storage,"task-sandbox-release",identity);
      mutationKeys.clear("task-sandbox-release");
      return;
    }
    void releaseSandbox(metadata.request.expectedRunId,metadata).catch(()=>undefined);
  },[currentUser.id,mutationKeys,projectId,taskId,taskPresentation.initialized,taskPresentation.presentation]);

  if (taskState === "loading") return <RouteLoadingPage title="Task" />;
  if (taskState === "missing") return <TaskLoadFailure title="Task not found" detail="This task does not exist or is no longer available." basePath={basePath} />;
  if (taskState === "forbidden") return <TaskLoadFailure title="Task unavailable" detail="You no longer have permission to access this task." basePath={basePath} />;
  if (taskState === "error") return <TaskLoadFailure title="Task unavailable" detail={taskError} basePath={basePath} onRetry={() => void requestCanonicalRefresh(false)} />;
  const detail = taskPresentation.presentation;
  if (!detail || !taskPresentation.initialized) return null;

  const { task, capabilities, lifecycle, sandboxState } = detail;
  const mutationBusy = deleting || releasing || lifecycleBusy || turnAborting;
  const releaseLabel=sandboxState.state==="failed"||sandboxState.state==="release_requested"?"Retry release":"Release sandbox";
  const artifactsPanel = <ArtifactsSection taskId={taskId} artifacts={artifactPage.items} state={artifactsState} error={artifactsError} refreshing={refreshingArtifacts} filter={artifactPage.filter} hasNext={artifactPage.nextCursor !== null} hasPrevious={artifactPage.cursorStack.length > 0} onFilterChange={changeArtifactFilter} onNext={nextArtifactPage} onPrevious={previousArtifactPage} onRefresh={refreshArtifacts} onRetry={retryArtifacts} />;
  const taskRefreshError = taskError ? <SectionError title="Task status refresh failed" message={taskError} onRetry={async () => {
    await requestCanonicalRefresh(true);
  }} /> : null;
  const archivedNotice = lifecycle.state === "archived" ? <Banner status="info" icon={<Archive size={16} />} title="Task archived" description="Its conversation, files, and artifacts remain available." /> : null;
  const sandboxFailureNotice = sandboxState.state === "failed"
    ? <Banner status="error" title="Sandbox unavailable" description={sandboxState.cause?.message ?? "Release the failed Sandbox before continuing this Task."} />
    : null;
  const filesHref = `/workspaces/${workspaceId}/projects/${projectId}/files?${new URLSearchParams({ libraryId: task.fileLibraryId, returnTo: canonicalHref })}`;
  const changeDetailsOpen = (open: boolean) => {
    setDetailsOpen(open);
    if (!open) requestAnimationFrame(() => detailsTriggerRef.current?.focus({ preventScroll: true }));
  };
  const selectWorkspaceMode = (next: string) => {
    if (next !== "conversation" && next !== "terminal" && next !== "artifacts") return;
    const href = canonicalTaskHref(taskPathScope, next, window.location.hash);
    window.history.pushState(window.history.state, "", href);
    setMode(next);
    setCanonicalHref(href);
    dispatchTerminalIntent({
      type: next === "terminal" ? "terminal_selected" : "view_left"
    });
  };
  return <PageLayout contentWidth="full" density="immersive" height="fill">
    <DocumentTitle title={task.title?.trim() || "Task"} />
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <header className="shrink-0 border border-border bg-surface" aria-label="Task workbench">
        <div className="flex min-h-12 min-w-0 flex-nowrap items-center gap-2 overflow-x-auto border-b border-border px-2 sm:px-3">
          <Link className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-sm text-secondary no-underline hover:bg-overlay-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" href={basePath} aria-label="Back to Tasks" title="Back to Tasks"><ArrowLeft size={17} /></Link>
          <div className="min-w-20 flex-1">
            <div className="min-w-0" title={task.title?.trim() || "Task"}><Heading level={1} style={{ fontSize: "var(--text-heading-3-size)", lineHeight: "var(--text-heading-3-leading)" }} className="truncate">{task.title?.trim() || "Task"}</Heading></div>
            <div className="hidden min-w-0 lg:block" title={task.id}><Text type="code" color="secondary" display="block" className="truncate">{task.id}</Text></div>
          </div>
          <TaskRunStatus currentTurn={detail.currentTurn} sandboxState={detail.sandboxState} capabilities={capabilities} aborting={turnAborting} onAbort={abortTaskTurn} />
          <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-1">
            <IconButton ref={detailsTriggerRef} label="Task details" tooltip="Task details" variant="ghost" size="lg" icon={<Info size={16} />} onClick={() => setDetailsOpen(true)} />
            <IconButton label="Refresh task" tooltip="Refresh task" variant="ghost" size="lg" icon={<RefreshCw size={17} />} isDisabled={mutationBusy} onClick={() => void refresh()} />
            <TaskLifecycleActions task={task} capabilities={capabilities} releaseRunId={sandboxState.runId} releaseLabel={releaseLabel} onRefresh={async () => {
              await requestCanonicalRefresh(true);
            }} onRelease={releaseSandbox} onDelete={deleteTask} disabled={turnAborting} onBusyChange={setLifecycleBusy} />
          </div>
        </div>
        <TabList value={mode} onChange={selectWorkspaceMode} aria-label="Task workspace views" className="min-w-0 shrink-0 overflow-x-auto px-2 sm:px-3">
          <Tab value="conversation" label="Conversation" />
          <Tab value="terminal" label="Terminal" icon={<TerminalSquare size={14} />} />
          <Tab value="artifacts" label="Artifacts" />
        </TabList>
      </header>
      {taskRefreshError ? <div className="shrink-0 pt-2">{taskRefreshError}</div> : null}
      {archivedNotice ? <div className="shrink-0 pt-2">{archivedNotice}</div> : null}
      {sandboxFailureNotice ? <div className="shrink-0 pt-2">{sandboxFailureNotice}</div> : null}
      <div ref={taskWorkspaceRef} tabIndex={-1} className="grid min-h-0 min-w-0 flex-1 overflow-hidden pt-2 outline-none" data-testid="task-workspace">
        <div className={`${mode === "conversation" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col`}><TaskConversationWorkspace taskId={taskId} userId={currentUser.id} projectId={projectId} activeSandboxesHref={`/workspaces/${workspaceId}/projects/${projectId}/usage#sandbox-usage`} canManagePolicy={canManagePolicy} policyHref={`/workspaces/${workspaceId}/projects/${projectId}/policy`} state={taskPresentation} dispatch={dispatchTaskPresentation} captureCommandFence={captureCommandFence} acceptCanonicalMutation={acceptCanonicalMutation} requestCanonicalRefresh={requestConversationCanonicalRefresh} commandBusy={turnAborting} onUnavailable={handleConversationUnavailable} onArtifactPublished={handleArtifactPublished} /></div>
        {mode === "terminal" ? <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden"><TaskTerminalPanel taskId={taskId} userId={currentUser.id} projectId={projectId} presentation={detail} canonicalEpoch={taskPresentation.canonicalEpoch} intent={terminalIntent} activeSandboxesHref={`/workspaces/${workspaceId}/projects/${projectId}/usage#sandbox-usage`} canManagePolicy={canManagePolicy} policyHref={`/workspaces/${workspaceId}/projects/${projectId}/policy`} onIntent={dispatchTerminalIntent} captureCommandFence={captureCommandFence} acceptCanonicalMutation={acceptCanonicalMutation} requestCanonicalRefresh={requestCanonicalRefresh} /></div> : null}
        <section className={`${mode === "artifacts" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col overflow-hidden border border-border bg-surface`} aria-label="Task Artifacts"><div className="shrink-0 border-b border-border px-3 py-3"><Heading level={4} accessibilityLevel={2}>Artifacts</Heading></div><div className="min-h-0 flex-1 overflow-y-auto p-3">{artifactsPanel}</div></section>
      </div>
    </div>
    <Dialog
      className="[&_button]:min-h-11 [&_button]:min-w-11"
      isOpen={detailsOpen}
      onOpenChange={changeDetailsOpen}
      purpose="info"
      padding={0}
      width="min(42rem, calc(100dvw - 1rem))"
      maxHeight="calc(100dvh - 1rem)"
      aria-label="Task details"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DialogHeader title="Task details" subtitle={task.id} hasDivider onOpenChange={changeDetailsOpen} />
        <div className="min-h-0 min-w-0 flex-1 space-y-6 overflow-y-auto p-4 sm:p-5">
          <TaskWorkspaceSummary task={task} filesHref={filesHref} />
          <div><Heading level={6} accessibilityLevel={3}>Original prompt</Heading><Text display="block" type="supporting" color="secondary" className="mt-2 whitespace-pre-wrap break-words">{task.prompt}</Text></div>
        </div>
      </div>
    </Dialog>
  </PageLayout>;
}

function TaskLoadFailure({ title, detail, basePath, onRetry }: { title: string; detail: string; basePath: string; onRetry?: () => void }) {
  const actions = <div className="mt-5 flex flex-wrap justify-center gap-2"><Link className="inline-flex min-h-9 items-center gap-2 rounded-sm border border-border px-3 no-underline hover:text-primary" href={basePath}><ArrowLeft size={16} /><Text type="supporting" color="secondary">All tasks</Text></Link>{onRetry ? <AstryxButton label="Try again" variant="secondary" onClick={onRetry} /> : null}</div>;
  return <PageLayout header={<PageHeader title={title} />}>{onRetry ? <><Banner status="error" container="section" title={`${title} unavailable`} description={detail} />{actions}</> : <div className="flex min-h-48 flex-col items-center justify-center px-4 py-6 text-center"><Text display="block" type="supporting" color="secondary">{detail}</Text>{actions}</div>}</PageLayout>;
}

function ArtifactsSection({ taskId, artifacts, state, error, refreshing, filter, hasNext, hasPrevious, emptyMessage, onFilterChange, onNext, onPrevious, onRefresh, onRetry }: {
  taskId:string;artifacts:TaskArtifact[];state:LoadState;error:string;refreshing:boolean;filter:ArtifactFilter;hasNext:boolean;hasPrevious:boolean;emptyMessage?:string;
  onFilterChange:(filter:ArtifactFilter)=>Promise<void>;onNext:()=>Promise<void>;onPrevious:()=>Promise<void>;onRefresh:()=>Promise<void>;onRetry:()=>Promise<void>;
}) {
  if ((state === "idle"||state==="loading") && artifacts.length === 0) return <Text display="block" type="supporting" color="secondary" className="py-6 text-center">Loading artifacts...</Text>;
  if (state === "error" && artifacts.length === 0) return <SectionError title="Artifacts unavailable" message={error} onRetry={onRetry} />;
  return <>{error ? <Banner className="mb-3" status="error" title="Artifacts could not be refreshed" description={error} /> : null}<TaskArtifactsPanel taskId={taskId} artifacts={artifacts} filter={filter} hasNext={hasNext} hasPrevious={hasPrevious} onFilterChange={onFilterChange} onNext={onNext} onPrevious={onPrevious} onRefresh={onRefresh} refreshing={refreshing} {...(emptyMessage ? { emptyMessage } : {})} /></>;
}

function TaskWorkspaceSummary({ task, filesHref }: { task: Task; filesHref: string }) {
  return <div><Heading level={6} accessibilityLevel={3}>Workspace</Heading><dl className="mt-2 grid gap-2"><TaskDetailValue label="File Library"><Link className="break-all text-primary hover:underline" href={filesHref}><Text type="code">{task.fileLibraryId}</Text></Link></TaskDetailValue><TaskDetailValue label="Endpoint"><Text type="code">{task.endpointId}</Text></TaskDetailValue></dl></div>;
}

function TaskDetailValue({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2"><dt><Text type="supporting" color="secondary">{label}</Text></dt><dd className="min-w-0"><Text as="div" type="supporting" color="secondary">{children}</Text></dd></div>;
}

function SectionError({ title, message: detail, onRetry }: { title: string; message: string; onRetry: () => Promise<void> }) {
  return <div><Banner status="error" title={title} description={detail} /><AstryxButton label="Try again" className="mt-3" variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void onRetry()} /></div>;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The task request could not be completed.";
}
