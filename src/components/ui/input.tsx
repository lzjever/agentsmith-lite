import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "./cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & { variant?: "default" | "prompt" };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, variant = "default", type, ...props }, ref) {
  return <input ref={ref} type={type} className={cn("flex w-full transition-[border-color,background-color,box-shadow,color] duration-150 placeholder:text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/18 focus-visible:ring-2 focus-visible:ring-accent/18 read-only:cursor-default read-only:bg-surface-low read-only:text-secondary read-only:hover:border-border-input/65 disabled:cursor-not-allowed disabled:opacity-50", variant === "prompt" ? "rounded-pill border border-border/55 bg-surface-low px-4 py-2.5 text-foreground hover:border-border/75 focus:border-border" : "rounded-md border border-border-input/65 bg-input px-3 py-2.5 text-foreground hover:border-border/80 focus:border-border", className)} {...props} />;
});
