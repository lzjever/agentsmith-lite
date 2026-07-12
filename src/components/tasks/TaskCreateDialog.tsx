"use client";

import { AlertCircle, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import type { Endpoint } from "../../lib/api/client";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

export function TaskCreateDialog({
  endpoints,
  open,
  saving,
  onClose,
  onCreate
}: {
  endpoints: Endpoint[];
  open: boolean;
  saving: boolean;
  onClose: () => void;
  onCreate: (input: { title: string; prompt: string; endpointId: string }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setEndpointId((current) => endpoints.some((endpoint) => endpoint.id === current) ? current : (endpoints[0]?.id ?? ""));
      setError("");
    }
  }, [endpoints, open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim() || !endpointId || saving) return;
    setError("");
    try {
      await onCreate({ title: title.trim(), prompt: prompt.trim(), endpointId });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The task could not be created.");
    }
  }

  return <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && !saving && onClose()}><DialogContent>
    <form onSubmit={(event) => void submit(event)} aria-label="Create task">
      <DialogHeader><div className="flex items-start justify-between gap-4"><div><DialogTitle className="type-title text-foreground">Create task</DialogTitle><DialogDescription className="mt-1 text-sm text-secondary">Describe the work for the Botified sandbox.</DialogDescription></div><DialogClose asChild><Button variant="quiet" size="icon" aria-label="Close create task" disabled={saving}><X size={17} /></Button></DialogClose></div></DialogHeader>
      {error ? <div className="mx-5 mt-4 flex items-start gap-2 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</div> : null}
      <div className="grid gap-4 px-5 py-5">{endpoints.length === 0 ? <p className="border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">No task-ready endpoint is available. Add or repair an endpoint before creating a task.</p> : <><label className="grid gap-1.5 text-sm text-secondary">Title <span className="text-tertiary">(optional)</span><Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} placeholder="Task title" autoFocus disabled={saving} /></label><label className="grid gap-1.5 text-sm text-secondary">Endpoint<Select value={endpointId} onValueChange={setEndpointId} disabled={saving}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{endpoints.map((endpoint) => <SelectItem key={endpoint.id} value={endpoint.id}>{endpoint.name} ({endpoint.model})</SelectItem>)}</SelectContent></Select></label><label className="grid gap-1.5 text-sm text-secondary">Task prompt<Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} className="min-h-36 resize-y" placeholder="Describe the result you need" disabled={saving} /></label></>}</div>
      <DialogFooter><Button type="button" variant="quiet" onClick={onClose} disabled={saving}>Cancel</Button><Button type="submit" disabled={!prompt.trim() || !endpointId || saving}>{saving ? "Creating..." : "Create task"}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
