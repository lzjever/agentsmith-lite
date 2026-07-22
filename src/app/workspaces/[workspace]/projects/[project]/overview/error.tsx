"use client";

import { PageLayout } from "../../../../../../components/layout/PageLayout";
import { PageState } from "../../../../../../components/layout/PageState";
import { Button } from "@astryxdesign/core";

export default function OverviewError({ reset }: { error: Error; reset: () => void }) { return <PageLayout><PageState><div className="space-y-3"><h1 className="type-title">Project overview unavailable</h1><p className="text-sm text-secondary">The project overview could not be opened.</p><Button label="Try again" variant="secondary" onClick={reset} /></div></PageState></PageLayout>; }
