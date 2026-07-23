"use client";

import { RouteErrorPage } from "../../../../../../components/layout/RouteStatePage";

export default function AlertsError({ reset }: { reset: () => void }) { return <RouteErrorPage title="Alerts" message="The alerts view could not be opened." onRetry={reset} />; }
