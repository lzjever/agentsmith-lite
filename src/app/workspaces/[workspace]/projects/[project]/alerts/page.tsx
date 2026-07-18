import { AlertsPage } from "../../../../../../components/resources/AlertsPage";
export default async function AlertsRoute({ params }: { params: Promise<{ workspace: string; project: string }> }) { const { workspace, project } = await params; return <AlertsPage workspaceId={workspace} projectId={project} />; }
