"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "./cn";

export const Tabs = TabsPrimitive.Root;
export const TabsList = forwardRef<ElementRef<typeof TabsPrimitive.List>, ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(function TabsList({ className, ...props }, ref) { return <TabsPrimitive.List ref={ref} className={cn("inline-flex items-center gap-1 rounded-pill border border-border/60 bg-surface-low p-1 text-tertiary", className)} {...props} />; });
export const TabsTrigger = forwardRef<ElementRef<typeof TabsPrimitive.Trigger>, ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(function TabsTrigger({ className, ...props }, ref) { return <TabsPrimitive.Trigger ref={ref} className={cn("inline-flex min-h-9 items-center justify-center whitespace-nowrap rounded-pill px-3.5 py-1.5 text-[13px] text-primary ring-offset-background transition-[color,background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-surface-high data-[state=active]:text-foreground data-[state=active]:shadow-ambient", className)} {...props} />; });
export const TabsContent = forwardRef<ElementRef<typeof TabsPrimitive.Content>, ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>(function TabsContent({ className, ...props }, ref) { return <TabsPrimitive.Content ref={ref} className={cn("mt-3 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:ring-offset-2", className)} {...props} />; });
