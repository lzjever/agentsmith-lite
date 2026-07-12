import { PageLayout } from "../../../../../../components/layout/PageLayout";
import { PageState } from "../../../../../../components/layout/PageState";
import { PageLoading } from "../../../../../../components/ui/loading";

export default function ChatLoading() { return <PageLayout contentWidth="full"><PageState state="loading"><PageLoading description="Loading chat..." /></PageState></PageLayout>; }
