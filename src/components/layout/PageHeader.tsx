import type { ReactNode } from "react";
import { cn } from "../ui/cn";

export function PageHeader({ title, subtitle, actions, className, variant = "default" }: { title: string; subtitle?: string; actions?: ReactNode; className?: string; variant?: "default" | "compact" }) {
  const compact = variant === "compact";
  return <div className={cn("flex flex-col md:flex-row md:items-start md:justify-between", compact ? "gap-2.5" : "gap-3.5", className)}>
    <div className={compact ? "space-y-1" : "space-y-1.5"}><h1 className={cn(compact ? "type-subheading" : "type-section-heading", "text-foreground")}>{title}</h1>{subtitle ? <p className="type-body-ui max-w-3xl text-secondary">{subtitle}</p> : null}</div>
    {actions ? <div className="flex flex-wrap items-center gap-2 md:justify-end">{actions}</div> : null}
  </div>;
}
