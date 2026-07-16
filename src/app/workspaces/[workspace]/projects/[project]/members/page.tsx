import { MembersPage } from "../../../../../../components/members/MembersPage";
export default async function MembersRoute({ params }: { params: Promise<{ workspace: string; project: string }> }) { const { workspace, project } = await params; return <MembersPage workspaceId={workspace} projectId={project} />; }
