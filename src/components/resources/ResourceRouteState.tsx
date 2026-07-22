"use client";

import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";
import { ErrorState } from "../ui/error-state";
import { Spinner } from "@astryxdesign/core";

export function ResourceRouteLoading({ label }: { label: string }) {
  return <PageLayout><PageState state="loading"><Spinner label={`Loading ${label}...`} /></PageState></PageLayout>;
}

export function ResourceRouteError({ title, reset }: { title: string; reset: () => void }) {
  return <PageLayout><PageState state="error"><ErrorState title={`${title} unavailable`} message={`The ${title.toLowerCase()} view could not be opened.`} onRetry={reset} /></PageState></PageLayout>;
}
