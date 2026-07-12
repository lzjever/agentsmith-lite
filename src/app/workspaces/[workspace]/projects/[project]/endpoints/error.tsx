"use client";
import { PageState } from "../../../../../../components/layout/PageState";
import { Button } from "../../../../../../components/ui/button";
export default function EndpointsError({ reset }: { reset: () => void }) { return <PageState><div className="space-y-3"><h2 className="type-title">Endpoints unavailable</h2><Button onClick={reset}>Try again</Button></div></PageState>; }
