"use client";

import { Archive, ArrowLeft, CircleCheck, Power, RefreshCw, TerminalSquare, Trash2 } from "lucide-react";
import { Banner, Button as AstryxButton, Collapsible, DialogHeader, Heading, IconButton, Layout, LayoutContent, LayoutFooter, Tab, TabList, Text } from "@astryxdesign/core";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { TaskDetail as TaskDetailProjection, TaskInteractionSnapshot } from "../../lib/api/client";
import { ApiError, apiClient, isReadOnlyMutationError, type Task, type TaskArtifact, type TaskArtifactKind } from "../../lib/api/client";
import { appPath } from "../../lib/navigation/app-path";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { RouteLoadingPage } from "../layout/RouteStatePage";
import { Dialog } from "../ui/Dialog";
import { TaskArtifactsPanel } from "./TaskArtifactsPanel";
import { TaskConversationWorkspace } from "./TaskConversationWorkspace";
import { TaskLifecycleActions } from "./TaskLifecycleActions";
import { TaskTerminalPanel } from "./TaskTerminalPanel";
import { useTaskMutationKeys } from "./task-mutation-key";
import { taskProjectionLabel } from "./task-ui";

type WorkspaceMode = "conversation" | "terminal" | "artifacts";
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

export function TaskDetailPage({ workspaceId, projectId, taskId, artifactsOnly = false }: { workspaceId: string; projectId: string; taskId: string; artifactsOnly?: boolean }) {
  return <TaskDetail key={`${workspaceId}:${projectId}:${taskId}:${artifactsOnly ? "artifacts" : "task"}`} workspaceId={workspaceId} projectId={projectId} taskId={taskId} artifactsOnly={artifactsOnly} />;
}

