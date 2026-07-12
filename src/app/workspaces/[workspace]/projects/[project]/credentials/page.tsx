import { CredentialsPage } from "../../../../../../components/credentials/CredentialsPage";
export default async function CredentialsRoute({ params }: { params: Promise<{ project: string }> }) { const { project } = await params; return <CredentialsPage projectId={project} />; }
