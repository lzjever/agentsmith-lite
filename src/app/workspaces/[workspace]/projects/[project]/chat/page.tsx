import { ProjectChatPage } from "../../../../../../components/chat/ProjectChatPage";
export default async function ChatRoute({ params }: { params: Promise<{ project: string }> }) { const { project } = await params; return <ProjectChatPage projectId={project} />; }
