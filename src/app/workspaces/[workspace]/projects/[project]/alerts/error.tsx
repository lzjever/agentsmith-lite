"use client";

import { ResourceRouteError } from "../../../../../../components/resources/ResourceRouteState";

export default function AlertsError({ reset }: { reset: () => void }) { return <ResourceRouteError title="Alerts" reset={reset} />; }
