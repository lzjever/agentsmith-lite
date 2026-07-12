import { WorkspaceSettingsPage } from "../../../../components/settings/WorkspaceSettingsPage";
export default async function WorkspaceSettingsRoute({ params }: { params: Promise<{ workspace: string }> }) { const { workspace } = await params; return <WorkspaceSettingsPage workspaceId={workspace} />; }
