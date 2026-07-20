import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "./cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & { variant?: "default" | "prompt" };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, variant = "default", type, ...props }, ref) {
  return <input ref={ref} type={type} className={cn("flex w-full shadow-ambient transition-[border-color,background-color,box-shadow,color] duration-150 placeholder:text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/15 focus-visible:ring-2 focus-visible:ring-accent/15 read-only:cursor-default read-only:bg-surface-low read-only:text-secondary disabled:cursor-not-allowed disabled:opacity-50", variant === "prompt" ? "rounded-pill border border-border-input bg-input px-4 py-2.5 text-foreground hover:border-icon-default focus:border-accent" : "rounded-md border border-border-input bg-input px-3 py-2.5 text-foreground hover:border-icon-default focus:border-accent", className)} {...props} />;
});
