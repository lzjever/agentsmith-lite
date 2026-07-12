"use client";

import { Loader2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./dialog";

export function FormDialog({ title, description, trigger, onSubmit, onSuccess, submitLabel = "Submit", cancelLabel = "Cancel", open: controlledOpen, onOpenChange, children, testId }: {
  title: string; description?: string; trigger: ReactNode; onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>; onSuccess?: () => void; submitLabel?: string; cancelLabel?: string; open?: boolean; onOpenChange?: (open: boolean) => void; children: (input: { isSubmitting: boolean; error: string | null; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) => ReactNode; testId?: string;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [isSubmitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setSubmitting(true); setError(null); try { await onSubmit(event); setOpen(false); onSuccess?.(); } catch (reason) { setError(reason instanceof Error ? reason.message : "An error occurred"); } finally { setSubmitting(false); } }
  function changeOpen(next: boolean) { if (next || !isSubmitting) { setOpen(next); setError(null); } }
  return <Dialog open={open} onOpenChange={changeOpen}><DialogTrigger asChild>{trigger}</DialogTrigger><DialogContent data-testid={testId}><DialogHeader><div><DialogTitle>{title}</DialogTitle>{description ? <DialogDescription className="mt-1">{description}</DialogDescription> : null}</div></DialogHeader>{error ? <div role="alert" className="mx-5 mt-4 rounded-md border border-error/20 bg-error/10 px-4 py-3 text-sm leading-6 text-error md:mx-6">{error}</div> : null}{children({ isSubmitting, error, onSubmit: submit })}<DialogFooter><Button variant="ghost" onClick={() => setOpen(false)} disabled={isSubmitting}>{cancelLabel}</Button><Button type="submit" form="dialog-form" disabled={isSubmitting}>{isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}{submitLabel}</Button></DialogFooter></DialogContent></Dialog>;
}
