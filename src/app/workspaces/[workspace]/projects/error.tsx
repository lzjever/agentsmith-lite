"use client";

import { RouteErrorPage } from "../../../../components/layout/RouteStatePage";

export default function ProjectsError({ reset }: { reset: () => void }) { return <RouteErrorPage title="Projects" message="The projects could not be opened." onRetry={reset} />; }
