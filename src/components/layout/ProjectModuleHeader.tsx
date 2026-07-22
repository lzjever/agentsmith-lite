import type { ReactNode } from "react";
import { cn } from "../ui/cn";

type ProjectModuleHeaderProps = {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
  titleClassName?: string;
  actionsClassName?: string;
};

export function ProjectModuleHeader({ title, actions, className, titleClassName, actionsClassName }: ProjectModuleHeaderProps) {
  return <div className={cn("flex min-h-10 w-full items-center justify-between gap-3 border-b border-subtle pb-3", className)}>
    <h2 className={cn("type-title text-foreground", titleClassName)}>{title}</h2>
    {actions ? <div className={cn("flex items-center gap-2", actionsClassName)}>{actions}</div> : null}
  </div>;
}
