import { ContextManager } from "../../../../../../components/context/ContextManager";

export default async function ProjectContextPage({ params }: { params: Promise<{ workspace: string; project: string }> }) {
  const { workspace, project } = await params;
  return <ContextManager workspaceId={workspace} projectId={project} />;
}
