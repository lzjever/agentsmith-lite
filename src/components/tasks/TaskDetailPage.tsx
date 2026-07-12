"use client";

import { Archive, ArrowLeft, Copy, ExternalLink, Pencil, RefreshCw, RotateCcw, Send, Square, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiClient, type ProjectCapabilities, type Task, type TaskArtifact, type TaskEvent, type TaskFollowUp, type TaskSummary } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { toast } from "../ui/toast";
import { TaskActivity } from "./TaskActivity";
import { TaskArtifactsPanel } from "./TaskArtifactsPanel";
import { TaskTranscript } from "./TaskTranscript";
import { isActiveTask, taskStateCopy, taskStatusLabel } from "./task-ui";
import { useTaskMutationKeys } from "./task-mutation-key";

export function TaskDetailPage({ workspaceId, projectId, taskId, artifactsOnly = false }: { workspaceId: string; projectId: string; taskId: string; artifactsOnly?: boolean }) {
  const mutationKeys = useTaskMutationKeys();
  const [task, setTask] = useState<Task>();
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([]);
  const [summary, setSummary] = useState<TaskSummary>();
  const [followUps, setFollowUps] = useState<TaskFollowUp[]>([]);
  const [capabilities, setCapabilities] = useState<ProjectCapabilities>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const [followingUp, setFollowingUp] = useState(false);
  const [refreshingArtifacts, setRefreshingArtifacts] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editing, setEditing] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const basePath = `/workspaces/${workspaceId}/projects/${projectId}/tasks`;

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState("loading");
    try {
      const [found, timeline, output, projected, nextSummary, nextFollowUps] = await Promise.all([
        apiClient.task(taskId),
        apiClient.taskEvents(taskId),
        apiClient.taskArtifacts(taskId),
        apiClient.projectCapabilities(projectId),
        apiClient.taskSummary(taskId),
        apiClient.taskFollowUps(taskId)
      ]);
      setTask(found);
      setEvents(timeline);
      setArtifacts(output);
      setCapabilities(projected);
      setSummary(nextSummary);
      setFollowUps(nextFollowUps);
      setError("");
      setState("ready");
    } catch (reason) {
      setError(message(reason));
      setState("error");
    }
  }, [projectId, taskId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!task || !isActiveTask(task.status)) return;
    const timer = window.setInterval(() => void load(true), 5_000);
    return () => window.clearInterval(timer);
  }, [load, task]);
  useEffect(() => {
    if (!task || isActiveTask(task.status) || !needsTerminalRecovery(task)) return;
    const timer = window.setInterval(() => void load(true), 5_000);
    return () => window.clearInterval(timer);
  }, [load, task]);

  const canCancel = Boolean(task && isActiveTask(task.status) && capabilities?.canCancelTasks);
  const canFollowUp = capabilities?.canCreateTasks === true;
  const canManage = capabilities?.canCreateTasks === true;

  async function refreshArtifacts() {
    setRefreshingArtifacts(true);
    try { await load(true); }
    catch (reason) { setError(message(reason)); }
    finally { setRefreshingArtifacts(false); }
  }

  async function cancel() {
    setCancelling(true);
    setError("");
    try {
      const identity = taskId;
      await apiClient.cancelTask(taskId, mutationKeys.key("task-cancel", identity));
      mutationKeys.complete("task-cancel", identity);
      await load(true);
      toast.success("Task cancellation requested");
    } catch (reason) {
      const detail = message(reason);
      setError(detail);
      toast.error(detail);
    } finally { setCancelling(false); }
  }

  async function retry(duplicate = false) {
    const operation = duplicate ? "task-duplicate" : "task-retry";
    const identity = taskId;
    try {
      const key = mutationKeys.key(operation, identity);
      const next = duplicate ? await apiClient.duplicateTask(taskId, key) : await apiClient.retryTask(taskId, key);
      mutationKeys.complete(operation, identity);
      window.location.assign(`${basePath}/${next.id}`);
    } catch (reason) { setError(message(reason)); }
  }

  async function submitFollowUp() {
    if (!followUp.trim() || followingUp) return;
    setFollowingUp(true);
    try {
      const prompt = followUp.trim();
      const identity = `${taskId}:${prompt}`;
      const saved = await apiClient.followUpTask(taskId, prompt, mutationKeys.key("task-follow-up", identity));
      mutationKeys.complete("task-follow-up", identity);
      setFollowUp("");
      setFollowUps((current) => [...current, saved]);
      if (saved.followUpTaskId) {
        window.location.assign(`${basePath}/${saved.followUpTaskId}`);
        return;
      }
      await load(true);
    } catch (reason) { setError(message(reason)); }
    finally { setFollowingUp(false); }
  }

  async function saveTitle() {
    if (!task || !editTitle.trim() || editing) return;
    const title = editTitle.trim();
    const identity = `${task.id}:${title}`;
    setEditing(true);
    setError("");
    try {
      const updated = await apiClient.updateTask(task.id, title, mutationKeys.key("task-edit", identity));
      mutationKeys.complete("task-edit", identity);
      setTask(updated);
      setEditOpen(false);
      toast.success("Task title updated");
    } catch (reason) { setError(message(reason)); }
    finally { setEditing(false); }
  }

  async function archiveTask() {
    if (!task) return;
    const updated = await apiClient.archiveTask(task.id, mutationKeys.key("task-archive", task.id));
    mutationKeys.complete("task-archive", task.id);
    setTask(updated);
    toast.success("Task archived");
  }

  async function deleteTask() {
    if (!task) return;
    await apiClient.deleteTask(task.id, mutationKeys.key("task-delete", task.id));
    mutationKeys.complete("task-delete", task.id);
    window.location.assign(basePath);
  }

  async function editFollowUp(item: TaskFollowUp, prompt: string) {
    const identity = `${item.id}:${prompt}`;
    const updated = await apiClient.updateTaskFollowUp(taskId, item.id, prompt, mutationKeys.key("follow-up-edit", identity));
    mutationKeys.complete("follow-up-edit", identity);
    setFollowUps((current) => current.map((candidate) => candidate.id === item.id ? updated : candidate));
  }

  async function deleteFollowUp(item: TaskFollowUp) {
    await apiClient.deleteTaskFollowUp(taskId, item.id, mutationKeys.key("follow-up-delete", item.id));
    mutationKeys.complete("follow-up-delete", item.id);
    setFollowUps((current) => current.filter((candidate) => candidate.id !== item.id));
  }

  if (state === "loading") return <PageLayout><PageState>Loading task...</PageState></PageLayout>;
  if (state === "error") return <PageLayout><PageState><div className="text-center"><p className="text-error" role="alert">{error}</p><Button className="mt-4" onClick={() => void load()}>Try again</Button></div></PageState></PageLayout>;
  if (!task) return null;

  const terminal = !isActiveTask(task.status);
  const header = <PageHeader title={artifactsOnly ? "Artifacts" : task.title?.trim() || "Task detail"} subtitle={`${terminalLabel(task)} · ${task.executionMode === "dry-run" ? "Dry run" : "Live execution"} · ${task.id}`} actions={<>
    <Button variant="quiet" size="icon" aria-label="Refresh task" title="Refresh task" onClick={() => void load()}><RefreshCw size={17} /></Button>
    {canManage && !artifactsOnly ? <Button variant="quiet" size="icon" aria-label="Edit task title" title="Edit task title" onClick={() => { setEditTitle(task.title?.trim() || task.prompt.slice(0, 160)); setEditOpen(true); }}><Pencil size={16} /></Button> : null}
    {terminal && canManage ? <><Button variant="quiet" onClick={() => void retry()}><RotateCcw size={15} />Retry</Button><Button variant="quiet" onClick={() => void retry(true)}><Copy size={15} />Duplicate</Button>{!task.archivedAt ? <Button variant="quiet" onClick={() => setArchiveOpen(true)}><Archive size={15} />Archive</Button> : null}<Button variant="danger" size="icon" aria-label="Delete task" title="Delete task" onClick={() => setDeleteOpen(true)}><Trash2 size={16} /></Button></> : null}
    {canCancel ? <Button variant="danger" disabled={cancelling} onClick={() => void cancel()}><Square size={15} />{cancelling ? "Cancelling..." : "Cancel task"}</Button> : null}
  </>} />;

  return <PageLayout header={header}>
    <Link className="inline-flex w-fit items-center gap-2 text-sm text-secondary hover:text-foreground" href={basePath}><ArrowLeft size={16} />All tasks</Link>
    {error ? <div className="border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">{error}</div> : null}
    {summary ? <p className="text-sm text-secondary">{summary.eventCount} events · {summary.artifactCount} artifacts</p> : null}
    <TaskStatePanel task={task} />
    {task.sourceTaskId ? <p className="text-sm text-secondary">Follow-up to <Link className="text-foreground underline" href={`${basePath}/${task.sourceTaskId}`}>{task.sourceTaskId}</Link></p> : null}
    {canFollowUp ? <FollowUpComposer active={isActiveTask(task.status)} value={followUp} busy={followingUp} onChange={setFollowUp} onSubmit={submitFollowUp} /> : null}
    {followUps.length > 0 ? <FollowUpList followUps={followUps} basePath={basePath} canManage={canManage} onEdit={editFollowUp} onDelete={deleteFollowUp} /> : null}
    {task.executionMode === "dry-run" ? <DryRunTaskDetail prompt={task.prompt} /> : artifactsOnly ? <ArtifactOnly taskId={taskId} basePath={basePath} artifacts={artifacts} onRefresh={refreshArtifacts} refreshing={refreshingArtifacts} /> : <div className="grid gap-7 xl:grid-cols-[minmax(0,1.55fr)_minmax(19rem,.75fr)]"><div className="min-w-0 space-y-8"><TaskTranscript taskId={taskId} /><section><h2 className="type-title text-foreground">Trace</h2><div className="mt-4"><TaskActivity events={events} /></div></section></div><aside className="space-y-7"><section><div className="flex items-center justify-between gap-3"><h2 className="type-title text-foreground">Artifacts</h2><Link href={`${basePath}/${taskId}/artifacts`} className="text-sm text-secondary hover:text-foreground">View all</Link></div><div className="mt-4"><TaskArtifactsPanel taskId={taskId} artifacts={artifacts} onRefresh={refreshArtifacts} refreshing={refreshingArtifacts} /></div></section><section className="border-t border-border pt-5"><h2 className="type-title text-foreground">Task input</h2><p className="mt-2 whitespace-pre-wrap text-sm text-secondary">{task.prompt}</p></section></aside></div>}
    <Dialog open={editOpen} onOpenChange={(open) => { if (!editing) { setEditOpen(open); if (!open) mutationKeys.clear("task-edit"); } }}><DialogContent><form onSubmit={(event) => { event.preventDefault(); void saveTitle(); }}><DialogHeader title="Edit task title" description="Use a short title that is easy to scan in the task list." /><div className="px-5 py-5"><Label htmlFor="task-title">Title</Label><Input id="task-title" className="mt-2" value={editTitle} maxLength={160} onChange={(event) => setEditTitle(event.target.value)} autoFocus /></div><DialogFooter><Button type="button" variant="quiet" disabled={editing} onClick={() => setEditOpen(false)}>Cancel</Button><Button type="submit" disabled={editing || !editTitle.trim()}>{editing ? "Saving..." : "Save title"}</Button></DialogFooter></form></DialogContent></Dialog>
    <ConfirmationDialog open={archiveOpen} onOpenChange={setArchiveOpen} title="Archive task?" description="The task remains available through the archived filter, including its transcript and artifacts." confirmText="Archive task" variant="default" onConfirm={archiveTask} errorContext="Task could not be archived" />
    <ConfirmationDialog open={deleteOpen} onOpenChange={setDeleteOpen} title="Delete task?" description="This removes the task from the product after its sandbox cleanup is complete." confirmText="Delete task" onConfirm={deleteTask} errorContext="Task could not be deleted" />
  </PageLayout>;
}

