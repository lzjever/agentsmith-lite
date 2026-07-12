"use client";

import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "./alert-dialog";
import { toast } from "./toast";

export function ConfirmationDialog({ title, description, confirmText = "Confirm", cancelText = "Cancel", variant = "destructive", onConfirm, onSuccess, trigger, open: controlledOpen, onOpenChange, errorContext, confirmDisabled = false }: { title: ReactNode; description?: ReactNode; confirmText?: string; cancelText?: string; variant?: "destructive" | "default"; onConfirm: () => Promise<void> | void; onSuccess?: () => void; trigger?: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void; errorContext?: string; confirmDisabled?: boolean }) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  async function confirm() { setConfirming(true); try { await onConfirm(); setOpen(false); onSuccess?.(); } catch (error) { const message = error instanceof Error ? error.message : "The action could not be completed."; toast.error(errorContext ? `${errorContext}: ${message}` : message); } finally { setConfirming(false); } }
  return <AlertDialog open={open} onOpenChange={setOpen}>{trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}<AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle>{description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}</AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={confirming}>{cancelText}</AlertDialogCancel><AlertDialogAction variant={variant === "destructive" ? "destructive" : "default"} disabled={confirming || confirmDisabled} onClick={(event) => { event.preventDefault(); void confirm(); }}>{confirming ? <><Loader2 className="size-4 animate-spin" />Working</> : confirmText}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}
