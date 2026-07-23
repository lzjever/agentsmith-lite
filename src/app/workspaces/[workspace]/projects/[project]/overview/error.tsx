"use client";

import { RouteErrorPage } from "../../../../../../components/layout/RouteStatePage";

export default function OverviewError({ reset }: { reset: () => void }) { return <RouteErrorPage title="Project overview" message="The project overview could not be opened." onRetry={reset} />; }
