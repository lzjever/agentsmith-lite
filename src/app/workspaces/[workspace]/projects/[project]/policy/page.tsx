import { ResourcePolicyPage } from "../../../../../../components/resources/ResourcePolicyPage";
export default async function PolicyRoute({ params }: { params: Promise<{ project: string }> }) { const { project } = await params; return <ResourcePolicyPage projectId={project} />; }
