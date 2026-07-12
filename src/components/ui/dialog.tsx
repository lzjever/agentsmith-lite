"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

export const Dialog = Object.assign(DialogPrimitive.Root, { Root: DialogPrimitive.Root });
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = forwardRef<ElementRef<typeof DialogPrimitive.Title>, ComponentPropsWithoutRef<typeof DialogPrimitive.Title>>(function DialogTitle({ className, ...props }, ref) { return <DialogPrimitive.Title ref={ref} className={cn("type-title pr-8 text-foreground", className)} {...props} />; });
export const DialogDescription = forwardRef<ElementRef<typeof DialogPrimitive.Description>, ComponentPropsWithoutRef<typeof DialogPrimitive.Description>>(function DialogDescription({ className, ...props }, ref) { return <DialogPrimitive.Description ref={ref} className={cn("text-sm leading-6 text-secondary", className)} {...props} />; });

export const DialogOverlay = forwardRef<ElementRef<typeof DialogPrimitive.Overlay>, ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>>(function DialogOverlay({ className, ...props }, ref) {
  return <DialogPrimitive.Overlay ref={ref} className={cn("dialog-overlay fixed inset-0 z-40 bg-[rgb(var(--overlay-scrim)/0.28)]", className)} {...props} />;
});

export const DialogContent = forwardRef<ElementRef<typeof DialogPrimitive.Content>, ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { children: ReactNode }>(function DialogContent({ children, className, ...props }, ref) {
  return <DialogPrimitive.Portal><DialogOverlay /><DialogPrimitive.Content ref={ref} className={cn("dialog-content fixed left-1/2 top-1/2 z-50 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border/70 bg-dialog shadow-card", className)} {...props}>{children}</DialogPrimitive.Content></DialogPrimitive.Portal>;
});

export function DialogHeader({ children, title, description, className }: { children?: ReactNode; title?: string; description?: string; className?: string }) {
  if (children) return <header className={cn("border-b border-subtle px-5 py-4 md:px-6", className)}>{children}</header>;
  return <header className={cn("flex items-start justify-between gap-4 border-b border-subtle px-5 py-4 md:px-6", className)}><div><DialogTitle>{title}</DialogTitle>{description ? <DialogDescription className="mt-1">{description}</DialogDescription> : null}</div><DialogPrimitive.Close className="rounded-pill p-1.5 text-tertiary transition-colors hover:bg-surface-low hover:text-foreground focus:outline-none focus:ring-2 focus:ring-accent/18 focus:ring-offset-2 focus:ring-offset-dialog" aria-label="Close dialog"><X className="size-4" /></DialogPrimitive.Close></header>;
}

export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) { return <footer className={cn("flex flex-col-reverse gap-2 border-t border-subtle px-5 py-4 sm:flex-row sm:justify-end md:px-6", className)}>{children}</footer>; }

export type DialogHeaderProps = HTMLAttributes<HTMLDivElement>;
