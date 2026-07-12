"use client";

import { PageState } from "../layout/PageState";
import { ErrorState } from "../ui/error-state";
import { PageLoading } from "../ui/loading";

export function SettingsRouteLoading() { return <PageState state="loading"><PageLoading description="Loading settings..." /></PageState>; }

export function SettingsRouteError({ reset }: { reset: () => void }) { return <PageState state="error"><ErrorState title="Settings unavailable" message="The settings page could not be loaded." onRetry={reset} /></PageState>; }
