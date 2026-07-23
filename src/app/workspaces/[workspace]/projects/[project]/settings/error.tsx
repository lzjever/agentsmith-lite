"use client";

import { RouteErrorPage } from "../../../../../../components/layout/RouteStatePage";

export default function ProjectSettingsError({ error, reset }: { error: Error; reset: () => void }) { return <RouteErrorPage title="Project settings" message={error.message || "The settings page could not be loaded."} onRetry={reset} />; }
