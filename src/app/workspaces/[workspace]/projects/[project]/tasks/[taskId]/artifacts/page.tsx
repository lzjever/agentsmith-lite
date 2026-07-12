import { TaskDetailPage } from "../../../../../../../../components/tasks/TaskDetailPage";

export default async function ArtifactsRoute({ params }: { params: Promise<{ workspace: string; project: string; taskId: string }> }) { const { workspace, project, taskId } = await params; return <TaskDetailPage workspaceId={workspace} projectId={project} taskId={taskId} artifactsOnly />; }
