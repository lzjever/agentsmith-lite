import { AppShell } from "../../../components/app-shell/AppShell";

export default async function WorkspaceLayout({ children, params }: Readonly<{ children: React.ReactNode; params: Promise<{ workspace: string }> }>) {
  const { workspace } = await params;
  return <AppShell workspaceId={workspace}>{children}</AppShell>;
}
