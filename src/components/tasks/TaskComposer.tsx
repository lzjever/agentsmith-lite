"use client";

import { Pencil, Send, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Banner, Button, Dialog, DialogHeader, IconButton, Text, TextArea } from "@astryxdesign/core";
import type { TaskCapabilities, TaskQueuedMessage } from "../../lib/api/client";

export function TaskComposer({ capabilities, queuedMessages, busy, unavailableMessage = "Messaging is unavailable", onSend, onUpdateQueued, onDeleteQueued }: { capabilities: TaskCapabilities; queuedMessages: TaskQueuedMessage[]; busy: boolean; unavailableMessage?: string; onSend: (content: string) => Promise<void>; onUpdateQueued: (messageId: string, content: string) => Promise<void>; onDeleteQueued: (messageId: string) => Promise<void> }) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<TaskQueuedMessage>();
  const [editDraft, setEditDraft] = useState("");
  const [removing, setRemoving] = useState<TaskQueuedMessage>();
  const [sendError, setSendError] = useState("");
  const [editError, setEditError] = useState("");
  const [removeError, setRemoveError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const messageBusy = busy || submitting || saving || deleting;
  const nextEdit = editDraft.trim();
  const editChanged = Boolean(editing) && nextEdit !== editing?.content.trim();

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

  async function submit() {
    if (!draft.trim() || messageBusy || !capabilities.sendMessage) return;
    setSendError("");
    setSubmitting(true);
    try {
      await onSend(draft.trim());
      setDraft("");
    } catch (reason) {
      setSendError(errorMessage(reason, "The message could not be sent."));
    } finally {
      setSubmitting(false);
    }
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

  return <section className="shrink-0 border-t border-border bg-surface px-4 py-4 sm:px-5" aria-label="Task message composer">
    {queuedMessages.length ? <ul className="mb-3 max-h-36 overflow-y-auto divide-y divide-border border-y border-border">{queuedMessages.map((message) => <li key={message.id} className="flex min-w-0 items-start justify-between gap-3 py-2.5"><div className="min-w-0"><Text display="block" type="supporting" className="break-words">{message.content}</Text><Text display="block" type="code" color="secondary" className="mt-1">{readableStatus(message.deliveryStatus)}</Text>{message.safeError ? <Text display="block" type="supporting" className="mt-1 break-words text-error">{message.safeError}</Text> : null}</div><div className="flex shrink-0 gap-1">{capabilities.editQueuedMessage && message.editable ? <IconButton label="Edit queued message" tooltip="Edit queued message" variant="ghost" size="lg" icon={<Pencil size={15} />} isDisabled={messageBusy} onClick={() => { setEditing(message); setEditDraft(message.content); setEditError(""); }} /> : null}{capabilities.sendMessage && message.deletable ? <IconButton label="Delete queued message" tooltip="Delete queued message" variant="ghost" size="lg" icon={<Trash2 size={15} />} isDisabled={messageBusy} onClick={() => { setRemoveError(""); setRemoving(message); }} /> : null}</div></li>)}</ul> : null}
    {sendError ? <Banner className="mb-3" status="error" title="Message could not be sent" description={sendError} /> : null}
    <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}><div className="min-w-0 flex-1"><TextArea label="Message" isLabelHidden value={draft} onChange={setDraft} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} isDisabled={!capabilities.sendMessage || messageBusy} placeholder={capabilities.sendMessage ? "Message the task" : unavailableMessage} rows={2} width="100%" /></div><IconButton type="submit" label="Send message" tooltip="Send message" size="lg" icon={<Send size={16} />} isDisabled={!capabilities.sendMessage || messageBusy || !draft.trim()} /></form>
    <Dialog isOpen={Boolean(editing)} onOpenChange={(open) => { if (!open && !messageBusy) closeEdit(); }} purpose="form" width="min(34rem, calc(100vw - 2rem))" padding={0} aria-label="Edit queued message"><form onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}><DialogHeader title="Edit queued message" subtitle="Only messages the server still accepts can be changed." onOpenChange={(open) => { if (!open && !messageBusy) closeEdit(); }} hasDivider />{editError ? <Banner className="mx-5 mt-4" status="error" title="Message could not be updated" description={editError} /> : null}<div className="px-5 py-5"><TextArea label="Queued message" isLabelHidden value={editDraft} onChange={setEditDraft} isDisabled={messageBusy} rows={5} hasAutoFocus width="100%" /></div><footer className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end md:px-6"><Button type="button" label="Cancel" variant="ghost" size="lg" isDisabled={messageBusy} onClick={closeEdit} /><Button type="submit" label={saving ? "Saving..." : "Save message"} size="lg" isDisabled={messageBusy || !nextEdit || !editChanged} /></footer></form></Dialog>
    <Dialog isOpen={Boolean(removing)} onOpenChange={(open) => { if (!open && !deleting) closeRemove(); }} purpose="form" role="alertdialog" width="min(32rem, calc(100vw - 2rem))" padding={0} aria-label="Delete queued message">
      <DialogHeader title="Delete queued message?" subtitle="This message has not started delivery and can be removed." onOpenChange={(open) => { if (!open && !deleting) closeRemove(); }} hasDivider />
      {removeError ? <Banner className="mx-5 mt-4" status="error" title="Queued message could not be deleted" description={removeError} /> : null}
      <footer className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end md:px-6">
        <Button label="Cancel" variant="ghost" size="lg" isDisabled={deleting} onClick={closeRemove} />
        <Button label={deleting ? "Deleting" : removeError ? "Try delete again" : "Delete message"} variant="destructive" size="lg" isDisabled={deleting} isLoading={deleting} onClick={() => void remove()} />
      </footer>
    </Dialog>
  </section>;
}

function errorMessage(reason: unknown, fallback: string): string { return reason instanceof Error ? reason.message : fallback; }
function readableStatus(status: string): string { const value = status.replaceAll("_", " ").toLowerCase(); return value.charAt(0).toUpperCase() + value.slice(1); }
