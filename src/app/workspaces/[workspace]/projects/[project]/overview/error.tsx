"use client";

import { PageLayout } from "../../../../../../components/layout/PageLayout";
import { PageState } from "../../../../../../components/layout/PageState";
import { Button } from "../../../../../../components/ui/button";

export default function OverviewError({ reset }: { error: Error; reset: () => void }) { return <PageLayout><PageState><div className="space-y-3"><h1 className="type-title">Project overview unavailable</h1><p className="text-sm text-secondary">The project overview could not be opened.</p><Button onClick={reset}>Try again</Button></div></PageState></PageLayout>; }
