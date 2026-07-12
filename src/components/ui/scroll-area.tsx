import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export function ScrollArea({ className, children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) { return <div className={cn("overflow-y-auto", className)} {...props}>{children}</div>; }
