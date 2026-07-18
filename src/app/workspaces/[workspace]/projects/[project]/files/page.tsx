import { ProjectFilesPage } from "../../../../../../components/files/ProjectFilesPage";

export default async function FilesRoute({ params }: { params: Promise<{ workspace: string; project: string }> }) { const { workspace, project } = await params; return <ProjectFilesPage workspaceId={workspace} projectId={project} />; }
