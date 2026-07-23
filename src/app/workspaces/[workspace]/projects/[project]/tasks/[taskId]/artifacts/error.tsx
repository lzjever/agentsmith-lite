"use client";

import { RouteErrorPage } from "../../../../../../../../components/layout/RouteStatePage";

export default function ArtifactsError({ reset }: { reset: () => void }) { return <RouteErrorPage title="Artifacts" message="The task artifacts could not be opened." onRetry={reset} />; }
