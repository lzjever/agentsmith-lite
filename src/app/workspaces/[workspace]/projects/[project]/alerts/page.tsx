import { AlertsPage } from "../../../../../../components/resources/AlertsPage";
export default async function AlertsRoute({ params }: { params: Promise<{ project: string }> }) { const { project } = await params; return <AlertsPage projectId={project} />; }
