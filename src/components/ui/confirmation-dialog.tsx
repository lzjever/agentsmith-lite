"use client";

import { useState, type ReactNode } from "react";
import { Button, Dialog, DialogHeader } from "@astryxdesign/core";

export function ConfirmationDialog({ title, description, confirmText = "Confirm", cancelText = "Cancel", variant = "destructive", onConfirm, onSuccess, open: controlledOpen, onOpenChange, errorContext, confirmDisabled = false }: { title: string; description?: ReactNode; confirmText?: string; cancelText?: string; variant?: "destructive" | "default"; onConfirm: () => Promise<void> | void; onSuccess?: () => void; open?: boolean; onOpenChange?: (open: boolean) => void; errorContext?: string; confirmDisabled?: boolean }) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState("");
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  function changeOpen(next: boolean) { if (confirming && !next) return; if (!next) setFailure(""); setOpen(next); }
  async function confirm() { setConfirming(true); setFailure(""); try { await onConfirm(); setOpen(false); onSuccess?.(); } catch (error) { const message = error instanceof Error ? error.message : "The action could not be completed."; setFailure(errorContext ? `${errorContext}: ${message}` : message); } finally { setConfirming(false); } }
  return <Dialog isOpen={open} onOpenChange={changeOpen} purpose="form" width="min(32rem, calc(100vw - 2rem))" padding={0} aria-label={title}><form onSubmit={(event) => { event.preventDefault(); void confirm(); }}><DialogHeader title={title} hasDivider />{description ? <div className="px-5 pt-4 text-sm text-secondary md:px-6">{description}</div> : null}{failure ? <div role="alert" className="mx-5 mt-4 rounded-sm border border-error/30 bg-error/10 px-3 py-2 text-sm text-error md:mx-6">{failure}</div> : null}<footer className="mt-4 flex flex-col-reverse gap-2 border-t border-subtle px-5 py-4 sm:flex-row sm:justify-end md:px-6"><Button label={cancelText} type="button" variant="ghost" size="lg" isDisabled={confirming} onClick={() => changeOpen(false)} /><Button label={confirming ? "Working" : confirmText} type="submit" variant={variant === "destructive" ? "destructive" : "primary"} size="lg" isDisabled={confirming || confirmDisabled} isLoading={confirming} /></footer></form></Dialog>;
}
