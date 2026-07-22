"use client";

import { Archive, Pencil } from "lucide-react";
import { Button as AstryxButton, Dialog, DialogHeader, MoreMenu, TextInput } from "@astryxdesign/core";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type Task, type TaskCapabilities } from "../../lib/api/client";
import { toast } from "../ui/toast";
import { useTaskMutationKeys } from "./task-mutation-key";

export function TaskLifecycleActions({ task, capabilities, onRefresh, disabled = false, onBusyChange }: { task: Task; capabilities: TaskCapabilities; onRefresh: () => Promise<void>; disabled?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const mutationKeys = useTaskMutationKeys();
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [title, setTitle] = useState(task.title ?? "");
  const [renameError, setRenameError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const busy = renaming || archiving;
  const nextTitle = title.trim();
  const titleChanged = nextTitle !== (task.title ?? "").trim();

  useEffect(() => {
    if (!capabilities.editTask) setRenameOpen(false);
    if (!capabilities.archiveTask) setArchiveOpen(false);
  }, [capabilities.archiveTask, capabilities.editTask]);
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  const available = capabilities.editTask || capabilities.archiveTask;
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

  async function confirmArchive() {
    setArchiveError("");
    try {
      await archive();
      setArchiveOpen(false);
    } catch (reason) {
      setArchiveError(`Task could not be archived: ${message(reason, "The action could not be completed.")}`);
    }
  }

  function closeArchive() {
    if (archiving) return;
    setArchiveError("");
    setArchiveOpen(false);
  }

  return <>
    <MoreMenu label="Task actions" size="lg" isDisabled={busy || disabled} items={[
      ...(capabilities.editTask ? [{ label: "Rename", icon: <Pencil size={15} />, onClick: openRename }] : []),
      ...(capabilities.archiveTask ? [{ label: "Archive", icon: <Archive size={15} />, onClick: () => setArchiveOpen(true) }] : []),
    ]} />
    <Dialog isOpen={renameOpen} onOpenChange={(open) => !busy && !disabled && setRenameOpen(open)} purpose="info" width="min(34rem, calc(100vw - 2rem))" padding={0} aria-label="Rename task"><form onSubmit={(event) => void rename(event)}><DialogHeader title="Rename task" subtitle="Use a concise title that makes this task easy to find." onOpenChange={(open) => !busy && !disabled && setRenameOpen(open)} hasDivider padding={5} />{renameError ? <p className="mx-5 mt-4 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">{renameError}</p> : null}<div className="px-5 py-5"><TextInput label="Task title" value={title} onChange={setTitle} maxLength={160} hasAutoFocus isDisabled={busy || disabled} /></div><footer className="flex flex-col-reverse gap-2 border-t border-subtle px-5 py-4 sm:flex-row sm:justify-end md:px-6"><AstryxButton label="Cancel" type="button" variant="ghost" size="lg" isDisabled={busy || disabled} onClick={() => setRenameOpen(false)} /><AstryxButton label={renaming ? "Saving..." : "Save title"} type="submit" variant="primary" size="lg" isDisabled={busy || disabled || !nextTitle || !titleChanged} /></footer></form></Dialog>
    <Dialog isOpen={archiveOpen} onOpenChange={closeArchive} purpose="required" width="min(32rem, calc(100vw - 2rem))" padding={0} aria-label="Archive task"><form onSubmit={(event) => { event.preventDefault(); void confirmArchive(); }}><DialogHeader title="Archive task?" subtitle="This removes the task from the active list while keeping its conversation, File Library files, and artifacts available." hasDivider padding={5} />{archiveError ? <div role="alert" className="mx-5 mt-4 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">{archiveError}</div> : null}<footer className="flex flex-col-reverse gap-2 border-t border-subtle px-5 py-4 sm:flex-row sm:justify-end md:px-6"><AstryxButton label="Cancel" type="button" variant="ghost" size="lg" isDisabled={archiving} onClick={closeArchive} /><AstryxButton label={archiving ? "Working" : "Archive task"} type="submit" variant="destructive" size="lg" isLoading={archiving} isDisabled={archiving || disabled} /></footer></form></Dialog>
  </>;
}

function message(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function shouldRefreshTask(reason: unknown): boolean {
  return isReadOnlyMutationError(reason) || (reason instanceof ApiError && reason.status === 404);
}
