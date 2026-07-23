"use client";

import { RouteErrorPage } from "../../../../../../components/layout/RouteStatePage";

export default function MembersError({ reset }: { reset: () => void }) { return <RouteErrorPage title="Members" message="The members view could not be opened." onRetry={reset} />; }
