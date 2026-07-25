"use client";

import { Archive, ArrowLeft, Power, RefreshCw, TerminalSquare, Trash2 } from "lucide-react";
import { Banner, Button as AstryxButton, Collapsible, Dialog, DialogHeader, Heading, IconButton, Tab, TabList, Text } from "@astryxdesign/core";
import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import type { TaskDetail as TaskDetailProjection, TaskInteractionSnapshot } from "../../lib/api/client";
import { ApiError, apiClient, isReadOnlyMutationError, type Task, type TaskArtifact, type TaskArtifactKind } from "../../lib/api/client";
import { appPath } from "../../lib/navigation/app-path";
import { useCurrentUser } from "../app-shell/current-user";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { RouteLoadingPage } from "../layout/RouteStatePage";
import { TaskArtifactsPanel } from "./TaskArtifactsPanel";
import { TaskConversationWorkspace } from "./TaskConversationWorkspace";
import { TaskLifecycleActions } from "./TaskLifecycleActions";
import { TaskTerminalPanel } from "./TaskTerminalPanel";
import { clearTaskDraft, shouldClearTaskDraftForAccessStatus, taskDraftStorage, type TaskDraftIdentity } from "./task-draft-snapshot";
import { useTaskMutationKeys } from "./task-mutation-key";
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

export function TaskDetailPage({ workspaceId, projectId, taskId }: { workspaceId: string; projectId: string; taskId: string }) {
  return <TaskDetail key={`${workspaceId}:${projectId}:${taskId}`} workspaceId={workspaceId} projectId={projectId} taskId={taskId} />;
}

