import { AlertCircle, RefreshCw, X } from "lucide-react";
import { Banner, Button } from "@astryxdesign/core";

export function ErrorState({ title = "Something went wrong", message, onRetry, retryLabel = "Try again" }: { title?: string; message: string; onRetry?: () => void; retryLabel?: string }) {
  return <Banner
    status="error"
    container="section"
    title={<h2 className="type-title text-foreground">{title}</h2>}
    description={<p className="text-sm text-secondary">{message}</p>}
    endContent={onRetry ? <Button label={retryLabel} variant="secondary" icon={<RefreshCw className="size-4" />} onClick={onRetry} /> : undefined}
  />;
}

export function ErrorCard({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return <div className="flex items-start gap-3 rounded-md border border-subtle border-l-2 border-l-error/70 bg-surface-high p-4" role="alert"><AlertCircle className="mt-0.5 size-5 shrink-0 text-error" /><p className="flex-1 text-sm text-primary">{message}</p>{onDismiss ? <button className="text-tertiary hover:text-foreground" aria-label="Dismiss error" onClick={onDismiss}><X className="size-4" /></button> : null}</div>;
}
