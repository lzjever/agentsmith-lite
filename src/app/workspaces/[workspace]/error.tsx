"use client";

import { RouteErrorPage } from "../../../components/layout/RouteStatePage";

export default function WorkspaceError({ reset }: { reset: () => void }) { return <RouteErrorPage title="Workspace" message="The workspace could not be opened." onRetry={reset} />; }
