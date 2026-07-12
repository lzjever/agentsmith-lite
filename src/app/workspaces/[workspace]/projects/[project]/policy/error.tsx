"use client";

import { ResourceRouteError } from "../../../../../../components/resources/ResourceRouteState";

export default function PolicyError({ reset }: { reset: () => void }) { return <ResourceRouteError title="Resource policy" reset={reset} />; }
