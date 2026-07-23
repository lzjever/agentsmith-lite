"use client";

import { RouteErrorPage } from "../../../../../../components/layout/RouteStatePage";

export default function FilesError({ reset }: { reset: () => void }) { return <RouteErrorPage title="Files" message="File Libraries could not be opened." onRetry={reset} />; }
