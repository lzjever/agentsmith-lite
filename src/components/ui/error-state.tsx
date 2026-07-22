import { AlertCircle, RefreshCw, X } from "lucide-react";
import { Button } from "@astryxdesign/core";
import { useId } from "react";

export function ErrorState({ title = "Something went wrong", message, onRetry, retryLabel = "Try again" }: { title?: string; message: string; onRetry?: () => void; retryLabel?: string }) {
  const titleId = useId();
  return <section className="flex min-h-48 flex-col items-center justify-center border-y border-error/20 px-6 py-10 text-center" role="alert" aria-labelledby={titleId}><AlertCircle aria-hidden="true" className="mb-3 size-8 text-error" /><h2 id={titleId} className="type-title text-foreground">{title}</h2><p className="mt-2 max-w-md text-sm text-secondary">{message}</p>{onRetry ? <Button className="mt-5" label={retryLabel} variant="secondary" icon={<RefreshCw className="size-4" />} onClick={onRetry} /> : null}</section>;
}

export function ErrorCard({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return <div className="flex items-start gap-3 rounded-md border border-subtle border-l-2 border-l-error/70 bg-surface-high p-4" role="alert"><AlertCircle className="mt-0.5 size-5 shrink-0 text-error" /><p className="flex-1 text-sm text-primary">{message}</p>{onDismiss ? <button className="text-tertiary hover:text-foreground" aria-label="Dismiss error" onClick={onDismiss}><X className="size-4" /></button> : null}</div>;
}
