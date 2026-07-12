"use client";

import { ResourceRouteError } from "../../../../../../components/resources/ResourceRouteState";

export default function AuditError({ reset }: { reset: () => void }) { return <ResourceRouteError title="Audit" reset={reset} />; }
