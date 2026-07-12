import { PageLayout } from "../../../../../../../../components/layout/PageLayout";
import { PageState } from "../../../../../../../../components/layout/PageState";
import { PageLoading } from "../../../../../../../../components/ui/loading";

export default function ArtifactsLoading() { return <PageLayout><PageState state="loading"><PageLoading description="Loading artifacts..." /></PageState></PageLayout>; }
