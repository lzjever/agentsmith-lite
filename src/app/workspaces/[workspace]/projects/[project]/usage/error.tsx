"use client";

import { RouteErrorPage } from "../../../../../../components/layout/RouteStatePage";

export default function UsageError({ reset }: { reset: () => void }) { return <RouteErrorPage title="Usage" message="The usage view could not be opened." onRetry={reset} />; }
