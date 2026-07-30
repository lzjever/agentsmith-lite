"use client";

import { Archive, Pencil, Power, Trash2 } from "lucide-react";
import { Banner, Button as AstryxButton, Dialog, DialogHeader, MoreMenu, Text, TextInput, useToast } from "@astryxdesign/core";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type Task, type TaskCapabilities } from "../../lib/api/client";
import { useTaskMutationKeys } from "./task-mutation-key";

export function TaskLifecycleActions({ task, capabilities, releaseRunId, releaseLabel, onRefresh, onRelease, onDelete, disabled = false, onBusyChange }: { task: Task; capabilities: TaskCapabilities; releaseRunId:string|null;releaseLabel: string; onRefresh: () => Promise<void>; onRelease: (expectedRunId:string) => Promise<void>; onDelete: () => Promise<void>; disabled?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const mutationKeys = useTaskMutationKeys();
  const showToast = useToast();
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseTargetRunId,setReleaseTargetRunId]=useState<string|null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [title, setTitle] = useState(task.title ?? "");
  const [renameError, setRenameError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [releaseError, setReleaseError] = useState("");
  const [releasing, setReleasing] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const busy = renaming || archiving || releasing || deleting;
  const nextTitle = title.trim();
  const titleChanged = nextTitle !== (task.title ?? "").trim();
  const archiveDescriptionId = useId();
  const releaseDescriptionId = useId();
  const deleteDescriptionId = useId();

  useEffect(() => {
    if (!capabilities.editTask) setRenameOpen(false);
    if (!capabilities.archiveTask) {
      setArchiveOpen(false);
      setArchiveError("");
    }
    if (!capabilities.releaseSandbox) {
      setReleaseOpen(false);
      setReleaseTargetRunId(null);
      setReleaseError("");
    }
    if (!capabilities.deleteTask) {
      setDeleteOpen(false);
      setDeleteError("");
    }
  }, [capabilities.archiveTask, capabilities.deleteTask, capabilities.editTask, capabilities.releaseSandbox]);
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  const available = capabilities.editTask || capabilities.archiveTask || capabilities.releaseSandbox || capabilities.deleteTask;
  if (!available) return null;

  function restoreMenuFocus() {
    requestAnimationFrame(() => menuTrigger.current?.focus({ preventScroll: true }));
  }

  function closeRename() {
    if (renaming) return;
    setRenameError("");
    setRenameOpen(false);
    restoreMenuFocus();
  }

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
    let renamed = false;
    try {
      await apiClient.editTask(task.id, nextTitle, mutationKeys.key("task-edit", identity));
      mutationKeys.complete("task-edit", identity);
      await onRefresh();
      renamed = true;
    } catch (reason) {
      mutationKeys.completeApiFailure(reason, "task-edit", identity);
      if (shouldRefreshTask(reason)) await onRefresh();
      setRenameError(message(reason, "Task could not be renamed."));
    } finally {
      setRenaming(false);
    }
    if (renamed) {
      setRenameOpen(false);
      restoreMenuFocus();
      showToast({ body: "Task renamed" });
    }
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
      restoreMenuFocus();
    } catch (reason) {
      setArchiveError(message(reason, "The action could not be completed."));
    }
  }

  function closeArchive() {
    if (archiving) return;
    setArchiveError("");
    setArchiveOpen(false);
    restoreMenuFocus();
  }

  async function confirmRelease() {
    if (busy || disabled || !capabilities.releaseSandbox) return;
    setReleasing(true);
    setReleaseError("");
    let released = false;
    try {
      if(!releaseTargetRunId)throw new Error("The Sandbox Run changed before confirmation.");
      await onRelease(releaseTargetRunId);
      released = true;
    } catch (reason) {
      setReleaseError(message(reason, "The Sandbox could not be released."));
    } finally {
      setReleasing(false);
    }
    if (released) {
      setReleaseOpen(false);
      setReleaseTargetRunId(null);
      restoreMenuFocus();
    }
  }

  function closeRelease() {
    if (releasing) return;
    setReleaseError("");
    setReleaseOpen(false);
    setReleaseTargetRunId(null);
    restoreMenuFocus();
  }

  async function confirmDelete() {
    if (busy || disabled || !capabilities.deleteTask) return;
    setDeleting(true);
    setDeleteError("");
    let deleted = false;
    try {
      await onDelete();
      deleted = true;
    } catch (reason) {
      setDeleteError(message(reason, "The Task could not be deleted."));
    } finally {
      setDeleting(false);
    }
    if (deleted) {
      setDeleteOpen(false);
      restoreMenuFocus();
    }
  }

  function closeDelete() {
    if (deleting) return;
    setDeleteError("");
    setDeleteOpen(false);
    restoreMenuFocus();
  }

  return <>
    <MoreMenu ref={menuTrigger} label="Task actions" size="lg" isDisabled={busy || disabled} items={[
      ...(capabilities.editTask ? [{ label: "Rename", icon: <Pencil size={15} />, onClick: openRename }] : []),
      ...(capabilities.archiveTask ? [{ label: "Archive", icon: <Archive size={15} />, onClick: () => setArchiveOpen(true) }] : []),
      ...((capabilities.releaseSandbox || capabilities.deleteTask) && (capabilities.editTask || capabilities.archiveTask) ? [{ type: "divider" as const }] : []),
      ...(capabilities.releaseSandbox&&releaseRunId ? [{ label: releaseLabel, icon: <Power size={15} />, onClick: () => {setReleaseTargetRunId(releaseRunId);setReleaseOpen(true);} }] : []),
      ...(capabilities.deleteTask ? [{ label: "Delete task", icon: <Trash2 size={15} />, onClick: () => setDeleteOpen(true) }] : []),
    ]} />
    <Dialog
      className="[&_button]:min-h-11 [&_button]:min-w-11"
      isOpen={renameOpen}
      onOpenChange={(open) => { if (open) setRenameOpen(true); else closeRename(); }}
      purpose="form"
      padding={0}
      width="min(34rem, calc(100dvw - 1rem))"
      maxHeight="calc(100dvh - 1rem)"
      aria-label="Rename task"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DialogHeader className="p-4 sm:p-5" title="Rename task" subtitle="Use a concise title that makes this task easy to find." hasDivider {...(!busy && !disabled ? { onOpenChange: (open: boolean) => { if (!open) closeRename(); } } : {})} />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-5">
          <form id="task-rename-form" onSubmit={(event) => void rename(event)}>
            <div className="grid gap-4">
              {renameError ? <Banner status="error" title="Task could not be renamed" description={renameError} /> : null}
              <TextInput label="Task title" value={title} onChange={(value) => setTitle(value.slice(0, 160))} hasAutoFocus data-autofocus="" isDisabled={busy || disabled} width="100%" />
            </div>
          </form>
        </div>
        <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:p-5 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
          <AstryxButton label="Cancel" type="button" variant="ghost" size="lg" isDisabled={busy || disabled} onClick={closeRename} />
          <AstryxButton label={renaming ? "Saving..." : "Save title"} type="submit" form="task-rename-form" variant="primary" size="lg" isLoading={renaming} isDisabled={busy || disabled || !nextTitle || !titleChanged} />
        </div>
      </div>
    </Dialog>
    <Dialog
      className="[&_button]:min-h-11 [&_button]:min-w-11"
      isOpen={archiveOpen}
      onOpenChange={(open) => { if (!open) closeArchive(); }}
      purpose={archiving ? "required" : "form"}
      role="alertdialog"
      padding={0}
      width="min(32rem, calc(100dvw - 1rem))"
      maxHeight="calc(100dvh - 1rem)"
      aria-label="Archive task?"
      aria-describedby={archiveDescriptionId}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DialogHeader className="p-4 sm:p-5" title="Archive task?" hasDivider />
        <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          <Text id={archiveDescriptionId} as="p" display="block" color="secondary">This removes the task from the active list while keeping its conversation, File Library files, and artifacts available.</Text>
          {archiveError ? <Banner status="error" title="Task could not be archived" description={archiveError} /> : null}
        </div>
        <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:p-5 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
          <AstryxButton data-autofocus="" label="Cancel" type="button" variant="ghost" size="lg" isDisabled={archiving} onClick={closeArchive} />
          <AstryxButton label={archiving ? "Working" : archiveError ? "Try archive again" : "Archive task"} type="button" variant="primary" size="lg" isLoading={archiving} isDisabled={archiving || disabled} onClick={() => void confirmArchive()} />
        </div>
      </div>
    </Dialog>
    <Dialog
      className="[&_button]:min-h-11 [&_button]:min-w-11"
      isOpen={releaseOpen}
      onOpenChange={(open) => { if (!open) closeRelease(); }}
      purpose={releasing ? "required" : "form"}
      role="alertdialog"
      padding={0}
      width="min(32rem, calc(100dvw - 1rem))"
      maxHeight="calc(100dvh - 1rem)"
      aria-label={`${releaseLabel}?`}
      aria-describedby={releaseDescriptionId}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DialogHeader className="p-4 sm:p-5" title={`${releaseLabel}?`} hasDivider />
        <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          <Text id={releaseDescriptionId} as="p" display="block" color="secondary">Releasing stops the agent, Terminal, tools, and processes unconditionally, which may lose unsaved information. The Task conversation, Library files, and published Artifacts remain available.</Text>
          {releaseError ? <Banner status="error" title="Sandbox could not be released" description={releaseError} /> : null}
        </div>
        <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:p-5 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
          <AstryxButton data-autofocus="" label="Cancel" type="button" variant="ghost" size="lg" isDisabled={releasing} onClick={closeRelease} />
          <AstryxButton label={releasing ? "Working" : releaseError ? `Try ${releaseLabel.toLowerCase()} again` : releaseLabel} type="button" variant="destructive" size="lg" isLoading={releasing} isDisabled={releasing || disabled} onClick={() => void confirmRelease()} />
        </div>
      </div>
    </Dialog>
    <Dialog
      className="[&_button]:min-h-11 [&_button]:min-w-11"
      isOpen={deleteOpen}
      onOpenChange={(open) => { if (!open) closeDelete(); }}
      purpose={deleting ? "required" : "form"}
      role="alertdialog"
      padding={0}
      width="min(32rem, calc(100dvw - 1rem))"
      maxHeight="calc(100dvh - 1rem)"
      aria-label="Delete task?"
      aria-describedby={deleteDescriptionId}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DialogHeader className="p-4 sm:p-5" title="Delete task?" hasDivider />
        <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          <Text id={deleteDescriptionId} as="p" display="block" color="secondary">This permanently removes the Task conversation, Botified session data, and Task Artifacts. Ordinary Library files are retained, and the Library becomes available after the purge completes.</Text>
          {deleteError ? <Banner status="error" title="Task could not be deleted" description={deleteError} /> : null}
        </div>
        <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:p-5 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
          <AstryxButton data-autofocus="" label="Cancel" type="button" variant="ghost" size="lg" isDisabled={deleting} onClick={closeDelete} />
          <AstryxButton label={deleting ? "Deleting..." : deleteError ? "Try delete again" : "Delete task"} type="button" variant="destructive" size="lg" isLoading={deleting} isDisabled={deleting || disabled} onClick={() => void confirmDelete()} />
        </div>
      </div>
    </Dialog>
  </>;
}

function message(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function shouldRefreshTask(reason: unknown): boolean {
  return isReadOnlyMutationError(reason) || (reason instanceof ApiError && reason.status === 404);
}
