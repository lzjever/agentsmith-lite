import { WorkspaceOverviewPage } from "../../../components/workspaces/WorkspaceOverviewPage";

export default async function WorkspacePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  return <WorkspaceOverviewPage workspaceId={workspace} />;
}
