"use client";

import { Archive, Pencil } from "lucide-react";
import { Banner, Button as AstryxButton, DialogHeader, Layout, LayoutContent, MoreMenu, Text, TextInput, useToast } from "@astryxdesign/core";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type Task, type TaskCapabilities } from "../../lib/api/client";
import { Dialog, DialogFooter } from "../ui/Dialog";
import { useTaskMutationKeys } from "./task-mutation-key";

export function TaskLifecycleActions({ task, capabilities, onRefresh, disabled = false, onBusyChange }: { task: Task; capabilities: TaskCapabilities; onRefresh: () => Promise<void>; disabled?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const mutationKeys = useTaskMutationKeys();
  const showToast = useToast();
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
      showToast({ body: "Task renamed" });
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
      showToast({ body: "Task archived" });
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
      setArchiveError(message(reason, "The action could not be completed."));
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
    <Dialog isOpen={renameOpen} onOpenChange={(open) => !busy && !disabled && setRenameOpen(open)} purpose="form" width="min(34rem, calc(100vw - 2rem))" aria-label="Rename task"><Layout defaultHasDividers header={<DialogHeader title="Rename task" subtitle="Use a concise title that makes this task easy to find." onOpenChange={(open) => !busy && !disabled && setRenameOpen(open)} />} content={<LayoutContent><form id="task-rename-form" onSubmit={(event) => void rename(event)}><div className="grid gap-4">{renameError ? <Banner status="error" title="Task could not be renamed" description={renameError} /> : null}<TextInput label="Task title" isLabelHidden value={title} onChange={(value) => setTitle(value.slice(0, 160))} hasAutoFocus isDisabled={busy || disabled} width="100%" /></div></form></LayoutContent>} footer={<DialogFooter secondaryAction={<AstryxButton label="Cancel" type="button" variant="ghost" size="lg" isDisabled={busy || disabled} onClick={() => setRenameOpen(false)} />} primaryAction={<AstryxButton label={renaming ? "Saving..." : "Save title"} type="submit" form="task-rename-form" variant="primary" size="lg" isDisabled={busy || disabled || !nextTitle || !titleChanged} />} />} /></Dialog>
    <Dialog isOpen={archiveOpen} onOpenChange={closeArchive} purpose="form" role="alertdialog" width="min(32rem, calc(100vw - 2rem))" aria-labelledby="task-archive-title" aria-describedby="task-archive-description"><Layout defaultHasDividers header={<DialogHeader id="task-archive-title" title="Archive task?" />} content={<LayoutContent><form id="task-archive-form" onSubmit={(event) => { event.preventDefault(); void confirmArchive(); }}><div className="grid gap-4"><Text id="task-archive-description" as="p" display="block" color="secondary">This removes the task from the active list while keeping its conversation, File Library files, and artifacts available.</Text>{archiveError ? <Banner status="error" title="Task could not be archived" description={archiveError} /> : null}</div></form></LayoutContent>} footer={<DialogFooter secondaryAction={<AstryxButton label="Cancel" type="button" variant="ghost" size="lg" isDisabled={archiving} onClick={closeArchive} />} primaryAction={<AstryxButton label={archiving ? "Working" : "Archive task"} type="submit" form="task-archive-form" variant="destructive" size="lg" isLoading={archiving} isDisabled={archiving || disabled} />} />} /></Dialog>
  </>;
}

function message(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function shouldRefreshTask(reason: unknown): boolean {
  return isReadOnlyMutationError(reason) || (reason instanceof ApiError && reason.status === 404);
}
