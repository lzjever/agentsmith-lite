"use client";

import { Archive, ArrowLeft, CircleAlert, CircleCheck, Power, RefreshCw, TerminalSquare, Trash2 } from "lucide-react";
import { Button as AstryxButton, IconButton, Tab, TabList } from "@astryxdesign/core";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { TaskDetail as TaskDetailProjection } from "../../lib/api/client";
import { ApiError, apiClient, isReadOnlyMutationError, type Task, type TaskArtifact } from "../../lib/api/client";
import { appPath } from "../../lib/navigation/app-path";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { TaskArtifactsPanel } from "./TaskArtifactsPanel";
import { TaskConversationWorkspace } from "./TaskConversationWorkspace";
import { TaskLifecycleActions } from "./TaskLifecycleActions";
import { TaskTerminalPanel } from "./TaskTerminalPanel";
import { useTaskMutationKeys } from "./task-mutation-key";
import { taskDetailNeedsRefresh, taskProjectionLabel } from "./task-ui";

type WorkspaceMode = "conversation" | "terminal" | "artifacts";
type LoadState = "loading" | "ready" | "error";
type TaskLoadState = LoadState | "missing" | "forbidden";

export function TaskDetailPage({ workspaceId, projectId, taskId, artifactsOnly = false }: { workspaceId: string; projectId: string; taskId: string; artifactsOnly?: boolean }) {
  return <TaskDetail key={`${workspaceId}:${projectId}:${taskId}:${artifactsOnly ? "artifacts" : "task"}`} workspaceId={workspaceId} projectId={projectId} taskId={taskId} artifactsOnly={artifactsOnly} />;
}

