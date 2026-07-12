"use client";

import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";
import { ErrorState } from "../ui/error-state";
import { PageLoading } from "../ui/loading";

export function ResourceRouteLoading({ label }: { label: string }) {
  return <PageLayout><PageState state="loading"><PageLoading description={`Loading ${label}...`} /></PageState></PageLayout>;
}

export function ResourceRouteError({ title, reset }: { title: string; reset: () => void }) {
  return <PageLayout><PageState state="error"><ErrorState title={`${title} unavailable`} message={`The ${title.toLowerCase()} view could not be opened.`} onRetry={reset} /></PageState></PageLayout>;
}
