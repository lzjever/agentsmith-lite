import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

export type ButtonVariant = "default" | "primary" | "action" | "outline" | "secondary" | "ghost" | "quiet" | "link" | "danger" | "destructive" | "destructive-primary";
export type ButtonSize = "default" | "sm" | "lg" | "icon";
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, variant = "default", size = "default", type = "button", ...props }, ref) {
  const tones: Record<ButtonVariant, string> = {
    default: "border-border/25 bg-transparent text-secondary hover:border-border/30 hover:bg-surface-low/30 hover:text-foreground",
    primary: "border-transparent bg-foreground text-background hover:bg-foreground/95 hover:text-background",
    action: "border-border/25 bg-surface-low/35 text-foreground hover:border-border/30 hover:bg-surface-low/50 hover:text-foreground",
    outline: "border-border/25 bg-transparent text-secondary hover:border-border/30 hover:bg-surface-low/30 hover:text-foreground",
    secondary: "border-transparent bg-surface-low/35 text-secondary hover:bg-surface-low/50 hover:text-foreground",
    ghost: "border-transparent bg-transparent text-secondary hover:bg-surface-low/25 hover:text-foreground",
    quiet: "border-transparent bg-transparent text-secondary hover:bg-surface-low/25 hover:text-foreground",
    link: "border-transparent bg-transparent px-0 text-secondary hover:text-foreground",
    danger: "border-error/20 bg-error/5 text-error hover:bg-error/10",
    destructive: "border-error/20 bg-error/5 text-error hover:bg-error/10",
    "destructive-primary": "border-transparent bg-error text-background shadow-[0_10px_30px_rgba(220,38,38,0.22)] hover:bg-error/90 hover:text-background"
  };
  const sizes: Record<ButtonSize, string> = { default: "h-9 px-3.5", sm: "h-8 px-3 text-[12px]", lg: "h-10 px-4 text-[13px]", icon: "h-9 w-9 p-0" };
  return <button ref={ref} type={type} data-visual-prominence={variant === "primary" || variant === "destructive-primary" ? "primary" : undefined} className={cn("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border text-[13px] font-normal leading-none tracking-[0.005em] transition-[color,background-color,border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50", sizes[size], tones[variant], className)} {...props} />;
});
