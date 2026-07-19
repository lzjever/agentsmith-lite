"use client";

import { Archive, ArrowLeft, CircleAlert, Loader2, RefreshCw, TerminalSquare, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { TaskCapabilities } from "../../lib/api/client";
import { ApiError, apiClient, isReadOnlyMutationError, type Task, type TaskArtifact, type TaskInput } from "../../lib/api/client";
import { appPath } from "../../lib/navigation/app-path";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { toast } from "../ui/toast";
import { TaskArtifactsPanel } from "./TaskArtifactsPanel";
import { TaskConversationWorkspace } from "./TaskConversationWorkspace";
import { TaskInputsPanel } from "./TaskInputsPanel";
import { TaskLifecycleActions } from "./TaskLifecycleActions";
import { TaskTerminalPanel } from "./TaskTerminalPanel";
import { useTaskMutationKeys } from "./task-mutation-key";
import { taskFinalizationPresentation, taskNeedsRefresh, taskResultLabel, type TaskFinalizationPresentation } from "./task-ui";

type WorkspaceMode = "conversation" | "terminal" | "artifacts";
type LoadState = "loading" | "ready" | "error";
type TaskLoadState = LoadState | "missing" | "forbidden";

export function TaskDetailPage({ workspaceId, projectId, taskId, artifactsOnly = false }: { workspaceId: string; projectId: string; taskId: string; artifactsOnly?: boolean }) {
  return <TaskDetail key={`${workspaceId}:${projectId}:${taskId}:${artifactsOnly ? "artifacts" : "task"}`} workspaceId={workspaceId} projectId={projectId} taskId={taskId} artifactsOnly={artifactsOnly} />;
}

function TaskDetail({ workspaceId, projectId, taskId, artifactsOnly }: { workspaceId: string; projectId: string; taskId: string; artifactsOnly: boolean }) {
  const mounted = useRef(true);
  const mutationKeys = useTaskMutationKeys();
  const [task, setTask] = useState<Task>();
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([]);
  const [inputs, setInputs] = useState<TaskInput[]>([]);
  const [capabilities, setCapabilities] = useState<TaskCapabilities>();
  const [taskState, setTaskState] = useState<TaskLoadState>("loading");
  const [artifactsState, setArtifactsState] = useState<LoadState>("loading");
  const [inputsState, setInputsState] = useState<LoadState>("loading");
  const [taskError, setTaskError] = useState("");
  const [artifactsError, setArtifactsError] = useState("");
  const [inputsError, setInputsError] = useState("");
  const [mode, setMode] = useState<WorkspaceMode>(artifactsOnly ? "artifacts" : "conversation");
  const [terminalStarted, setTerminalStarted] = useState(false);
  const [refreshingArtifacts, setRefreshingArtifacts] = useState(false);
  const [conversationKey, setConversationKey] = useState(0);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const taskLoadVersion = useRef(0);
  const artifactsLoadVersion = useRef(0);
  const inputsLoadVersion = useRef(0);
  const basePath = `/workspaces/${workspaceId}/projects/${projectId}/tasks`;

  const applyCapabilities = useCallback((next: TaskCapabilities) => {
    setCapabilities(next);
    if (!next.cancelTask) setCancelOpen(false);
    if (!next.deleteTask) setDeleteOpen(false);
  }, []);

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
      setTask(detail.task);
      applyCapabilities(detail.capabilities);
      setTaskState("ready");
    } catch (reason) {
      if (!mounted.current || version !== taskLoadVersion.current) return;
      setTaskError(message(reason));
      if (reason instanceof ApiError && (reason.status === 403 || reason.status === 404)) {
        setTask(undefined);
        setCapabilities(undefined);
        setTaskState(reason.status === 404 ? "missing" : "forbidden");
      } else if (!quiet) {
        setTaskState("error");
      }
    }
  }, [applyCapabilities, projectId, taskId, workspaceId]);

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

  const loadInputs = useCallback(async () => {
    const version = ++inputsLoadVersion.current;
    setInputsError("");
    setInputsState("loading");
    try {
      const loaded = await apiClient.taskInputs(taskId);
      if (!mounted.current || version !== inputsLoadVersion.current) return;
      setInputs(loaded);
      setInputsState("ready");
    } catch (reason) {
      if (!mounted.current || version !== inputsLoadVersion.current) return;
      setInputsError(message(reason));
      setInputsState("error");
      if (reason instanceof ApiError && (reason.status === 403 || reason.status === 404)) {
        setInputs([]);
        await loadTask(true);
      }
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
    if (taskState === "ready" && !artifactsOnly) void loadInputs();
  }, [artifactsOnly, loadInputs, taskState]);
  useEffect(() => {
    if (!task || !taskNeedsRefresh(task)) return;
    const finalizing = taskFinalizationPresentation(task) !== null;
    const timer = window.setInterval(() => {
      void loadTask(true);
      if (artifactsOnly || finalizing) void loadArtifacts(true);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [artifactsOnly, loadArtifacts, loadTask, task]);

  function refresh() {
    void loadTask(true);
    void loadArtifacts();
    if (!artifactsOnly) {
      void loadInputs();
      setConversationKey((value) => value + 1);
    }
  }
  const handleArtifactPublished = useCallback(() => {
    void loadArtifacts(true);
  }, [loadArtifacts]);
  const handleConversationUnavailable = useCallback(() => {
    void loadTask(true);
  }, [loadTask]);

  async function cancelTask() {
    if (!capabilities?.cancelTask || cancelling || deleting || lifecycleBusy) return;
    setCancelling(true);
    try {
      await apiClient.cancelTask(taskId, mutationKeys.key("task-cancel", taskId));
      mutationKeys.complete("task-cancel", taskId);
      if (!mounted.current) return;
      refresh();
      toast.success("Task cancellation requested");
    } catch (reason) {
      if (!mounted.current) return;
      mutationKeys.completeApiFailure(reason, "task-cancel", taskId);
      if (isReadOnlyMutationError(reason)) {
        setCapabilities((current) => current ? { ...current, cancelTask: false } : current);
        setCancelOpen(false);
        await loadTask(true);
      }
      throw reason;
    } finally {
      if (mounted.current) setCancelling(false);
    }
  }
  async function deleteTask() {
    if (!capabilities?.deleteTask || cancelling || deleting || lifecycleBusy) return;
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
        setCapabilities((current) => current ? { ...current, deleteTask: false } : current);
        setDeleteOpen(false);
        await loadTask(true);
      }
      throw reason;
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }

  if (taskState === "loading") return <PageLayout><PageState>Loading task...</PageState></PageLayout>;
  if (taskState === "missing") return <TaskLoadFailure title="Task not found" detail="This task does not exist or is no longer available." basePath={basePath} />;
  if (taskState === "forbidden") return <TaskLoadFailure title="Task unavailable" detail="You no longer have permission to access this task." basePath={basePath} />;
  if (taskState === "error") return <TaskLoadFailure title="Task unavailable" detail={taskError} basePath={basePath} onRetry={() => void loadTask()} />;
  if (!task) return null;

  const finalization = taskFinalizationPresentation(task);
  const mutationBusy = cancelling || deleting || lifecycleBusy;
  const artifactEmptyMessage = task.artifactProjectionStatus === "failed" || task.artifactProjectionStatus === "pending" || task.artifactProjectionStatus === "draining" ? "Artifacts are not fully available yet." : null;
  const header = <PageHeader variant="compact" title={artifactsOnly ? "Artifacts" : task.title?.trim() || "Task detail"} subtitle={[taskResultLabel(task), task.archivedAt ? "Archived" : null, task.id].filter(Boolean).join(" · ")} actions={<><Button variant="quiet" size="icon" aria-label="Refresh task" title="Refresh task" disabled={mutationBusy} onClick={refresh}><RefreshCw size={17} /></Button>{capabilities && !artifactsOnly ? <TaskLifecycleActions task={task} capabilities={capabilities} basePath={basePath} onRefresh={() => loadTask(true)} disabled={cancelling || deleting} onBusyChange={setLifecycleBusy} /> : null}{capabilities?.cancelTask && !artifactsOnly ? <Button variant="danger" disabled={mutationBusy} onClick={() => setCancelOpen(true)}><X size={15} />{cancelling ? "Cancelling..." : "Cancel task"}</Button> : null}{capabilities?.deleteTask && !artifactsOnly ? <Button variant="danger" size="icon" aria-label="Delete task" title="Delete task" disabled={mutationBusy} onClick={() => setDeleteOpen(true)}><Trash2 size={16} /></Button> : null}</>} />;
  const artifactsPanel = <ArtifactsSection taskId={taskId} artifacts={artifacts} state={artifactsState} error={artifactsError} refreshing={refreshingArtifacts} {...(artifactEmptyMessage ? { emptyMessage:artifactEmptyMessage } : {})} onRetry={loadArtifacts} />;
  const taskRefreshError = taskError ? <SectionError title="Task status refresh failed" message={taskError} onRetry={() => loadTask(true)} /> : null;
  const archivedNotice = task.archivedAt ? <div className="flex items-start gap-3 border border-border bg-surface-low px-4 py-3"><Archive className="mt-0.5 size-4 shrink-0 text-icon-default" /><p className="text-sm text-secondary">This task is archived. Its conversation, inputs, and artifacts remain available.</p></div> : null;

  if (artifactsOnly) return <PageLayout header={header}><Link className="inline-flex w-fit items-center gap-2 text-sm text-secondary hover:text-foreground" href={`${basePath}/${taskId}`}><ArrowLeft size={16} />Task conversation</Link>{taskRefreshError}{archivedNotice}{finalization ? <TaskFinalizationNotice presentation={finalization} /> : null}<section className="border border-border bg-background p-4"><h2 className="type-title text-foreground">Published artifacts</h2><div className="mt-4">{artifactsPanel}</div></section></PageLayout>;

  const showArtifacts = artifactsState !== "ready" || artifacts.length > 0 || artifactEmptyMessage !== null;
  const showTerminal = capabilities?.openTerminal || terminalStarted;
  return <PageLayout header={header} contentWidth="full">
    <Link className="inline-flex w-fit items-center gap-2 text-sm text-secondary hover:text-foreground" href={basePath}><ArrowLeft size={16} />All tasks</Link>
    {taskRefreshError}
    {archivedNotice}
    {finalization ? <TaskFinalizationNotice presentation={finalization} /> : null}
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border pb-3" role="tablist" aria-label="Task workspace views"><WorkspaceTab active={mode === "conversation"} onClick={() => setMode("conversation")}>Conversation</WorkspaceTab>{showTerminal ? <WorkspaceTab active={mode === "terminal"} onClick={() => { setTerminalStarted(true); setMode("terminal"); }}><TerminalSquare size={14} />Terminal</WorkspaceTab> : null}{showArtifacts ? <WorkspaceTab active={mode === "artifacts"} onClick={() => setMode("artifacts")} className="xl:hidden">Artifacts</WorkspaceTab> : null}</div>
    <div className="grid h-[clamp(24rem,calc(100dvh-20rem),48rem)] min-h-0 min-w-0 gap-4 overflow-hidden md:h-[clamp(24rem,calc(100dvh-12rem),48rem)] xl:grid-cols-[minmax(0,1fr)_18rem]" data-testid="task-workspace">
      <div className={`${mode === "conversation" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col`}><TaskConversationWorkspace key={conversationKey} taskId={taskId} basePath={basePath} taskResult={{status:task.status,terminalReason:task.terminalReason}} onCapabilities={applyCapabilities} onUnavailable={handleConversationUnavailable} onArtifactPublished={handleArtifactPublished} /></div>
      {terminalStarted ? <div className={`${mode === "terminal" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 overflow-hidden`}><TaskTerminalPanel taskId={taskId} active={mode === "terminal"} /></div> : null}
      {showArtifacts ? <aside className={`${mode === "artifacts" ? "block" : "hidden"} min-h-0 min-w-0 overflow-y-auto border border-border bg-background xl:block`}><div className="flex items-center justify-between gap-3 border-b border-border px-3 py-3"><h2 className="type-title text-foreground">Artifacts</h2><Link href={`${basePath}/${taskId}/artifacts`} className="text-sm text-secondary hover:text-foreground">View all</Link></div><div className="p-3">{artifactsPanel}</div></aside> : null}
    </div>
    <details className="border-y border-border py-3"><summary className="cursor-pointer text-sm font-medium text-foreground">Task details</summary><div className="mt-4 grid gap-6 lg:grid-cols-[minmax(12rem,.6fr)_minmax(14rem,.7fr)_minmax(0,1fr)]"><TaskExecutionSummary task={task} basePath={basePath} /><InputsSection taskId={taskId} inputs={inputs} selectedPaths={task.inputPaths ?? []} state={inputsState} error={inputsError} onRetry={loadInputs} /><div><h3 className="type-caption text-tertiary">Original prompt</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm text-secondary">{task.prompt}</p></div></div></details>
    <ConfirmationDialog open={deleteOpen} onOpenChange={setDeleteOpen} title="Delete task?" description="This removes the task from the product after its sandbox cleanup is complete." confirmText="Delete task" onConfirm={deleteTask} errorContext="Task could not be deleted" />
    <ConfirmationDialog open={cancelOpen} onOpenChange={setCancelOpen} title="Cancel task?" description="This ends the task and begins cleanup. Stop current turn only interrupts the active agent turn." confirmText="Cancel task" onConfirm={cancelTask} errorContext="Task could not be cancelled" />
  </PageLayout>;
}

function TaskLoadFailure({ title, detail, basePath, onRetry }: { title: string; detail: string; basePath: string; onRetry?: () => void }) {
  return <PageLayout><PageState state={onRetry ? "error" : "empty"}><div className="text-center"><h1 className="type-section-heading">{title}</h1><p className={`mt-2 text-sm ${onRetry ? "text-error" : "text-secondary"}`} {...(onRetry ? { role: "alert" as const } : {})}>{detail}</p><div className="mt-5 flex flex-wrap justify-center gap-2"><Link className="inline-flex min-h-9 items-center gap-2 rounded-sm border border-border px-3 text-sm text-secondary no-underline hover:text-foreground" href={basePath}><ArrowLeft size={16} />All tasks</Link>{onRetry ? <Button onClick={onRetry}>Try again</Button> : null}</div></div></PageState></PageLayout>;
}

function ArtifactsSection({ taskId, artifacts, state, error, refreshing, emptyMessage, onRetry }: { taskId: string; artifacts: TaskArtifact[]; state: LoadState; error: string; refreshing: boolean; emptyMessage?: string; onRetry: () => Promise<void> }) {
  if (state === "loading" && artifacts.length === 0) return <p className="py-6 text-center text-sm text-secondary">Loading artifacts...</p>;
  if (state === "error" && artifacts.length === 0) return <SectionError title="Artifacts unavailable" message={error} onRetry={onRetry} />;
  return <>{error ? <div className="mb-3 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">{error}</div> : null}<TaskArtifactsPanel taskId={taskId} artifacts={artifacts} onRefresh={onRetry} refreshing={refreshing} {...(emptyMessage ? { emptyMessage } : {})} /></>;
}

function TaskFinalizationNotice({ presentation }: { presentation: TaskFinalizationPresentation }) {
  const warning = presentation.tone === "warning";
  const Icon = warning ? CircleAlert : Loader2;
  return <div className={`flex items-start gap-3 border px-4 py-3 ${warning ? "border-warning/30 bg-warning/10" : "border-border bg-surface-low"}`} role={warning ? "alert" : "status"}><Icon className={`mt-0.5 size-4 shrink-0 ${warning ? "text-warning" : "animate-spin text-icon-default"}`} /><div className="min-w-0"><p className="text-sm font-medium text-foreground">{presentation.label}</p><p className="mt-1 text-sm text-secondary">{presentation.description}</p>{presentation.error ? <p className="mt-2 break-words font-mono text-xs text-warning">{presentation.error}</p> : null}</div></div>;
}

function InputsSection({ taskId, inputs, selectedPaths, state, error, onRetry }: { taskId: string; inputs: TaskInput[]; selectedPaths: string[]; state: LoadState; error: string; onRetry: () => Promise<void> }) {
  if (state === "loading" && inputs.length === 0) return <p className="py-6 text-center text-sm text-secondary">Loading task inputs...</p>;
  if (state === "error" && inputs.length === 0) return <SectionError title="Task inputs unavailable" message={error} onRetry={onRetry} />;
  return <>{error ? <div className="mb-3 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">{error}</div> : null}<TaskInputsPanel taskId={taskId} inputs={inputs} selectedPaths={selectedPaths} /></>;
}

function TaskExecutionSummary({ task, basePath }: { task: Task; basePath: string }) {
  return <div><h3 className="type-caption text-tertiary">Execution</h3><dl className="mt-2 grid gap-2 text-sm"><TaskDetailValue label="Mode">{task.executionMode === "live" ? "Live sandbox" : "Dry run"}</TaskDetailValue><TaskDetailValue label="Endpoint"><span className="break-all font-mono text-xs">{task.endpointId}</span></TaskDetailValue><TaskDetailValue label="Run"><span className="break-all font-mono text-xs">{task.runId}</span></TaskDetailValue><TaskDetailValue label="Namespace"><span className="break-all font-mono text-xs">{task.sandbox.namespace}</span></TaskDetailValue>{task.cleanupStatus ? <TaskDetailValue label="Cleanup">{task.cleanupStatus.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase())}</TaskDetailValue> : null}{task.sourceTaskId ? <TaskDetailValue label="Continued from"><Link className="break-all font-mono text-xs text-foreground hover:underline" href={`${basePath}/${task.sourceTaskId}`}>{task.sourceTaskId}</Link></TaskDetailValue> : null}</dl></div>;
}

function TaskDetailValue({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2"><dt className="text-tertiary">{label}</dt><dd className="min-w-0 text-secondary">{children}</dd></div>;
}

function SectionError({ title, message: detail, onRetry }: { title: string; message: string; onRetry: () => Promise<void> }) {
  return <div className="border border-error/30 bg-error/10 px-3 py-3 text-sm" role="alert"><p className="font-medium text-foreground">{title}</p><p className="mt-1 break-words text-secondary">{detail}</p><Button className="mt-3" variant="quiet" size="sm" onClick={() => void onRetry()}><RefreshCw size={14} />Try again</Button></div>;
}

function WorkspaceTab({ active, onClick, children, className }: { active: boolean; onClick: () => void; children: ReactNode; className?: string }) {
  return <Button variant={active ? "default" : "quiet"} size="sm" className={className} role="tab" aria-selected={active} onClick={onClick}>{children}</Button>;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The task request could not be completed.";
}
