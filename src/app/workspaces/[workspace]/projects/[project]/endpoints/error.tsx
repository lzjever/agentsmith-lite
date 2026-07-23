"use client";

import { RouteErrorPage } from "../../../../../../components/layout/RouteStatePage";

export default function EndpointsError({ reset }: { reset: () => void }) { return <RouteErrorPage title="Endpoints" message="The endpoints view could not be opened." onRetry={reset} />; }
