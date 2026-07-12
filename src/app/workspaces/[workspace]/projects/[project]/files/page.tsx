import { ProjectFilesPage } from "../../../../../../components/files/ProjectFilesPage";

export default async function FilesRoute({ params }: { params: Promise<{ project: string }> }) { const { project } = await params; return <ProjectFilesPage projectId={project} />; }
