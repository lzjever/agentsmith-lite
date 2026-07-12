import { PageLayout } from "../../../../../../../components/layout/PageLayout";
import { PageState } from "../../../../../../../components/layout/PageState";
import { PageLoading } from "../../../../../../../components/ui/loading";

export default function TaskDetailLoading() { return <PageLayout><PageState state="loading"><PageLoading description="Loading task..." /></PageState></PageLayout>; }
