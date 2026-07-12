"use client";

import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from "react";
import { Button } from "./button";
import { cn } from "./cn";

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
export const AlertDialogPortal = AlertDialogPrimitive.Portal;
export const AlertDialogOverlay = forwardRef<ElementRef<typeof AlertDialogPrimitive.Overlay>, ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>>(function AlertDialogOverlay({ className, ...props }, ref) { return <AlertDialogPrimitive.Overlay ref={ref} className={cn("fixed inset-0 z-40 bg-black/30", className)} {...props} />; });
export const AlertDialogContent = forwardRef<ElementRef<typeof AlertDialogPrimitive.Content>, ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>>(function AlertDialogContent({ className, ...props }, ref) { return <AlertDialogPortal><AlertDialogOverlay /><AlertDialogPrimitive.Content ref={ref} className={cn("fixed left-1/2 top-1/2 z-50 grid w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-md border border-border bg-dialog p-6 shadow-float", className)} {...props} /></AlertDialogPortal>; });
export function AlertDialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn("flex flex-col space-y-2 text-left", className)} {...props} />; }
export function AlertDialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn("flex flex-col gap-2 sm:flex-row sm:justify-end", className)} {...props} />; }
export const AlertDialogTitle = forwardRef<ElementRef<typeof AlertDialogPrimitive.Title>, ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>>(function AlertDialogTitle({ className, ...props }, ref) { return <AlertDialogPrimitive.Title ref={ref} className={cn("type-title text-foreground", className)} {...props} />; });
export const AlertDialogDescription = forwardRef<ElementRef<typeof AlertDialogPrimitive.Description>, ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>>(function AlertDialogDescription({ className, ...props }, ref) { return <AlertDialogPrimitive.Description ref={ref} className={cn("text-sm text-secondary", className)} {...props} />; });
export const AlertDialogAction = forwardRef<ElementRef<typeof AlertDialogPrimitive.Action>, ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action> & { variant?: "default" | "destructive" }>(function AlertDialogAction({ className, variant = "default", children, ...props }, ref) { return <AlertDialogPrimitive.Action ref={ref} asChild {...props}><Button variant={variant === "destructive" ? "destructive-primary" : "primary"} className={className}>{children}</Button></AlertDialogPrimitive.Action>; });
export const AlertDialogCancel = forwardRef<ElementRef<typeof AlertDialogPrimitive.Cancel>, ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>>(function AlertDialogCancel({ className, children, ...props }, ref) { return <AlertDialogPrimitive.Cancel ref={ref} asChild {...props}><Button variant="ghost" className={className}>{children}</Button></AlertDialogPrimitive.Cancel>; });
