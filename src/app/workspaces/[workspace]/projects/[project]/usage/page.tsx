import { UsagePage } from "../../../../../../components/resources/AuditUsagePage";
export default async function UsageRoute({ params }: { params: Promise<{ project: string }> }) { const { project } = await params; return <UsagePage projectId={project} />; }
