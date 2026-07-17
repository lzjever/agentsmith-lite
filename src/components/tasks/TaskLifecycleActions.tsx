"use client";

import { Archive, Copy, Ellipsis, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type Task, type TaskCapabilities } from "../../lib/api/client";
import { appPath } from "../../lib/navigation/app-path";
import { Button } from "../ui/button";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "../ui/dialog";
import { DropdownContent, DropdownItem, DropdownMenu } from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { toast } from "../ui/toast";
import { useTaskMutationKeys } from "./task-mutation-key";

type TaskAction = "duplicate" | "retry";

export function TaskLifecycleActions({ task, capabilities, basePath, onRefresh, disabled = false, onBusyChange }: { task: Task; capabilities: TaskCapabilities; basePath: string; onRefresh: () => Promise<void>; disabled?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const mutationKeys = useTaskMutationKeys();
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [title, setTitle] = useState(task.title ?? "");
  const [renameError, setRenameError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [running, setRunning] = useState<TaskAction>();
  const [archiving, setArchiving] = useState(false);
  const busy = renaming || Boolean(running) || archiving;
  const nextTitle = title.trim();
  const titleChanged = nextTitle !== (task.title ?? "").trim();

  useEffect(() => {
    if (!capabilities.editTask) setRenameOpen(false);
    if (!capabilities.archiveTask) setArchiveOpen(false);
  }, [capabilities.archiveTask, capabilities.editTask]);
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  const available = capabilities.editTask || capabilities.retryTask || capabilities.duplicateTask || capabilities.archiveTask;
  if (!available) return null;

  function openRename() {
    setTitle(task.title ?? "");
    setRenameError("");
    setRenameOpen(true);
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!nextTitle || !titleChanged || busy || disabled || !capabilities.editTask) return;
    setRenaming(true);
    setRenameError("");
    const identity = `${task.id}:${nextTitle}`;
    try {
      await apiClient.editTask(task.id, nextTitle, mutationKeys.key("task-edit", identity));
      mutationKeys.complete("task-edit", identity);
      setRenameOpen(false);
      await onRefresh();
      toast.success("Task renamed");
    } catch (reason) {
      mutationKeys.completeApiFailure(reason, "task-edit", identity);
      if (shouldRefreshTask(reason)) await onRefresh();
      setRenameError(message(reason, "Task could not be renamed."));
    } finally { setRenaming(false); }
  }

  async function createSuccessor(action: TaskAction) {
    if (busy || disabled || !capabilities[action === "retry" ? "retryTask" : "duplicateTask"]) return;
    setRunning(action);
    try {
      const created = action === "retry"
        ? await apiClient.retryTask(task.id, mutationKeys.key("task-retry", task.id))
        : await apiClient.duplicateTask(task.id, mutationKeys.key("task-duplicate", task.id));
      mutationKeys.complete(action === "retry" ? "task-retry" : "task-duplicate", task.id);
      window.location.assign(appPath(`${basePath}/${created.id}`));
    } catch (reason) {
      mutationKeys.completeApiFailure(reason, action === "retry" ? "task-retry" : "task-duplicate", task.id);
      if (shouldRefreshTask(reason)) await onRefresh();
      toast.error(message(reason, action === "retry" ? "Task could not be retried." : "Task could not be duplicated."));
      setRunning(undefined);
    }
  }

  async function archive() {
    if (busy || disabled || !capabilities.archiveTask) return;
    setArchiving(true);
    try {
      await apiClient.archiveTask(task.id, mutationKeys.key("task-archive", task.id));
      mutationKeys.complete("task-archive", task.id);
      await onRefresh();
      toast.success("Task archived");
    } catch (reason) {
      mutationKeys.completeApiFailure(reason, "task-archive", task.id);
      if (shouldRefreshTask(reason)) await onRefresh();
      throw reason;
    } finally {
      setArchiving(false);
    }
  }

  return <>
    <DropdownMenu.Root><DropdownMenu.Trigger asChild><Button variant="quiet" size="icon" aria-label="Task actions" title="Task actions" disabled={busy || disabled}><Ellipsis size={17} /></Button></DropdownMenu.Trigger><DropdownContent align="end">
      {capabilities.editTask ? <DropdownItem className="gap-2" onSelect={openRename}><Pencil size={15} />Rename</DropdownItem> : null}
      {capabilities.duplicateTask ? <DropdownItem className="gap-2" disabled={Boolean(running)} onSelect={() => void createSuccessor("duplicate")}><Copy size={15} />{running === "duplicate" ? "Duplicating..." : "Duplicate"}</DropdownItem> : null}
      {capabilities.retryTask ? <DropdownItem className="gap-2" disabled={Boolean(running)} onSelect={() => void createSuccessor("retry")}><RotateCcw size={15} />{running === "retry" ? "Retrying..." : "Retry"}</DropdownItem> : null}
      {capabilities.archiveTask ? <><DropdownMenu.Separator className="my-1 h-px bg-subtle" /><DropdownItem className="gap-2" onSelect={() => setArchiveOpen(true)}><Archive size={15} />Archive</DropdownItem></> : null}
    </DropdownContent></DropdownMenu.Root>
    <Dialog open={renameOpen} onOpenChange={(open) => !busy && !disabled && setRenameOpen(open)}><DialogContent><form onSubmit={(event) => void rename(event)}><DialogHeader title="Rename task" description="Use a concise title that makes this task easy to find." />{renameError ? <p className="mx-5 mt-4 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">{renameError}</p> : null}<div className="px-5 py-5"><label className="grid gap-1.5 text-sm text-secondary">Task title<Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} autoFocus disabled={busy || disabled} /></label></div><DialogFooter><Button type="button" variant="quiet" disabled={busy || disabled} onClick={() => setRenameOpen(false)}>Cancel</Button><Button type="submit" disabled={busy || disabled || !nextTitle || !titleChanged}>{renaming ? "Saving..." : "Save title"}</Button></DialogFooter></form></DialogContent></Dialog>
    <ConfirmationDialog open={archiveOpen} onOpenChange={(open) => { if (!open || (!busy && !disabled)) setArchiveOpen(open); }} title="Archive task?" description="This removes the task from the active list while keeping its conversation, inputs, and artifacts available." confirmText="Archive task" confirmDisabled={disabled} onConfirm={archive} errorContext="Task could not be archived" />
  </>;
}

function message(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function shouldRefreshTask(reason: unknown): boolean {
  return isReadOnlyMutationError(reason) || (reason instanceof ApiError && reason.status === 404);
}
