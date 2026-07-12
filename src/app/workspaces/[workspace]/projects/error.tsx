"use client";

import { PageState } from "../../../../components/layout/PageState";
import { Button } from "../../../../components/ui/button";

export default function ProjectsError({ reset }: { error: Error; reset: () => void }) { return <PageState><div className="space-y-3"><h1 className="type-title">Projects unavailable</h1><p className="text-sm text-secondary">The projects could not be opened.</p><Button onClick={reset}>Try again</Button></div></PageState>; }
