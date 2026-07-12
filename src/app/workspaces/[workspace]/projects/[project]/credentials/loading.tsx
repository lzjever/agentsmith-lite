import { PageState } from "../../../../../../components/layout/PageState";
import { PageLoading } from "../../../../../../components/ui/loading";
export default function Loading() { return <PageState state="loading"><PageLoading description="Loading credentials..." /></PageState>; }
