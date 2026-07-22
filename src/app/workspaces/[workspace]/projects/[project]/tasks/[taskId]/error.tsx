"use client";

import { PageLayout } from "../../../../../../../components/layout/PageLayout";
import { PageState } from "../../../../../../../components/layout/PageState";
import { Button } from "@astryxdesign/core";

export default function TaskError({ reset }: { error: Error; reset: () => void }) { return <PageLayout><PageState><div className="space-y-3"><h1 className="type-title">Task unavailable</h1><p className="text-sm text-secondary">The task detail could not be opened.</p><Button onClick={reset}>Try again</Button></div></PageState></PageLayout>; }
