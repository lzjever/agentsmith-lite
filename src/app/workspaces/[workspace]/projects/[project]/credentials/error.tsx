"use client";

import { RouteErrorPage } from "../../../../../../components/layout/RouteStatePage";

export default function CredentialsError({ reset }: { reset: () => void }) { return <RouteErrorPage title="Project credentials" message="The credentials page could not be loaded." onRetry={reset} />; }
