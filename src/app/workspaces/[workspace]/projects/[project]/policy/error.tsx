"use client";

import { RouteErrorPage } from "../../../../../../components/layout/RouteStatePage";

export default function PolicyError({ reset }: { reset: () => void }) { return <RouteErrorPage title="Resource policy" message="The resource policy view could not be opened." onRetry={reset} />; }
