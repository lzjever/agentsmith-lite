"use client";

import * as Dialog from "@radix-ui/react-dialog";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export function Sheet({ children, ...props }: ComponentProps<typeof Dialog.Root>) { return <Dialog.Root {...props}>{children}</Dialog.Root>; }
export const SheetTrigger = Dialog.Trigger;
export function SheetContent({ children, className, accessibleTitle = "Navigation", ...props }: ComponentProps<typeof Dialog.Content> & { children: ReactNode; accessibleTitle?: string }) {
  return <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" /><Dialog.Content className={cn("fixed inset-y-0 left-0 z-50 flex w-[min(18rem,88vw)] flex-col border-r border-border bg-panel shadow-float", className)} {...props}><Dialog.Title className="sr-only">{accessibleTitle}</Dialog.Title>{children}</Dialog.Content></Dialog.Portal>;
}
