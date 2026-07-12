import { WorkspaceProjectsEntryPage } from "../../../../components/workspaces/WorkspaceProjectsEntryPage";

export default async function WorkspaceProjectsRoute({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  return <WorkspaceProjectsEntryPage workspaceId={workspace} />;
}
