import { MembersPage } from "../../../../../../components/members/MembersPage";
export default async function MembersRoute({ params }: { params: Promise<{ project: string }> }) { const { project } = await params; return <MembersPage projectId={project} />; }
