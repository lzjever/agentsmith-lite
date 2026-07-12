import { ProjectSettingsPage } from "../../../../../../components/settings/ProjectSettingsPage";
export default async function ProjectSettingsRoute({ params }: { params: Promise<{ workspace: string; project: string }> }) { const { workspace, project } = await params; return <ProjectSettingsPage workspaceId={workspace} projectId={project} />; }