function TaskDetail({ workspaceId, projectId, taskId }: { workspaceId: string; projectId: string; taskId: string }) {
  const currentUser = useCurrentUser();
  const mounted = useRef(true);
  const mutationKeys = useTaskMutationKeys();
  const [detail, setDetail] = useState<TaskDetailProjection>();
  const [interactionSnapshot, setInteractionSnapshot] = useState<TaskInteractionSnapshot>();
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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const taskLoadVersion = useRef(0);
  const artifactsLoadVersion = useRef(0);
  const taskWorkspaceRef = useRef<HTMLDivElement>(null);
  const basePath = `/workspaces/${workspaceId}/projects/${projectId}/tasks`;
  const draftIdentity: TaskDraftIdentity = {
    userId: currentUser.id,
    projectId,
    taskId
  };

  const loadSnapshot = useCallback(async (quiet = false) => {
    const version = ++taskLoadVersion.current;
    if (!quiet) setTaskState("loading");
    setTaskError("");
    try {
      const snapshot = await apiClient.getTaskInteractions(taskId);
      const detail = snapshot.presentation;
      if (!mounted.current || version !== taskLoadVersion.current) return;
      if (detail.task.id !== taskId || detail.task.workspaceId !== workspaceId || detail.task.projectId !== projectId) {
        throw new ApiError(404, "This task does not belong to this project.");
      }
      setDetail(detail);
      setInteractionSnapshot(snapshot);
      setTaskState("ready");
    } catch (reason) {
      if (!mounted.current || version !== taskLoadVersion.current) return;
      setTaskError(message(reason));
      if (reason instanceof ApiError && (reason.status === 403 || reason.status === 404)) {
        if (shouldClearTaskDraftForAccessStatus(reason.status)) {
          clearTaskDraft(taskDraftStorage(), draftIdentity);
        }
        setDetail(undefined);
        setInteractionSnapshot(undefined);
        setTaskState(reason.status === 404 ? "missing" : "forbidden");
      } else if (!quiet) {
        setTaskState("error");
      }
    }
  }, [currentUser.id, projectId, taskId, workspaceId]);

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
        await loadSnapshot(true);
      }
    } finally {
      if (mounted.current && version === artifactsLoadVersion.current) setRefreshingArtifacts(false);
    }
  }, [artifactPage.cursor, artifactPage.cursorStack, artifactPage.filter, loadSnapshot, taskId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);
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
  useEffect(() => {
    if (!detail?.capabilities.releaseSandbox) setReleaseOpen(false);
  }, [detail?.capabilities.releaseSandbox]);

  async function refresh() {
    dispatchTerminalIntent({ type: "task_refreshed" });
    await loadSnapshot(true);
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
    setDetail(undefined);
    setInteractionSnapshot(undefined);
    setTaskState(reason.status === 404 ? "missing" : "forbidden");
  }, [currentUser.id, projectId, taskId]);
  const handlePresentationChange=useCallback((presentation:TaskDetailProjection)=>{setDetail(presentation);},[]);

  async function deleteTask() {
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
        setDetail((current) => current ? { ...current, capabilities:{ ...current.capabilities, deleteTask:false } } : current);
        setDeleteOpen(false);
        await loadSnapshot(true);
      }
      throw reason;
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }

  async function releaseSandbox() {
    if (!detail?.capabilities.releaseSandbox || releasing || deleting || lifecycleBusy) return;
    setReleasing(true);
    try {
      const receipt = await apiClient.releaseTaskSandbox(taskId, mutationKeys.key("task-sandbox-release", taskId));
      mutationKeys.complete("task-sandbox-release", taskId);
      if (!mounted.current) return;
      setDetail(receipt.presentation);
    } catch (reason) {
      if (!mounted.current) return;
      mutationKeys.completeApiFailure(reason, "task-sandbox-release", taskId);
      if (
        reason instanceof ApiError
        && (reason.status === 403 || reason.status === 404 || reason.status === 409)
      ) await loadSnapshot(true);
      throw reason;
    } finally {
      if (mounted.current) setReleasing(false);
    }
  }

  if (taskState === "loading") return <RouteLoadingPage title="Task" />;
  if (taskState === "missing") return <TaskLoadFailure title="Task not found" detail="This task does not exist or is no longer available." basePath={basePath} />;
  if (taskState === "forbidden") return <TaskLoadFailure title="Task unavailable" detail="You no longer have permission to access this task." basePath={basePath} />;
  if (taskState === "error") return <TaskLoadFailure title="Task unavailable" detail={taskError} basePath={basePath} onRetry={() => void loadSnapshot()} />;
  if (!detail || !interactionSnapshot) return null;

  const { task, capabilities, lifecycle, sandboxState } = detail;
  const mutationBusy = deleting || releasing || lifecycleBusy;
  const releaseLabel=sandboxState.state==="failed"||sandboxState.state==="release_requested"?"Retry release":"Release sandbox";
  const header = <PageHeader variant="compact" title={task.title?.trim() || "Task detail"} subtitle={task.id} actions={<><IconButton label="Refresh task" tooltip="Refresh task" variant="ghost" icon={<RefreshCw size={17} />} isDisabled={mutationBusy} onClick={() => void refresh()} /><TaskLifecycleActions task={task} capabilities={capabilities} onRefresh={() => loadSnapshot(true)} disabled={deleting || releasing} onBusyChange={setLifecycleBusy} />{capabilities.releaseSandbox ? <AstryxButton label={releaseLabel} variant="destructive" size="sm" icon={<Power size={15} />} isDisabled={mutationBusy} onClick={() => setReleaseOpen(true)} /> : null}{capabilities.deleteTask ? <IconButton label="Delete task" tooltip="Delete task" variant="destructive" icon={<Trash2 size={16} />} isDisabled={mutationBusy} onClick={() => setDeleteOpen(true)} /> : null}</>} />;
  const artifactsPanel = <ArtifactsSection taskId={taskId} artifacts={artifactPage.items} state={artifactsState} error={artifactsError} refreshing={refreshingArtifacts} filter={artifactPage.filter} hasNext={artifactPage.nextCursor !== null} hasPrevious={artifactPage.cursorStack.length > 0} onFilterChange={changeArtifactFilter} onNext={nextArtifactPage} onPrevious={previousArtifactPage} onRefresh={refreshArtifacts} onRetry={retryArtifacts} />;
  const taskRefreshError = taskError ? <SectionError title="Task status refresh failed" message={taskError} onRetry={() => loadSnapshot(true)} /> : null;
  const archivedNotice = lifecycle.state === "archived" ? <Banner status="info" icon={<Archive size={16} />} title="Task archived" description="Its conversation, files, and artifacts remain available." /> : null;
  const releaseDialog = <TaskActionDialog idPrefix="task-sandbox-release" open={releaseOpen} onOpenChange={setReleaseOpen} title={`${releaseLabel}?`} description="Releasing stops the agent, Terminal, tools, and processes unconditionally, which may lose unsaved information. The Task conversation, Library files, and published Artifacts remain available." actionLabel={releaseLabel} loading={releasing} onAction={releaseSandbox} onActionComplete={() => taskWorkspaceRef.current?.focus({ preventScroll: true })} errorTitle="Sandbox could not be released" />;
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
  return <PageLayout header={header} contentWidth="full" density="immersive" height="fill">
    <Link className="inline-flex w-fit shrink-0 items-center gap-2 hover:text-primary" href={basePath}><ArrowLeft size={16} /><Text type="supporting" color="secondary">All tasks</Text></Link>
    {taskRefreshError}
    {archivedNotice}
    <TabList value={mode} onChange={selectWorkspaceMode} aria-label="Task workspace views" hasDivider className="shrink-0 flex-wrap gap-2">
      <Tab value="conversation" label="Conversation" />
      <Tab value="terminal" label="Terminal" icon={<TerminalSquare size={14} />} />
      <Tab value="artifacts" label="Artifacts" />
    </TabList>
    <div ref={taskWorkspaceRef} tabIndex={-1} className="grid min-h-0 min-w-0 flex-1 overflow-hidden outline-none" data-testid="task-workspace">
      <div className={`${mode === "conversation" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col`}><TaskConversationWorkspace taskId={taskId} userId={currentUser.id} projectId={projectId} activeSandboxesHref={`/workspaces/${workspaceId}/projects/${projectId}/usage#sandbox-usage`} canManagePolicy={canManagePolicy} policyHref={`/workspaces/${workspaceId}/projects/${projectId}/policy`} initialSnapshot={interactionSnapshot} presentation={detail} onPresentationChange={handlePresentationChange} onUnavailable={handleConversationUnavailable} onArtifactPublished={handleArtifactPublished} /></div>
      {mode === "terminal" ? <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden"><TaskTerminalPanel taskId={taskId} presentation={detail} transportRequested={terminalIntent.transportRequested} activeSandboxesHref={`/workspaces/${workspaceId}/projects/${projectId}/usage#sandbox-usage`} canManagePolicy={canManagePolicy} policyHref={`/workspaces/${workspaceId}/projects/${projectId}/policy`} onIntent={dispatchTerminalIntent} onPresentationChange={handlePresentationChange} /></div> : null}
      <section className={`${mode === "artifacts" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col overflow-hidden border border-border bg-surface`} aria-label="Task Artifacts"><div className="shrink-0 border-b border-border px-3 py-3"><Heading level={4} accessibilityLevel={2}>Artifacts</Heading></div><div className="min-h-0 flex-1 overflow-y-auto p-3">{artifactsPanel}</div></section>
    </div>
    <div className="shrink-0 border-y border-border py-3"><Collapsible trigger="Task details" defaultIsOpen={false}><div className="mt-4 grid gap-6 lg:grid-cols-[minmax(14rem,.8fr)_minmax(0,1fr)]"><TaskWorkspaceSummary task={task} filesHref={`/workspaces/${workspaceId}/projects/${projectId}/files?${new URLSearchParams({ libraryId: task.fileLibraryId, returnTo: canonicalHref })}`} /><div><Heading level={6} accessibilityLevel={3}>Original prompt</Heading><Text display="block" type="supporting" color="secondary" className="mt-2 whitespace-pre-wrap break-words">{task.prompt}</Text></div></div></Collapsible></div>
    {releaseDialog}
    <TaskActionDialog idPrefix="task-delete" open={deleteOpen} onOpenChange={setDeleteOpen} title="Delete task?" description="This permanently removes the Task conversation, Botified session data, and Task Artifacts. Ordinary Library files are retained, and the Library becomes available after the purge completes." actionLabel="Delete task" loading={deleting} onAction={deleteTask} errorTitle="Task could not be deleted" />
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

function TaskActionDialog({ idPrefix, open, onOpenChange, title, description, actionLabel, loading, onAction, onActionComplete, errorTitle }: { idPrefix: string; open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; actionLabel: string; loading: boolean; onAction: () => Promise<void>; onActionComplete?: () => void; errorTitle: string }) {
  const [failure, setFailure] = useState("");
  const submitPending = useRef(false);
  useEffect(() => {
    if (!open) setFailure("");
  }, [open]);
  function changeOpen(nextOpen: boolean) {
    if (loading) return;
    if (!nextOpen) setFailure("");
    onOpenChange(nextOpen);
  }
  async function submit() {
    if (loading || submitPending.current) return;
    submitPending.current = true;
    setFailure("");
    try {
      await onAction();
      onOpenChange(false);
      requestAnimationFrame(() => onActionComplete?.());
    } catch (reason) {
      setFailure(message(reason));
    } finally {
      submitPending.current = false;
    }
  }
  const formId = `${idPrefix}-form`;
  const descriptionId = `${idPrefix}-description`;
  return <Dialog
    className="[&_button]:min-h-11 [&_button]:min-w-11"
    isOpen={open}
    onOpenChange={changeOpen}
    purpose={loading ? "required" : "form"}
    role="alertdialog"
    padding={0}
    width="min(32rem, calc(100dvw - 1rem))"
    maxHeight="calc(100dvh - 1rem)"
    aria-label={title}
    aria-describedby={descriptionId}
  >
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DialogHeader title={title} hasDivider />
      <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
        <Text id={descriptionId} as="p" display="block" color="secondary">{description}</Text>
        <form id={formId} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {failure ? <Banner status="error" title={errorTitle} description={failure} /> : null}
        </form>
      </div>
      <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:p-5 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
        <AstryxButton data-autofocus="" label="Cancel" type="button" variant="ghost" size="lg" isDisabled={loading} onClick={() => changeOpen(false)} />
        <AstryxButton label={loading ? "Working" : failure ? `Try ${actionLabel.toLowerCase()} again` : actionLabel} type="submit" form={formId} variant="destructive" size="lg" isLoading={loading} isDisabled={loading} />
      </div>
    </div>
  </Dialog>;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The task request could not be completed.";
}
