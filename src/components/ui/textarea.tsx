import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn("flex min-h-24 w-full rounded-md border border-border-input/65 bg-input px-3 py-2.5 text-sm text-foreground placeholder:text-tertiary transition-[border-color,background-color,box-shadow] duration-150 focus:border-border focus:outline-none focus:ring-2 focus:ring-accent/18 disabled:cursor-not-allowed disabled:opacity-50", className)} {...props} />;
});
