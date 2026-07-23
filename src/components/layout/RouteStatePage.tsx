"use client";

import { Spinner } from "@astryxdesign/core";
import { PageLayout } from "./PageLayout";
import { PageHeader } from "./PageHeader";
import { PageState } from "./PageState";
import { ErrorState } from "../ui/error-state";

export function RouteLoadingPage({ title, label = `Loading ${title.toLowerCase()}...` }: { title: string; label?: string }) {
  return <PageLayout header={<PageHeader title={title} />}><PageState state="loading"><Spinner label={label} /></PageState></PageLayout>;
}

export function RouteErrorPage({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return <PageLayout header={<PageHeader title={title} />}><PageState state="error"><ErrorState title={`${title} unavailable`} message={message} onRetry={onRetry} /></PageState></PageLayout>;
}
