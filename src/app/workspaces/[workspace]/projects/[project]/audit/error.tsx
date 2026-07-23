"use client";

import { RouteErrorPage } from "../../../../../../components/layout/RouteStatePage";

export default function AuditError({ reset }: { reset: () => void }) { return <RouteErrorPage title="Audit" message="The audit view could not be opened." onRetry={reset} />; }
