"use client";

import Link from "next/link";
import { PageState } from "../layout/PageState";
import { ErrorState } from "../ui/error-state";
import { PageLoading } from "../ui/loading";

export function SettingsRouteLoading() { return <PageState state="loading"><PageLoading description="Loading settings..." /></PageState>; }

export function SettingsRouteError({ error, reset }: { error?: Error; reset: () => void }) {
  return <SettingsLoadError message={error?.message || "The settings page could not be loaded."} onRetry={reset} backHref={settingsParentPath()} backLabel="Back" />;
}

export function SettingsLoadError({ message, onRetry, backHref, backLabel }: { message: string; onRetry: () => void; backHref: string; backLabel: string }) {
  return <PageState state="error"><div><ErrorState title="Settings unavailable" message={message} onRetry={onRetry} /><p className="pb-12 text-center"><Link href={backHref} className="text-sm text-secondary hover:text-foreground">{backLabel}</Link></p></div></PageState>;
}

function settingsParentPath(): string {
  if (typeof window === "undefined") return "/";
  const parent = window.location.pathname.replace(/\/settings\/?$/, "");
  return parent || "/";
}
