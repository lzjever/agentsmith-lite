"use client";

import { Pencil, Send, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Banner, Button, Dialog, DialogHeader, IconButton, Text, TextArea } from "@astryxdesign/core";
import type { TaskCapabilities, TaskQueuedMessage } from "../../lib/api/client";
import { TaskCommandStorageUnavailableError } from "./task-command-storage";
import {
  clearTaskDraft,
  restoreTaskDraft,
  TASK_DRAFT_STORAGE_NOTICE,
  taskDraftStorage,
  writeTaskDraft,
  type TaskDraftIdentity
} from "./task-draft-snapshot";
import { sandboxCapacityRecovery, type SandboxCapacityRecovery } from "./sandbox-capacity-recovery";
import { SandboxCapacityRecoveryNotice } from "./SandboxCapacityRecoveryNotice";

export function TaskComposer({ userId, projectId, taskId, activeSandboxesHref, canManagePolicy, policyHref, capabilities, queuedMessages, busy, payloadLocked, storageUnavailable, recoveredSubmission, unavailableMessage = "Messaging is unavailable", onSend, onUpdateQueued, onDeleteQueued }: { userId: string; projectId: string; taskId: string; activeSandboxesHref: string; canManagePolicy: boolean; policyHref: string; capabilities: TaskCapabilities; queuedMessages: TaskQueuedMessage[]; busy: boolean; payloadLocked: boolean; storageUnavailable: boolean; recoveredSubmission: { sequence: number; draft: string } | null; unavailableMessage?: string; onSend: (content: string, submittedDraft: string) => Promise<void>; onUpdateQueued: (messageId: string, content: string) => Promise<void>; onDeleteQueued: (messageId: string) => Promise<void> }) {
  const composer = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<TaskQueuedMessage>();
  const [editDraft, setEditDraft] = useState("");
  const [removing, setRemoving] = useState<TaskQueuedMessage>();
  const [sendError, setSendError] = useState("");
  const [sendErrorTitle, setSendErrorTitle] = useState("Message could not be sent");
  const [capacityRecovery, setCapacityRecovery] = useState<SandboxCapacityRecovery | null>(null);
  const [draftNotice, setDraftNotice] = useState("");
  const [editError, setEditError] = useState("");
  const [removeError, setRemoveError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rejectedFocusSequence, setRejectedFocusSequence] = useState(0);
  const rejectedFocusRequest = useRef(false);
  const submittingDraft = useRef<string | null>(null);
  const recoveredSubmissionSequence = useRef(recoveredSubmission?.sequence ?? 0);
  recoveredSubmissionSequence.current = recoveredSubmission?.sequence ?? 0;
  const messageBusy = busy || submitting || saving || deleting;
  const composerEditable = capabilities.sendMessage && !messageBusy && !payloadLocked;
  const nextEdit = editDraft.trim();
  const editChanged = Boolean(editing) && nextEdit !== editing?.content.trim();
  const draftIdentity: TaskDraftIdentity = { userId, projectId, taskId };
  const previousDraftIdentity = useRef<TaskDraftIdentity | undefined>(undefined);
  const removeDescriptionId = useId();

  useEffect(() => {
    const previous = previousDraftIdentity.current;
    if (previous && previous.userId !== userId) {
      clearTaskDraft(taskDraftStorage(), previous);
    }
    previousDraftIdentity.current = draftIdentity;
    const storage = taskDraftStorage();
    const restored = restoreTaskDraft(storage, draftIdentity);
    if (restored.status === "corrupt") clearTaskDraft(storage, draftIdentity);
    setDraft(restored.draft);
    setDraftNotice(restored.status === "unavailable" ? TASK_DRAFT_STORAGE_NOTICE : "");
  }, [projectId, taskId, userId]);

  useEffect(() => {
    if (messageBusy) return;
    if (editing && !queuedMessages.some((message) => message.id === editing.id)) {
      setEditing(undefined);
      setEditError("");
    }
    if (removing && !queuedMessages.some((message) => message.id === removing.id)) {
      setRemoving(undefined);
      setRemoveError("");
    }
  }, [editing, messageBusy, queuedMessages, removing]);

  useEffect(() => {
    if (!rejectedFocusRequest.current) return;
    rejectedFocusRequest.current = false;
    if (!composerEditable) return;
    const frame = requestAnimationFrame(() => {
      const element = input.current;
      if (!element || element.disabled || element.readOnly) return;
      element.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [composerEditable, rejectedFocusSequence]);

  useEffect(() => {
    if (!recoveredSubmission) return;
    setSendError("");
    setSendErrorTitle("Message could not be sent");
    setCapacityRecovery(null);
    setDraft((current) => current === recoveredSubmission.draft ? "" : current);
    setDraftNotice("");
  }, [recoveredSubmission]);

  async function submit() {
    const submittedDraft = draft;
    const startingRecoverySequence = recoveredSubmissionSequence.current;
    const content = draft.trim();
    if (
      !content
      || messageBusy
      || submittingDraft.current !== null
      || !capabilities.sendMessage
    ) return;
    submittingDraft.current = submittedDraft;
    setSendError("");
    setSendErrorTitle("Message could not be sent");
    setCapacityRecovery(null);
    setSubmitting(true);
    try {
      await onSend(content, submittedDraft);
      setDraft((current) => {
        if (current !== submittedDraft) return current;
        setDraftNotice("");
        return "";
      });
      if (composerEditable && composer.current?.contains(document.activeElement)) {
        requestAnimationFrame(() => input.current?.focus());
      }
    } catch (reason) {
      if (recoveredSubmissionSequence.current !== startingRecoverySequence) {
        setSendError("");
        setCapacityRecovery(null);
        return;
      }
      if (reason instanceof TaskCommandStorageUnavailableError) {
        setSendError("");
        setCapacityRecovery(null);
        setDraftNotice(TASK_DRAFT_STORAGE_NOTICE);
        return;
      }
      const recovery = sandboxCapacityRecovery(reason);
      setCapacityRecovery(recovery);
      setSendError(errorMessage(reason, "The message could not be sent."));
      if (
        reason instanceof Error
        && "code" in reason
        && (
          reason.code === "project_sandbox_capacity_reached"
          || reason.code === "substrate_sandbox_capacity_reached"
          || reason.code === "sandbox_start_failed"
        )
      ) setSendErrorTitle("Sandbox could not be started");
      rejectedFocusRequest.current = true;
      setRejectedFocusSequence((sequence) => sequence + 1);
    } finally {
      submittingDraft.current = null;
      setSubmitting(false);
    }
  }

  function changeDraft(value: string) {
    if (payloadLocked || submittingDraft.current !== null || messageBusy) return;
    setDraft(value);
    const outcome = writeTaskDraft(taskDraftStorage(), draftIdentity, value);
    setDraftNotice(outcome === "saved" ? "" : TASK_DRAFT_STORAGE_NOTICE);
  }
  async function saveEdit() {
    if (!editing || !nextEdit || !editChanged || messageBusy) return;
    setSaving(true);
    setEditError("");
    try {
      await onUpdateQueued(editing.id, nextEdit);
      setEditing(undefined);
    } catch (reason) {
      setEditError(errorMessage(reason, "The queued message could not be updated."));
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (!removing || messageBusy) return;
    setRemoveError("");
    setDeleting(true);
    try {
      await onDeleteQueued(removing.id);
      setRemoving(undefined);
      requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    } catch (reason) {
      setRemoveError(errorMessage(reason, "The queued message could not be deleted."));
    } finally {
      setDeleting(false);
    }
  }

  function closeEdit() {
    setEditing(undefined);
    setEditError("");
  }

  function closeRemove() {
    setRemoving(undefined);
    setRemoveError("");
  }

  return <section ref={composer} className="shrink-0 border-t border-border bg-surface px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:px-5" aria-label="Task message composer">
    {queuedMessages.length ? <ul className="mb-3 max-h-36 overflow-y-auto divide-y divide-border border-y border-border">{queuedMessages.map((message) => <li key={message.id} className="flex min-w-0 items-start justify-between gap-3 py-2.5"><div className="min-w-0"><Text display="block" type="supporting" className="break-words">{message.content}</Text><Text display="block" type="code" color="secondary" className="mt-1">{readableStatus(message.deliveryStatus)}</Text>{message.safeError ? <Text display="block" type="supporting" className="mt-1 break-words text-error">{message.safeError}</Text> : null}</div><div className="flex shrink-0 gap-1">{capabilities.editQueuedMessage && message.editable ? <IconButton label="Edit queued message" tooltip="Edit queued message" variant="ghost" size="lg" icon={<Pencil size={15} />} isDisabled={messageBusy} onClick={() => { setEditing(message); setEditDraft(message.content); setEditError(""); }} /> : null}{capabilities.sendMessage && message.deletable ? <IconButton label="Delete queued message" tooltip="Delete queued message" variant="ghost" size="lg" icon={<Trash2 size={15} />} isDisabled={messageBusy} onClick={() => { setRemoveError(""); setRemoving(message); }} /> : null}</div></li>)}</ul> : null}
    {capacityRecovery ? <SandboxCapacityRecoveryNotice className="mb-3" recovery={capacityRecovery} activeSandboxesHref={activeSandboxesHref} canManagePolicy={canManagePolicy} policyHref={policyHref} title="Sandbox could not be started" /> : null}
    {sendError && !capacityRecovery ? <Banner className="mb-3" status="error" title={sendErrorTitle} description={sendError} /> : null}
    {draftNotice || storageUnavailable ? <Text as="p" display="block" type="supporting" color="secondary" className="mb-2" role="status">{TASK_DRAFT_STORAGE_NOTICE}</Text> : null}
    <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}><div className="min-w-0 flex-1"><TextArea ref={input} label="Message" isLabelHidden value={draft} onChange={changeDraft} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} isDisabled={!capabilities.sendMessage || messageBusy || payloadLocked} placeholder={capabilities.sendMessage ? "Message the task" : unavailableMessage} rows={2} width="100%" /></div><IconButton type="submit" label="Send message" tooltip="Send message" size="lg" icon={<Send size={16} />} isDisabled={!capabilities.sendMessage || messageBusy || !draft.trim()} /></form>
    <Dialog
      className="[&_button]:min-h-11 [&_button]:min-w-11"
      isOpen={Boolean(editing)}
      onOpenChange={(open) => { if (!open && !messageBusy) closeEdit(); }}
      purpose="form"
      padding={0}
      width="min(34rem, calc(100dvw - 1rem))"
      maxHeight="calc(100dvh - 1rem)"
      aria-label="Edit queued message"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DialogHeader className="p-4 sm:p-5" title="Edit queued message" subtitle="Only messages the server still accepts can be changed." hasDivider {...(!messageBusy ? { onOpenChange: (open: boolean) => { if (!open) closeEdit(); } } : {})} />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-5">
          <form id="queued-message-edit-form" onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}>
            <div className="grid gap-4">
              {editError ? <Banner status="error" title="Message could not be updated" description={editError} /> : null}
              <TextArea label="Queued message" value={editDraft} onChange={setEditDraft} isDisabled={messageBusy} rows={5} hasAutoFocus data-autofocus="" width="100%" />
            </div>
          </form>
        </div>
        <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:p-5 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
          <Button label="Cancel" type="button" variant="ghost" size="lg" isDisabled={messageBusy} onClick={closeEdit} />
          <Button type="submit" form="queued-message-edit-form" label={saving ? "Saving..." : "Save message"} variant="primary" size="lg" isLoading={saving} isDisabled={messageBusy || !nextEdit || !editChanged} />
        </div>
      </div>
    </Dialog>
    <Dialog
      className="[&_button]:min-h-11 [&_button]:min-w-11"
      isOpen={Boolean(removing)}
      onOpenChange={(open) => { if (!open && !deleting) closeRemove(); }}
      purpose={deleting ? "required" : "form"}
      role="alertdialog"
      padding={0}
      width="min(32rem, calc(100dvw - 1rem))"
      maxHeight="calc(100dvh - 1rem)"
      aria-label="Delete queued message?"
      aria-describedby={removeDescriptionId}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DialogHeader className="p-4 sm:p-5" title="Delete queued message?" hasDivider />
        <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          <Text id={removeDescriptionId} as="p" display="block" color="secondary">This message has not started delivery and can be removed.</Text>
          {removeError ? <Banner status="error" title="Queued message could not be deleted" description={removeError} /> : null}
        </div>
        <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:p-5 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
          <Button data-autofocus="" label="Cancel" type="button" variant="ghost" size="lg" isDisabled={deleting} onClick={closeRemove} />
          <Button label={deleting ? "Deleting" : removeError ? "Try delete again" : "Delete message"} type="button" variant="destructive" size="lg" isLoading={deleting} isDisabled={deleting} onClick={() => void remove()} />
        </div>
      </div>
    </Dialog>
  </section>;
}

function errorMessage(reason: unknown, fallback: string): string { return reason instanceof Error ? reason.message : fallback; }
function readableStatus(status: string): string { const value = status.replaceAll("_", " ").toLowerCase(); return value.charAt(0).toUpperCase() + value.slice(1); }
