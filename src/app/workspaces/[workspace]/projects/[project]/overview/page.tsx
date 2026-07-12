import { ProjectOverviewPage } from "../../../../../../components/projects/ProjectOverviewPage";

export default async function OverviewRoute({ params }: { params: Promise<{ workspace: string; project: string }> }) {
  const { workspace, project } = await params;
  return <ProjectOverviewPage workspaceId={workspace} projectId={project} />;
}