function TaskDetail({ workspaceId, projectId, taskId, artifactsOnly }: { workspaceId: string; projectId: string; taskId: string; artifactsOnly: boolean }) {
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
  const [mode, setMode] = useState<WorkspaceMode>(artifactsOnly ? "artifacts" : "conversation");
  const [terminalStarted, setTerminalStarted] = useState(false);
  const [refreshingArtifacts, setRefreshingArtifacts] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const taskLoadVersion = useRef(0);
  const artifactsLoadVersion = useRef(0);
  const basePath = `/workspaces/${workspaceId}/projects/${projectId}/tasks`;

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
        setDetail(undefined);
        setInteractionSnapshot(undefined);
        setTaskState(reason.status === 404 ? "missing" : "forbidden");
      } else if (!quiet) {
        setTaskState("error");
      }
    }
  }, [projectId, taskId, workspaceId]);

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
    if(taskState==="ready"&&artifactsState==="idle"&&(artifactsOnly||mode==="artifacts"))void loadArtifacts();
  },[artifactsOnly,artifactsState,loadArtifacts,mode,taskState]);
  useEffect(() => {
    if (!releasing && (detail?.sandboxState.state === "active" || detail?.sandboxState.state === "starting")) return;
    setMode((current) => current === "terminal" ? "conversation" : current);
    setTerminalStarted(false);
  }, [detail?.sandboxState.state, releasing]);
  useEffect(() => {
    if (!detail?.capabilities.releaseSandbox) setReleaseOpen(false);
  }, [detail?.capabilities.releaseSandbox]);

  async function refresh() {
    await loadSnapshot(true);
    if (artifactsOnly || artifactsState !== "idle") {
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
    setTaskError(reason.message);
    setDetail(undefined);
    setInteractionSnapshot(undefined);
    setTaskState(reason.status === 404 ? "missing" : "forbidden");
  }, []);
  const handlePresentationChange=useCallback((presentation:TaskDetailProjection)=>{setDetail(presentation);},[]);

  async function deleteTask() {
    if (!detail?.capabilities.deleteTask || deleting || releasing || lifecycleBusy) return;
    setDeleting(true);
    try {
      await apiClient.deleteTask(taskId, mutationKeys.key("task-delete", taskId));
      mutationKeys.complete("task-delete", taskId);
      if (!mounted.current) return;
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

  if (taskState === "loading") return <RouteLoadingPage title={artifactsOnly ? "Artifacts" : "Task"} />;
  if (taskState === "missing") return <TaskLoadFailure title="Task not found" detail="This task does not exist or is no longer available." basePath={basePath} />;
  if (taskState === "forbidden") return <TaskLoadFailure title="Task unavailable" detail="You no longer have permission to access this task." basePath={basePath} />;
  if (taskState === "error") return <TaskLoadFailure title="Task unavailable" detail={taskError} basePath={basePath} onRetry={() => void loadSnapshot()} />;
  if (!detail || !interactionSnapshot) return null;

  const { task, capabilities, lifecycle, sandboxState } = detail;
  const mutationBusy = deleting || releasing || lifecycleBusy;
  const releaseLabel=sandboxState.state==="failed"||sandboxState.state==="release_requested"?"Retry release":"Release sandbox";
  const header = <PageHeader variant="compact" title={artifactsOnly ? "Artifacts" : task.title?.trim() || "Task detail"} subtitle={`${taskProjectionLabel(detail)} · ${task.id}`} actions={<><IconButton label="Refresh task" tooltip="Refresh task" variant="ghost" icon={<RefreshCw size={17} />} isDisabled={mutationBusy} onClick={() => void refresh()} />{!artifactsOnly ? <TaskLifecycleActions task={task} capabilities={capabilities} onRefresh={() => loadSnapshot(true)} disabled={deleting || releasing} onBusyChange={setLifecycleBusy} /> : null}{capabilities.releaseSandbox ? <AstryxButton label={releaseLabel} variant="destructive" size="sm" icon={<Power size={15} />} isDisabled={mutationBusy} onClick={() => setReleaseOpen(true)} /> : null}{capabilities.deleteTask && !artifactsOnly ? <IconButton label="Delete task" tooltip="Delete task" variant="destructive" icon={<Trash2 size={16} />} isDisabled={mutationBusy} onClick={() => setDeleteOpen(true)} /> : null}</>} />;
  const artifactsPanel = <ArtifactsSection taskId={taskId} artifacts={artifactPage.items} state={artifactsState} error={artifactsError} refreshing={refreshingArtifacts} filter={artifactPage.filter} hasNext={artifactPage.nextCursor !== null} hasPrevious={artifactPage.cursorStack.length > 0} onFilterChange={changeArtifactFilter} onNext={nextArtifactPage} onPrevious={previousArtifactPage} onRefresh={refreshArtifacts} onRetry={retryArtifacts} />;
  const taskRefreshError = taskError ? <SectionError title="Task status refresh failed" message={taskError} onRetry={() => loadSnapshot(true)} /> : null;
  const archivedNotice = lifecycle.state === "archived" ? <Banner status="info" icon={<Archive size={16} />} title="Task archived" description="Its conversation, files, and artifacts remain available." /> : null;
  const sandboxNotice = sandboxState.state === "released"
    ? <Banner status="success" icon={<CircleCheck size={16} />} title="Sandbox released" description="Your next message or opening Terminal starts a new sandbox for this Task. Conversation history and File Library files remain available." />
    : sandboxState.state === "failed"
      ? <Banner status="error" title="Sandbox failed" description={sandboxState.cause?.message??"The sandbox could not continue."} />
    : sandboxState.state === "release_requested" && sandboxState.cause
      ? <Banner status="warning" title="Sandbox cleanup pending" description={sandboxState.cause.message} />
    : null;

  const releaseDialog = <TaskActionDialog idPrefix="task-sandbox-release" open={releaseOpen} onOpenChange={setReleaseOpen} title={`${releaseLabel}?`} description="Releasing stops the sandbox unconditionally and may lose running processes or unsaved information." actionLabel={releaseLabel} loading={releasing} onAction={releaseSandbox} errorTitle="Sandbox could not be released" />;

  if (artifactsOnly) return <PageLayout header={header}><Link className="inline-flex w-fit items-center gap-2 hover:text-primary" href={`${basePath}/${taskId}`}><ArrowLeft size={16} /><Text type="supporting" color="secondary">Task conversation</Text></Link>{taskRefreshError}{archivedNotice}{sandboxNotice}<section className="border border-border bg-surface p-4"><Heading level={4} accessibilityLevel={2}>Published artifacts</Heading><div className="mt-4">{artifactsPanel}</div></section>{releaseDialog}</PageLayout>;

  const terminalAvailable = capabilities.openTerminal;
  const terminalDisabled = sandboxState.state === "release_requested" || (!terminalAvailable && !terminalStarted);
  const selectWorkspaceMode = (next: string) => {
    if (next === "terminal") {
      if (terminalDisabled) return;
      setTerminalStarted(true);
    }
    setMode(next as WorkspaceMode);
  };
  return <PageLayout header={header} contentWidth="full" density="immersive" height="fill">
    <Link className="inline-flex w-fit shrink-0 items-center gap-2 hover:text-primary" href={basePath}><ArrowLeft size={16} /><Text type="supporting" color="secondary">All tasks</Text></Link>
    {taskRefreshError}
    {archivedNotice}
    {sandboxNotice}
    <TabList value={mode} onChange={selectWorkspaceMode} aria-label="Task workspace views" hasDivider className="shrink-0 flex-wrap gap-2">
      <Tab value="conversation" label="Conversation" />
      <Tab value="terminal" label="Terminal" icon={<TerminalSquare size={14} />} aria-disabled={terminalDisabled} />
      <Tab value="artifacts" label="Artifacts" />
    </TabList>
    <div className="grid min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="task-workspace">
      <div className={`${mode === "conversation" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col`}><TaskConversationWorkspace taskId={taskId} initialSnapshot={interactionSnapshot} presentation={detail} onPresentationChange={handlePresentationChange} onUnavailable={handleConversationUnavailable} onArtifactPublished={handleArtifactPublished} /></div>
      {terminalStarted && sandboxState.state !== "release_requested" ? <div className={`${mode === "terminal" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 overflow-hidden`}><TaskTerminalPanel taskId={taskId} active={mode === "terminal"} /></div> : null}
      <section className={`${mode === "artifacts" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col overflow-hidden border border-border bg-surface`} aria-label="Task Artifacts"><div className="shrink-0 border-b border-border px-3 py-3"><Heading level={4} accessibilityLevel={2}>Artifacts</Heading></div><div className="min-h-0 flex-1 overflow-y-auto p-3">{artifactsPanel}</div></section>
    </div>
    <div className="shrink-0 border-y border-border py-3"><Collapsible trigger="Task details" defaultIsOpen={false}><div className="mt-4 grid gap-6 lg:grid-cols-[minmax(14rem,.8fr)_minmax(0,1fr)]"><TaskWorkspaceSummary task={task} filesHref={`/workspaces/${workspaceId}/projects/${projectId}/files?libraryId=${encodeURIComponent(task.fileLibraryId)}`} /><div><Heading level={6} accessibilityLevel={3}>Original prompt</Heading><Text display="block" type="supporting" color="secondary" className="mt-2 whitespace-pre-wrap break-words">{task.prompt}</Text></div></div></Collapsible></div>
    {releaseDialog}
    <TaskActionDialog idPrefix="task-delete" open={deleteOpen} onOpenChange={setDeleteOpen} title="Delete task?" description="This permanently removes this task from the product." actionLabel="Delete task" loading={deleting} onAction={deleteTask} errorTitle="Task could not be deleted" />
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

function TaskActionDialog({ idPrefix, open, onOpenChange, title, description, actionLabel, loading, onAction, errorTitle }: { idPrefix: string; open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; actionLabel: string; loading: boolean; onAction: () => Promise<void>; errorTitle: string }) {
  const [failure, setFailure] = useState("");
  useEffect(() => {
    if (!open) setFailure("");
  }, [open]);
  function changeOpen(nextOpen: boolean) {
    if (loading) return;
    if (!nextOpen) setFailure("");
    onOpenChange(nextOpen);
  }
  async function submit() {
    setFailure("");
    try {
      await onAction();
      onOpenChange(false);
    } catch (reason) {
      setFailure(message(reason));
    }
  }
  const titleId = `${idPrefix}-title`;
  const descriptionId = `${idPrefix}-description`;
  const formId = `${idPrefix}-form`;
  return <Dialog isOpen={open} onOpenChange={changeOpen} purpose="form" role="alertdialog" width="min(32rem, calc(100vw - 2rem))" aria-labelledby={titleId} aria-describedby={descriptionId}><Layout defaultHasDividers header={<DialogHeader id={titleId} title={title} />} content={<LayoutContent><form id={formId} onSubmit={(event) => { event.preventDefault(); void submit(); }}><div className="grid gap-4"><Text id={descriptionId} as="p" display="block" color="secondary">{description}</Text>{failure ? <Banner status="error" title={errorTitle} description={failure} /> : null}</div></form></LayoutContent>} footer={<LayoutFooter><div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><AstryxButton label="Cancel" type="button" variant="ghost" size="lg" isDisabled={loading} onClick={() => changeOpen(false)} /><AstryxButton label={loading ? "Working" : actionLabel} type="submit" form={formId} variant="destructive" size="lg" isLoading={loading} isDisabled={loading} /></div></LayoutFooter>} /></Dialog>;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The task request could not be completed.";
}