function TaskDetail({ workspaceId, projectId, taskId, artifactsOnly }: { workspaceId: string; projectId: string; taskId: string; artifactsOnly: boolean }) {
  const mounted = useRef(true);
  const mutationKeys = useTaskMutationKeys();
  const [detail, setDetail] = useState<TaskDetailProjection>();
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([]);
  const [taskState, setTaskState] = useState<TaskLoadState>("loading");
  const [artifactsState, setArtifactsState] = useState<LoadState>("loading");
  const [taskError, setTaskError] = useState("");
  const [artifactsError, setArtifactsError] = useState("");
  const [mode, setMode] = useState<WorkspaceMode>(artifactsOnly ? "artifacts" : "conversation");
  const [terminalStarted, setTerminalStarted] = useState(false);
  const [refreshingArtifacts, setRefreshingArtifacts] = useState(false);
  const [conversationKey, setConversationKey] = useState(0);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const taskLoadVersion = useRef(0);
  const artifactsLoadVersion = useRef(0);
  const basePath = `/workspaces/${workspaceId}/projects/${projectId}/tasks`;

  const loadTask = useCallback(async (quiet = false) => {
    const version = ++taskLoadVersion.current;
    if (!quiet) setTaskState("loading");
    setTaskError("");
    try {
      const detail = await apiClient.taskDetail(taskId);
      if (!mounted.current || version !== taskLoadVersion.current) return;
      if (detail.task.id !== taskId || detail.task.workspaceId !== workspaceId || detail.task.projectId !== projectId) {
        throw new ApiError(404, "This task does not belong to this project.");
      }
      setDetail(detail);
      setTaskState("ready");
    } catch (reason) {
      if (!mounted.current || version !== taskLoadVersion.current) return;
      setTaskError(message(reason));
      if (reason instanceof ApiError && (reason.status === 403 || reason.status === 404)) {
        setDetail(undefined);
        setTaskState(reason.status === 404 ? "missing" : "forbidden");
      } else if (!quiet) {
        setTaskState("error");
      }
    }
  }, [projectId, taskId, workspaceId]);

  const loadArtifacts = useCallback(async (quiet = false) => {
    const version = ++artifactsLoadVersion.current;
    setRefreshingArtifacts(true);
    setArtifactsError("");
    if (!quiet) setArtifactsState("loading");
    try {
      const loaded = await apiClient.taskArtifacts(taskId);
      if (!mounted.current || version !== artifactsLoadVersion.current) return;
      setArtifacts(loaded);
      setArtifactsState("ready");
    } catch (reason) {
      if (!mounted.current || version !== artifactsLoadVersion.current) return;
      setArtifactsError(message(reason));
      setArtifactsState("error");
      if (reason instanceof ApiError && (reason.status === 403 || reason.status === 404)) {
        setArtifacts([]);
        await loadTask(true);
      }
    } finally {
      if (mounted.current && version === artifactsLoadVersion.current) setRefreshingArtifacts(false);
    }
  }, [loadTask, taskId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    void loadTask();
  }, [loadTask]);
  useEffect(() => {
    if (taskState === "ready") void loadArtifacts();
  }, [loadArtifacts, taskState]);
  useEffect(() => {
    if (!detail || !taskDetailNeedsRefresh(detail)) return;
    const timer = window.setInterval(() => {
      void loadTask(true);
      if (artifactsOnly) void loadArtifacts(true);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [artifactsOnly, detail, loadArtifacts, loadTask]);
  useEffect(() => {
    if (!releasing && (detail?.sandboxState.state === "active" || detail?.sandboxState.state === "starting")) return;
    setMode((current) => current === "terminal" ? "conversation" : current);
    setTerminalStarted(false);
  }, [detail?.sandboxState.state, releasing]);
  useEffect(() => {
    if (!detail?.capabilities.releaseSandbox) setReleaseOpen(false);
  }, [detail?.capabilities.releaseSandbox]);

  function refresh() {
    void loadTask(true);
    void loadArtifacts();
    if (!artifactsOnly) {
      setConversationKey((value) => value + 1);
    }
  }
  const handleArtifactPublished = useCallback(() => {
    void loadArtifacts(true);
  }, [loadArtifacts]);
  const handleConversationUnavailable = useCallback(() => {
    void loadTask(true);
  }, [loadTask]);
  const handleProjectionChange = useCallback(() => {
    void loadTask(true);
  }, [loadTask]);

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
        await loadTask(true);
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
      setDetail((current) => current ? { ...current, sandboxState:receipt.sandboxState, capabilities:receipt.capabilities } : current);
      await loadTask(true);
    } catch (reason) {
      if (!mounted.current) return;
      mutationKeys.completeApiFailure(reason, "task-sandbox-release", taskId);
      throw reason;
    } finally {
      if (mounted.current) setReleasing(false);
    }
  }

  if (taskState === "loading") return <PageLayout><PageState>Loading task...</PageState></PageLayout>;
  if (taskState === "missing") return <TaskLoadFailure title="Task not found" detail="This task does not exist or is no longer available." basePath={basePath} />;
  if (taskState === "forbidden") return <TaskLoadFailure title="Task unavailable" detail="You no longer have permission to access this task." basePath={basePath} />;
  if (taskState === "error") return <TaskLoadFailure title="Task unavailable" detail={taskError} basePath={basePath} onRetry={() => void loadTask()} />;
  if (!detail) return null;

  const presentedDetail = releasing ? releasePendingDetail(detail) : detail;
  const { task, capabilities, lifecycle, currentTurn, sandboxState } = presentedDetail;
  const mutationBusy = deleting || releasing || lifecycleBusy;
  const header = <PageHeader variant="compact" title={artifactsOnly ? "Artifacts" : task.title?.trim() || "Task detail"} subtitle={`${taskProjectionLabel(presentedDetail)} · ${task.id}`} actions={<><IconButton label="Refresh task" variant="ghost" icon={<RefreshCw size={17} />} isDisabled={mutationBusy} onClick={refresh} />{!artifactsOnly ? <TaskLifecycleActions task={task} capabilities={capabilities} onRefresh={() => loadTask(true)} disabled={deleting || releasing} onBusyChange={setLifecycleBusy} /> : null}{capabilities.releaseSandbox ? <AstryxButton label="Release sandbox" variant="destructive" size="sm" icon={<Power size={15} />} isDisabled={mutationBusy} onClick={() => setReleaseOpen(true)} /> : null}{capabilities.deleteTask && !artifactsOnly ? <IconButton label="Delete task" variant="destructive" icon={<Trash2 size={16} />} isDisabled={mutationBusy} onClick={() => setDeleteOpen(true)} /> : null}</>} />;
  const artifactsPanel = <ArtifactsSection taskId={taskId} artifacts={artifacts} state={artifactsState} error={artifactsError} refreshing={refreshingArtifacts} onRetry={loadArtifacts} />;
  const taskRefreshError = taskError ? <SectionError title="Task status refresh failed" message={taskError} onRetry={() => loadTask(true)} /> : null;
  const archivedNotice = lifecycle.state === "archived" ? <div className="flex items-start gap-3 border border-border bg-surface-low px-4 py-3"><Archive className="mt-0.5 size-4 shrink-0 text-icon-default" /><p className="text-sm text-secondary">This task is archived. Its conversation, files, and artifacts remain available.</p></div> : null;
  const sandboxNotice = sandboxState.state === "released"
    ? <div className="flex items-start gap-3 border border-border bg-surface-low px-4 py-3" role="status"><CircleCheck className="mt-0.5 size-4 shrink-0 text-icon-default" /><p className="text-sm text-secondary">Sandbox resources were released. Your next message or opening Terminal starts a new sandbox for this Task. Conversation history and File Library files remain available.</p></div>
    : sandboxState.state === "failed"
      ? <div className="flex items-start gap-3 border border-error/30 bg-error/10 px-4 py-3" role="alert"><CircleAlert className="mt-0.5 size-4 shrink-0 text-error" /><p className="text-sm text-secondary">This task's sandbox is unavailable. Conversation history and File Library files remain available.</p></div>
      : null;

  const releaseDialog = <ConfirmationDialog open={releaseOpen} onOpenChange={setReleaseOpen} title="Release sandbox?" description="Releasing stops the sandbox unconditionally and may lose running processes or unsaved information." confirmText="Release sandbox" onConfirm={releaseSandbox} errorContext="Sandbox could not be released" />;

  if (artifactsOnly) return <PageLayout header={header}><Link className="inline-flex w-fit items-center gap-2 text-sm text-secondary hover:text-foreground" href={`${basePath}/${taskId}`}><ArrowLeft size={16} />Task conversation</Link>{taskRefreshError}{archivedNotice}{sandboxNotice}<section className="border border-border bg-background p-4"><h2 className="type-title text-foreground">Published artifacts</h2><div className="mt-4">{artifactsPanel}</div></section>{releaseDialog}</PageLayout>;

  const showArtifacts = artifactsState !== "ready" || artifacts.length > 0;
  const terminalAvailable = capabilities.openTerminal;
  const terminalDisabled = sandboxState.state === "release_requested" || (!terminalAvailable && !terminalStarted);
  const selectWorkspaceMode = (next: string) => {
    if (next === "terminal") {
      if (terminalDisabled) return;
      setTerminalStarted(true);
    }
    setMode(next as WorkspaceMode);
  };
  return <PageLayout header={header} contentWidth="full">
    <Link className="inline-flex w-fit items-center gap-2 text-sm text-secondary hover:text-foreground" href={basePath}><ArrowLeft size={16} />All tasks</Link>
    {taskRefreshError}
    {archivedNotice}
    {sandboxNotice}
    <TabList value={mode} onChange={selectWorkspaceMode} aria-label="Task workspace views" hasDivider className="shrink-0 flex-wrap">
      <Tab value="conversation" label="Conversation" />
      <Tab value="terminal" label="Terminal" icon={<TerminalSquare size={14} />} aria-disabled={terminalDisabled} />
      {showArtifacts ? <Tab value="artifacts" label="Artifacts" className="xl:hidden" /> : null}
    </TabList>
    <div className="grid h-[clamp(24rem,calc(100dvh-20rem),48rem)] min-h-0 min-w-0 gap-4 overflow-hidden md:h-[clamp(24rem,calc(100dvh-12rem),48rem)] xl:grid-cols-[minmax(0,1fr)_18rem]" data-testid="task-workspace">
      <div className={`${mode === "conversation" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col`}><TaskConversationWorkspace key={conversationKey} taskId={taskId} currentTurn={currentTurn} sandboxState={sandboxState} capabilities={capabilities} onProjectionChange={handleProjectionChange} onUnavailable={handleConversationUnavailable} onArtifactPublished={handleArtifactPublished} /></div>
      {terminalStarted && sandboxState.state !== "release_requested" ? <div className={`${mode === "terminal" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 overflow-hidden`}><TaskTerminalPanel taskId={taskId} active={mode === "terminal"} /></div> : null}
      {showArtifacts ? <aside className={`${mode === "artifacts" ? "block" : "hidden"} min-h-0 min-w-0 overflow-y-auto border border-border bg-background xl:block`}><div className="flex items-center justify-between gap-3 border-b border-border px-3 py-3"><h2 className="type-title text-foreground">Artifacts</h2><Link href={`${basePath}/${taskId}/artifacts`} className="text-sm text-secondary hover:text-foreground">View all</Link></div><div className="p-3">{artifactsPanel}</div></aside> : null}
    </div>
    <details className="border-y border-border py-3"><summary className="cursor-pointer text-sm font-medium text-foreground">Task details</summary><div className="mt-4 grid gap-6 lg:grid-cols-[minmax(14rem,.8fr)_minmax(0,1fr)]"><TaskWorkspaceSummary task={task} filesHref={`/workspaces/${workspaceId}/projects/${projectId}/files?libraryId=${encodeURIComponent(task.fileLibraryId)}`} /><div><h3 className="type-caption text-tertiary">Original prompt</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm text-secondary">{task.prompt}</p></div></div></details>
    {releaseDialog}
    <ConfirmationDialog open={deleteOpen} onOpenChange={setDeleteOpen} title="Delete task?" description="This permanently removes this task from the product." confirmText="Delete task" onConfirm={deleteTask} errorContext="Task could not be deleted" />
  </PageLayout>;
}

function TaskLoadFailure({ title, detail, basePath, onRetry }: { title: string; detail: string; basePath: string; onRetry?: () => void }) {
  return <PageLayout><PageState state={onRetry ? "error" : "empty"}><div className="text-center"><h1 className="type-section-heading">{title}</h1><p className={`mt-2 text-sm ${onRetry ? "text-error" : "text-secondary"}`} {...(onRetry ? { role: "alert" as const } : {})}>{detail}</p><div className="mt-5 flex flex-wrap justify-center gap-2"><Link className="inline-flex min-h-9 items-center gap-2 rounded-sm border border-border px-3 text-sm text-secondary no-underline hover:text-foreground" href={basePath}><ArrowLeft size={16} />All tasks</Link>{onRetry ? <AstryxButton label="Try again" variant="secondary" onClick={onRetry} /> : null}</div></div></PageState></PageLayout>;
}

function ArtifactsSection({ taskId, artifacts, state, error, refreshing, emptyMessage, onRetry }: { taskId: string; artifacts: TaskArtifact[]; state: LoadState; error: string; refreshing: boolean; emptyMessage?: string; onRetry: () => Promise<void> }) {
  if (state === "loading" && artifacts.length === 0) return <p className="py-6 text-center text-sm text-secondary">Loading artifacts...</p>;
  if (state === "error" && artifacts.length === 0) return <SectionError title="Artifacts unavailable" message={error} onRetry={onRetry} />;
  return <>{error ? <div className="mb-3 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">{error}</div> : null}<TaskArtifactsPanel taskId={taskId} artifacts={artifacts} onRefresh={onRetry} refreshing={refreshing} {...(emptyMessage ? { emptyMessage } : {})} /></>;
}

function TaskWorkspaceSummary({ task, filesHref }: { task: Task; filesHref: string }) {
  return <div><h3 className="type-caption text-tertiary">Workspace</h3><dl className="mt-2 grid gap-2 text-sm"><TaskDetailValue label="File Library"><Link className="break-all font-mono text-xs text-foreground hover:underline" href={filesHref}>{task.fileLibraryId}</Link></TaskDetailValue><TaskDetailValue label="Endpoint"><span className="break-all font-mono text-xs">{task.endpointId}</span></TaskDetailValue><TaskDetailValue label="Sandbox"><span className="break-all font-mono text-xs">{task.sandbox.namespace}</span></TaskDetailValue></dl></div>;
}

function TaskDetailValue({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2"><dt className="text-tertiary">{label}</dt><dd className="min-w-0 text-secondary">{children}</dd></div>;
}

function SectionError({ title, message: detail, onRetry }: { title: string; message: string; onRetry: () => Promise<void> }) {
  return <div className="border border-error/30 bg-error/10 px-3 py-3 text-sm" role="alert"><p className="font-medium text-foreground">{title}</p><p className="mt-1 break-words text-secondary">{detail}</p><AstryxButton label="Try again" className="mt-3" variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void onRetry()} /></div>;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The task request could not be completed.";
}

function releasePendingDetail(detail: TaskDetailProjection): TaskDetailProjection {
  return {
    ...detail,
    sandboxState:{ state:"release_requested", runId:detail.sandboxState.runId },
    capabilities:{
      ...detail.capabilities,
      sendMessage:false,
      editQueuedMessage:false,
      abortTurn:false,
      openTerminal:false,
      releaseSandbox:false
    }
  };
}
