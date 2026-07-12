import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & { variant?: "default" | "secondary" | "destructive" | "outline" | "success" | "warning" };
export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  const tone = { default: "border-accent/30 bg-accent/20 text-accent", secondary: "border-border bg-surface-high text-tertiary", destructive: "border-error/30 bg-error/10 text-error", outline: "border-border bg-transparent text-foreground", success: "border-success/30 bg-success/10 text-success", warning: "border-warning/30 bg-warning/10 text-warning" };
  return <span className={cn("inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-medium transition-colors duration-200", tone[variant], className)} {...props} />;
}
