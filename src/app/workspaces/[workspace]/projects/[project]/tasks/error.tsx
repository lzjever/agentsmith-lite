"use client";

import { PageLayout } from "../../../../../../components/layout/PageLayout";
import { PageState } from "../../../../../../components/layout/PageState";
import { Button } from "@astryxdesign/core";

export default function TasksError({ reset }: { reset: () => void }) {
  return <PageLayout><PageState><div className="text-center"><p className="text-error">The task view could not be opened.</p><Button className="mt-4" label="Try again" onClick={reset} /></div></PageState></PageLayout>;
}
