"use client";

import Link from "next/link";
import { Banner, Button, Text } from "@astryxdesign/core";

export function SettingsLoadError({ message, onRetry, backHref, backLabel }: { message: string; onRetry: () => void; backHref: string; backLabel: string }) {
  return <Banner status="error" title="Settings unavailable" description={message} endContent={<span className="flex gap-2"><Button label="Try again" variant="secondary" onClick={onRetry} /><Link href={backHref} className="inline-flex items-center hover:text-primary"><Text type="supporting" color="secondary">{backLabel}</Text></Link></span>} />;
}
