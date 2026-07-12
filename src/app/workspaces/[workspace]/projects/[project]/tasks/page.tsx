import { TasksPage } from "../../../../../../components/tasks/TasksPage";

export default async function TasksRoute({ params }: { params: Promise<{ workspace: string; project: string }> }) { const { workspace, project } = await params; return <TasksPage workspaceId={workspace} projectId={project} />; }
