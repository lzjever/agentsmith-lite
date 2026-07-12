"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ComponentProps } from "react";
import { cn } from "./cn";

export { DropdownMenu };

export function DropdownContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof DropdownMenu.Content>) {
  return <DropdownMenu.Portal><DropdownMenu.Content sideOffset={sideOffset} className={cn("z-50 min-w-44 rounded-md border border-subtle bg-dialog p-1 text-primary shadow-float", className)} {...props} /></DropdownMenu.Portal>;
}

export function DropdownItem({ className, ...props }: ComponentProps<typeof DropdownMenu.Item>) {
  return <DropdownMenu.Item className={cn("flex min-h-8 cursor-pointer items-center rounded-sm px-2 text-sm text-primary outline-none data-[highlighted]:bg-hover data-[highlighted]:text-foreground", className)} {...props} />;
}
