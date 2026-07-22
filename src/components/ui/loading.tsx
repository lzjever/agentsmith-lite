import { useId, type ComponentType } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "./button";

export function LoadingSpinner({ size = "md", text }: { size?: "sm" | "md" | "lg"; text?: string }) {
  const dimensions = { sm: "size-4", md: "size-8", lg: "size-12" };
  const label = text ?? "Loading";
  return <div className="flex items-center gap-3 text-sm text-secondary" role="status" aria-live="polite" aria-label={label}><Loader2 aria-hidden="true" className={`animate-spin text-tertiary ${dimensions[size]}`} />{text ? <span>{text}</span> : <span className="sr-only">{label}</span>}</div>;
}

export function PageLoading({ description }: { title?: string; description?: string }) {
  const label = description ?? "Loading content...";
  return <section className="flex min-h-48 items-center border-y border-subtle py-6" aria-busy="true"><LoadingSpinner size="sm" text={label} /></section>;
}

export function EmptyState({ icon: Icon, title, description, action }: { icon?: ComponentType<{ className?: string }>; title: string; description?: string; action?: { label: string; onClick: () => void } }) {
  const titleId = useId();
  return <section className="flex min-h-48 flex-col items-center justify-center border-y border-subtle px-6 py-10 text-center" aria-labelledby={titleId}>{Icon ? <Icon aria-hidden="true" className="mb-3 size-8 text-icon-default" /> : null}<h2 id={titleId} className="type-title text-foreground">{title}</h2>{description ? <p className="mt-2 max-w-md text-sm text-secondary">{description}</p> : null}{action ? <Button className="mt-5" variant="action" onClick={action.onClick}>{action.label}</Button> : null}</section>;
}
