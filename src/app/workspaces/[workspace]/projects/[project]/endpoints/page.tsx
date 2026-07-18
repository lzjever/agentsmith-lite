import { EndpointsPage } from "../../../../../../components/endpoints/EndpointsPage";
export default async function EndpointsRoute({ params }: { params: Promise<{ workspace: string; project: string }> }) { const { workspace, project } = await params; return <EndpointsPage workspaceId={workspace} projectId={project} />; }
