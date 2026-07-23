"use client";

import { RouteErrorPage } from "../../../../components/layout/RouteStatePage";

export default function WorkspaceSettingsError({ error, reset }: { error: Error; reset: () => void }) { return <RouteErrorPage title="Workspace settings" message={error.message || "The settings page could not be loaded."} onRetry={reset} />; }
