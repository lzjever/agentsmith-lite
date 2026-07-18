import { ProjectChatPage } from "../../../../../../components/chat/ProjectChatPage";
export default async function ChatRoute({ params }: { params: Promise<{ workspace: string; project: string }> }) { const { workspace, project } = await params; return <ProjectChatPage workspaceId={workspace} projectId={project} />; }
