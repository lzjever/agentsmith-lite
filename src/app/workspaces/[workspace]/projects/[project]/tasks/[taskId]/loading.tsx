import { Spinner } from "@astryxdesign/core";
import { PageLayout } from "../../../../../../../components/layout/PageLayout";
import { PageState } from "../../../../../../../components/layout/PageState";

export default function TaskDetailLoading() {
  return <PageLayout><PageState state="loading"><section className="flex min-h-48 items-center border-y border-subtle py-6" aria-busy="true"><Spinner size="sm" label="Loading task..." /></section></PageState></PageLayout>;
}
