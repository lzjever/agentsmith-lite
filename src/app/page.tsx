import { AppShell } from "../components/app-shell/AppShell";
import { WorkspaceDirectoryPage } from "../components/workspaces/WorkspaceDirectoryPage";

export default function HomePage() {
  return <AppShell><WorkspaceDirectoryPage /></AppShell>;
}
