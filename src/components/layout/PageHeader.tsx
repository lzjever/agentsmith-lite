import type { ReactNode } from "react";
import { cn } from "../ui/cn";
import { DocumentTitle } from "./DocumentTitle";

type PageHeaderProps = {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
  variant?: "default" | "compact";
};

export function PageHeader({ title, subtitle, actions, className, variant = "default" }: PageHeaderProps) {
  const compact = variant === "compact";
  return <><DocumentTitle title={title} /><div className={cn("flex flex-col border-b border-subtle", compact ? "gap-2.5 pb-4" : "gap-4 pb-6", "md:flex-row md:items-start md:justify-between", className)}>
    <div className={compact ? "space-y-1" : "space-y-2"}>
      <h1 className={cn(compact ? "type-section-heading" : "type-display", "text-foreground")}>{title}</h1>
      {subtitle ? <p className="type-body-ui max-w-3xl text-secondary">{subtitle}</p> : null}
    </div>
    {actions ? <div className="flex flex-wrap items-center gap-2 md:justify-end">{actions}</div> : null}
  </div></>;
}
