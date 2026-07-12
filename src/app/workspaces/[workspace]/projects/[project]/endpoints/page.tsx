import { EndpointsPage } from "../../../../../../components/endpoints/EndpointsPage";
export default async function EndpointsRoute({ params }: { params: Promise<{ project: string }> }) { const { project } = await params; return <EndpointsPage projectId={project} />; }
