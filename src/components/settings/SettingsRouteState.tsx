"use client";

import Link from "next/link";
import { PageState } from "../layout/PageState";
import { ErrorState } from "../ui/error-state";

export function SettingsLoadError({ message, onRetry, backHref, backLabel }: { message: string; onRetry: () => void; backHref: string; backLabel: string }) {
  return <PageState state="error"><div><ErrorState title="Settings unavailable" message={message} onRetry={onRetry} /><p className="pb-12 text-center"><Link href={backHref} className="text-sm text-secondary hover:text-foreground">{backLabel}</Link></p></div></PageState>;
}