function TaskStatePanel({ task }: { task: Task }) {
  const resourceKinds = [...new Set(task.sandbox.resources.map((resource) => resource.kind))];
  const attention = task.status === "failed" || task.artifactProjectionStatus === "failed" || task.cleanupStatus === "failed";
  return <section className="border-y border-subtle py-4" aria-label="Sandbox summary"><h2 className="type-title text-foreground">Sandbox summary</h2><p className="mt-2 text-sm text-secondary" role={attention ? "alert" : undefined}>{taskStateCopy(task)}</p><dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2"><StateField label="Execution" value={task.executionMode === "live" ? "Live" : "Dry run"} /><StateField label="Status" value={terminalLabel(task)} /><StateField label="Namespace" value={task.sandbox.namespace} mono /><StateField label="Resources" value={resourceKinds.length ? resourceKinds.join(", ") : "None"} /><StateField label="Updated" value={new Date(task.updatedAt).toLocaleString()} />{task.artifactProjectionStatus ? <StateField label="Artifacts" value={task.artifactProjectionStatus} /> : null}{task.cleanupStatus ? <StateField label="Cleanup" value={task.cleanupStatus} /> : null}{task.finalizationIntentStatus ? <StateField label="Finalization" value={taskStatusLabel(task.finalizationIntentStatus)} /> : null}</dl>{task.artifactProjectionError ? <p className="mt-3 text-sm text-error">Artifact recovery: {task.artifactProjectionError}</p> : null}{task.cleanupError ? <p className="mt-3 text-sm text-error">Cleanup recovery: {task.cleanupError}</p> : null}</section>;
}

