"use client";

import { ResourceRouteError } from "../../../../../../components/resources/ResourceRouteState";

export default function UsageError({ reset }: { reset: () => void }) { return <ResourceRouteError title="Usage" reset={reset} />; }
