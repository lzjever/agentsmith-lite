import { AuditPage } from "../../../../../../components/resources/AuditUsagePage";
export default async function AuditRoute({ params }: { params: Promise<{ project: string }> }) { const { project } = await params; return <AuditPage projectId={project} />; }
