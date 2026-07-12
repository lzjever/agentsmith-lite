import type { ReactNode } from "react";
import { cn } from "../ui/cn";

export function PageToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-3", className)}>{children}</div>;
}
