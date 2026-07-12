import { AlertCircle, RefreshCw, X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "./button";

export function ErrorState({ title = "Something went wrong", message, onRetry, retryLabel = "Try again" }: { title?: string; message: string; onRetry?: () => void; retryLabel?: string }) {
  return <div className="flex min-h-[400px] flex-col items-center justify-center p-8 text-center" role="alert"><AlertCircle className="mb-4 size-16 text-error" /><h2 className="mb-2 text-lg font-semibold text-foreground">{title}</h2><p className="mb-6 max-w-md text-tertiary">{message}</p>{onRetry ? <Button variant="action" onClick={onRetry}><RefreshCw className="size-4" />{retryLabel}</Button> : null}</div>;
}

export function ErrorCard({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  useEffect(() => { if (!onDismiss) return; const timer = window.setTimeout(onDismiss, 5_000); return () => window.clearTimeout(timer); }, [onDismiss]);
  return <div className="flex items-start gap-3 rounded-md border border-subtle border-l-2 border-l-error/70 bg-surface-high p-4" role="alert"><AlertCircle className="mt-0.5 size-5 shrink-0 text-error" /><p className="flex-1 text-sm text-primary">{message}</p>{onDismiss ? <button className="text-tertiary hover:text-foreground" aria-label="Dismiss error" onClick={onDismiss}><X className="size-4" /></button> : null}</div>;
}
