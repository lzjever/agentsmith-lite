import { ContextManager } from "../../../../components/context/ContextManager";

export default async function WorkspaceContextPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  return <ContextManager workspaceId={workspace} />;
}
