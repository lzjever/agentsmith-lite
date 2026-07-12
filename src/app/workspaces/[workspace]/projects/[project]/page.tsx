import { redirect } from "next/navigation";
export default async function ProjectPage({ params }: { params: Promise<{ workspace: string; project: string }> }) { const { workspace, project } = await params; redirect(`/workspaces/${workspace}/projects/${project}/overview`); }
