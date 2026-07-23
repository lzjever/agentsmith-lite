"use client";

import { RouteErrorPage } from "../../../../../../components/layout/RouteStatePage";

export default function TasksError({ reset }: { reset: () => void }) { return <RouteErrorPage title="Tasks" message="The task view could not be opened." onRetry={reset} />; }
