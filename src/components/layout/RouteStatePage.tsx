"use client";

import { Banner, Button, Spinner } from "@astryxdesign/core";
import { PageLayout } from "./PageLayout";
import { PageHeader } from "./PageHeader";

export function RouteLoadingPage({ title, label = `Loading ${title.toLowerCase()}...` }: { title: string; label?: string }) {
  return <PageLayout header={<PageHeader title={title} />}><div className="grid min-h-48 place-items-center px-4 py-6"><Spinner label={label} /></div></PageLayout>;
}

export function RouteErrorPage({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return <PageLayout header={<PageHeader title={title} />}><Banner status="error" container="section" title={`${title} unavailable`} description={message} endContent={<Button label="Try again" variant="secondary" onClick={onRetry} />} /></PageLayout>;
}
