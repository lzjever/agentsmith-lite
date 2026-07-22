"use client";

import { Pencil, Send, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import type { TaskCapabilities, TaskQueuedMessage } from "../../lib/api/client";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "../ui/dialog";

export function TaskComposer({ capabilities, queuedMessages, busy, unavailableMessage = "Messaging is unavailable", onSend, onUpdateQueued, onDeleteQueued }: { capabilities: TaskCapabilities; queuedMessages: TaskQueuedMessage[]; busy: boolean; unavailableMessage?: string; onSend: (content: string) => Promise<void>; onUpdateQueued: (messageId: string, content: string) => Promise<void>; onDeleteQueued: (messageId: string) => Promise<void> }) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<TaskQueuedMessage>();
  const [editDraft, setEditDraft] = useState("");
  const [removing, setRemoving] = useState<TaskQueuedMessage>();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const messageBusy = busy || submitting || saving || deleting;
  const nextEdit = editDraft.trim();
  const editChanged = Boolean(editing) && nextEdit !== editing?.content.trim();

  useEffect(() => {
    if (editing && !queuedMessages.some((message) => message.id === editing.id)) setEditing(undefined);
    if (removing && !queuedMessages.some((message) => message.id === removing.id)) setRemoving(undefined);
  }, [editing, queuedMessages, removing]);

  async function submit() {
    if (!draft.trim() || messageBusy || !capabilities.sendMessage) return;
    setError("");
    setSubmitting(true);
    try { await onSend(draft.trim()); setDraft(""); } catch (reason) { setError(errorMessage(reason)); } finally { setSubmitting(false); }
  }
  async function saveEdit() {
    if (!editing || !nextEdit || !editChanged || messageBusy) return;
    setSaving(true); setError("");
    try { await onUpdateQueued(editing.id, nextEdit); setEditing(undefined); } catch (reason) { setError(errorMessage(reason)); } finally { setSaving(false); }
  }
  async function remove() {
    if (!removing || messageBusy) return;
    setDeleting(true);
    try { await onDeleteQueued(removing.id); setRemoving(undefined); } finally { setDeleting(false); }
  }

  return <section className="shrink-0 border-t border-border bg-background px-4 py-4 sm:px-5" aria-label="Task message composer">
    {queuedMessages.length ? <ul className="mb-3 max-h-36 overflow-y-auto divide-y divide-border border-y border-border">{queuedMessages.map((message) => <li key={message.id} className="flex min-w-0 items-start justify-between gap-3 py-2.5"><div className="min-w-0"><p className="break-words text-sm text-foreground">{message.content}</p><p className="mt-1 font-mono text-[10px] uppercase text-tertiary">{message.deliveryStatus.replaceAll("_", " ")}</p>{message.safeError ? <p className="mt-1 break-words text-xs text-error">{message.safeError}</p> : null}</div><div className="flex shrink-0 gap-1">{capabilities.editQueuedMessage && message.editable ? <Button label="Edit queued message" variant="ghost" size="lg" isIconOnly icon={<Pencil size={15} />} title="Edit queued message" isDisabled={messageBusy} onClick={() => { setEditing(message); setEditDraft(message.content); setError(""); }} /> : null}{capabilities.sendMessage && message.deletable ? <Button label="Delete queued message" variant="ghost" size="lg" isIconOnly icon={<Trash2 size={15} />} title="Delete queued message" isDisabled={messageBusy} onClick={() => setRemoving(message)} /> : null}</div></li>)}</ul> : null}
    {error ? <p className="mb-3 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">{error}</p> : null}
    <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}><textarea aria-label="Message" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} disabled={!capabilities.sendMessage || messageBusy} placeholder={capabilities.sendMessage ? "Message the task" : unavailableMessage} rows={2} className="max-h-36 min-h-10 min-w-0 flex-1 resize-y border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-tertiary focus:border-accent disabled:cursor-not-allowed disabled:opacity-60" /><Button type="submit" label="Send message" size="lg" isIconOnly icon={<Send size={16} />} title="Send message" isDisabled={!capabilities.sendMessage || messageBusy || !draft.trim()} /></form>
    <Dialog open={Boolean(editing)} onOpenChange={(open) => { if (!open && !messageBusy) setEditing(undefined); }}><DialogContent><form onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}><DialogHeader title="Edit queued message" description="Only messages the server still accepts can be changed." />{error ? <p className="mx-5 mt-4 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">{error}</p> : null}<div className="px-5 py-5"><textarea aria-label="Queued message" value={editDraft} onChange={(event) => setEditDraft(event.target.value)} disabled={messageBusy} className="min-h-28 w-full border border-border bg-background p-3 text-sm text-foreground outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60" autoFocus /></div><DialogFooter><Button type="button" label="Cancel" variant="ghost" size="lg" isDisabled={messageBusy} onClick={() => setEditing(undefined)} /><Button type="submit" label={saving ? "Saving..." : "Save message"} size="lg" isDisabled={messageBusy || !nextEdit || !editChanged} /></DialogFooter></form></DialogContent></Dialog>
    <ConfirmationDialog open={Boolean(removing)} onOpenChange={(open) => { if (!open && !deleting) setRemoving(undefined); }} title="Delete queued message?" description="This message has not started delivery and can be removed." confirmText="Delete message" confirmDisabled={busy || submitting || saving} onConfirm={remove} errorContext="Queued message could not be deleted" />
  </section>;
}

function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : "The message could not be updated."; }
