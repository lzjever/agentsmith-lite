import { WorkspaceMembersPage } from "../../../../components/workspaces/WorkspaceMembersPage";
export default async function WorkspaceMembersRoute({ params }: { params: Promise<{ workspace: string }> }) { const { workspace } = await params; return <WorkspaceMembersPage workspaceId={workspace}/>; }
