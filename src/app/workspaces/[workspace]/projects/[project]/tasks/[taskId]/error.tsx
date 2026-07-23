"use client";

import { RouteErrorPage } from "../../../../../../../components/layout/RouteStatePage";

export default function TaskError({ reset }: { reset: () => void }) { return <RouteErrorPage title="Task" message="The task detail could not be opened." onRetry={reset} />; }
