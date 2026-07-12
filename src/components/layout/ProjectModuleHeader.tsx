import type { ReactNode } from "react";
import { cn } from "../ui/cn";

export function ProjectModuleHeader({ title, actions, className, titleClassName, actionsClassName }: { title: ReactNode; actions?: ReactNode; className?: string; titleClassName?: string; actionsClassName?: string }) {
  return <div className={cn("flex min-h-10 w-full items-center justify-between gap-2", className)}><h1 className={cn("text-2xl font-semibold leading-tight text-foreground", titleClassName)}>{title}</h1>{actions ? <div className={cn("flex items-center gap-2", actionsClassName)}>{actions}</div> : null}</div>;
}
