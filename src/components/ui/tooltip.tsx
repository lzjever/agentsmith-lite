"use client";

import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export function TooltipProvider({ children }: { children: ReactNode }) { return <Tooltip.Provider delayDuration={350}>{children}</Tooltip.Provider>; }
export function TooltipContent({ children }: { children: ReactNode }) { return <Tooltip.Portal><Tooltip.Content sideOffset={6} className="z-50 rounded-sm bg-foreground px-2 py-1 text-xs text-background shadow-float">{children}<Tooltip.Arrow className="fill-foreground" /></Tooltip.Content></Tooltip.Portal>; }
export { Tooltip };
