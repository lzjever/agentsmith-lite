"use client";

import { PageLayout } from "../../../../../../../../components/layout/PageLayout";
import { PageState } from "../../../../../../../../components/layout/PageState";
import { Button } from "@astryxdesign/core";

export default function ArtifactsError({ reset }: { error: Error; reset: () => void }) { return <PageLayout><PageState><div className="space-y-3"><h1 className="type-title">Artifacts unavailable</h1><p className="text-sm text-secondary">The task artifacts could not be opened.</p><Button label="Try again" onClick={reset} /></div></PageState></PageLayout>; }