function StateField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div><dt className="text-tertiary">{label}</dt><dd className={mono ? "font-mono text-xs text-foreground" : "text-foreground"}>{value}</dd></div>; }

function needsTerminalRecovery(task: Task): boolean {
  return task.executionMode === "live" && (["pending", "draining", "failed"].includes(task.artifactProjectionStatus ?? "") || ["pending", "running", "failed"].includes(task.cleanupStatus ?? ""));
}

function FollowUpComposer({ active, value, busy, onChange, onSubmit }: { active: boolean; value: string; busy: boolean; onChange: (value: string) => void; onSubmit: () => Promise<void> }) {
  return <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(event) => { event.preventDefault(); void onSubmit(); }}><div className="min-w-0 flex-1"><Label htmlFor="task-follow-up">Follow-up prompt</Label><Input id="task-follow-up" value={value} onChange={(event) => onChange(event.target.value)} className="mt-1" placeholder={active ? "Send follow-up" : "Start follow-up task"} /></div><Button className="sm:shrink-0" type="submit" disabled={busy || !value.trim()}><Send size={15} />{busy ? "Starting..." : active ? "Send follow-up" : "Start follow-up"}</Button></form>;
}

function FollowUpList({ followUps, basePath, canManage, onEdit, onDelete }: { followUps: TaskFollowUp[]; basePath: string; canManage: boolean; onEdit: (item: TaskFollowUp, prompt: string) => Promise<void>; onDelete: (item: TaskFollowUp) => Promise<void> }) {
  const [editing, setEditing] = useState<TaskFollowUp>();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<TaskFollowUp>();
  const [error, setError] = useState("");
  async function save() { if (!editing || !prompt.trim()) return; setBusy(true); setError(""); try { await onEdit(editing, prompt.trim()); setEditing(undefined); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }
  async function remove() { if (!removing) return; await onDelete(removing); setRemoving(undefined); }
  return <section className="border-y border-border py-3"><h2 className="type-title text-foreground">Follow-ups</h2><ul className="mt-2 divide-y divide-border text-sm text-secondary">{followUps.map((item) => <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 py-3"><div className="min-w-0 flex-1"><p>{item.followUpTaskId ? <Link className="text-foreground underline" href={`${basePath}/${item.followUpTaskId}`}>Follow-up task</Link> : followUpLabel(item.deliveryStatus)}: <span className="text-foreground">{item.prompt}</span></p>{item.safeError ? <p className="mt-1 text-error">{item.safeError}</p> : null}</div>{canManage && item.deliveryStatus === "pending" ? <div className="flex gap-1"><Button variant="quiet" size="icon" aria-label="Edit queued follow-up" title="Edit queued follow-up" onClick={() => { setEditing(item); setPrompt(item.prompt); setError(""); }}><Pencil size={15} /></Button><Button variant="quiet" size="icon" aria-label="Delete queued follow-up" title="Delete queued follow-up" onClick={() => setRemoving(item)}><Trash2 size={15} /></Button></div> : null}</li>)}</ul><Dialog open={Boolean(editing)} onOpenChange={(open) => { if (!open && !busy) setEditing(undefined); }}><DialogContent><form onSubmit={(event) => { event.preventDefault(); void save(); }}><DialogHeader title="Edit queued follow-up" description="Only follow-ups that have not started delivery can be changed." />{error ? <p className="mx-5 mt-4 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">{error}</p> : null}<div className="px-5 py-5"><Label htmlFor="queued-follow-up">Prompt</Label><Input id="queued-follow-up" className="mt-2" value={prompt} onChange={(event) => setPrompt(event.target.value)} autoFocus /></div><DialogFooter><Button type="button" variant="quiet" disabled={busy} onClick={() => setEditing(undefined)}>Cancel</Button><Button type="submit" disabled={busy || !prompt.trim()}>{busy ? "Saving..." : "Save follow-up"}</Button></DialogFooter></form></DialogContent></Dialog><ConfirmationDialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(undefined)} title="Delete queued follow-up?" description="The prompt has not started delivery and can be removed safely." confirmText="Delete follow-up" onConfirm={remove} errorContext="Follow-up could not be deleted" /></section>;
}

function followUpLabel(status: TaskFollowUp["deliveryStatus"]): string { return status === "pending" ? "Queued follow-up" : status === "dispatching" ? "Sending follow-up" : status === "terminal_pending" ? "Waiting for task delivery to settle" : status === "failed" ? "Follow-up delivery failed" : "Sent to active task"; }

function DryRunTaskDetail({ prompt }: { prompt: string }) { return <section className="border-y border-border py-5" aria-labelledby="dry-run-title"><h2 id="dry-run-title" className="type-title text-foreground">Dry run</h2><p className="mt-2 text-sm text-secondary">This task was created in dry-run mode. No sandbox resources, runtime events, or artifacts are expected.</p><div className="mt-5 border-t border-border pt-5"><h3 className="type-title text-foreground">Task input</h3><p className="mt-2 whitespace-pre-wrap text-sm text-secondary">{prompt}</p></div></section>; }

function ArtifactOnly({ taskId, basePath, artifacts, onRefresh, refreshing }: { taskId: string; basePath: string; artifacts: TaskArtifact[]; onRefresh: () => Promise<void>; refreshing: boolean }) { return <section><div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 className="type-title text-foreground">Published artifacts</h2><p className="mt-1 text-sm text-secondary">Files retained by the product after the sandbox lifecycle ends.</p></div><Link href={`${basePath}/${taskId}`} className="inline-flex shrink-0 items-center gap-1 text-sm text-secondary hover:text-foreground">Task activity <ExternalLink size={14} /></Link></div><TaskArtifactsPanel taskId={taskId} artifacts={artifacts} onRefresh={onRefresh} refreshing={refreshing} /></section>; }

function terminalLabel(task: Task): string { return task.terminalReason === "cancelled" ? "Cancelled" : task.terminalReason === "not_executed" ? "Not executed" : task.terminalReason === "cleaned_legacy" ? "Cleaned up" : task.terminalReason ? task.terminalReason.replaceAll("_", " ") : taskStatusLabel(task.status); }
function message(error: unknown): string { return error instanceof Error ? error.message : "The task could not be loaded."; }
