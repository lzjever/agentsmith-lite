import type { ComponentType } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "./button";

export function LoadingSpinner({ size = "md", text }: { size?: "sm" | "md" | "lg"; text?: string }) {
  const dimensions = { sm: "size-4", md: "size-8", lg: "size-12" };
  return <div className="flex flex-col items-center justify-center gap-3" role="status"><Loader2 className={`animate-spin text-tertiary ${dimensions[size]}`} /><span className="sr-only">Loading</span>{text ? <p className="text-sm text-tertiary">{text}</p> : null}</div>;
}

export function PageLoading({ description }: { title?: string; description?: string }) { return <div className="flex min-h-[400px] items-center justify-center"><div className="text-center"><LoadingSpinner size="lg" />{description ? <p className="mt-4 text-tertiary">{description}</p> : null}</div></div>; }

export function EmptyState({ icon: Icon, title, description, action }: { icon?: ComponentType<{ className?: string }>; title: string; description?: string; action?: { label: string; onClick: () => void } }) {
  return <div className="flex min-h-[400px] flex-col items-center justify-center p-8 text-center">{Icon ? <Icon className="mb-4 size-16 text-tertiary" /> : null}<h2 className="mb-2 text-lg font-semibold text-foreground">{title}</h2>{description ? <p className="mb-6 max-w-md text-tertiary">{description}</p> : null}{action ? <Button variant="action" onClick={action.onClick}>{action.label}</Button> : null}</div>;
}
