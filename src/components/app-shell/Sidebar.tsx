import type { LucideIcon } from "lucide-react";
import { Bell, ClipboardList, FileKey, FileText, FolderKanban, Gauge, LayoutDashboard, NotebookTabs, Server, Settings, SlidersHorizontal, Users, Wrench } from "lucide-react";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core";
import type { Project, Workspace } from "../../lib/api/client";

type NavigationProps = {
  workspace?: Workspace | undefined;
  project?: Project | undefined;
  pathname: string;
  collapsed?: boolean | undefined;
  onCollapsedChange?: ((collapsed: boolean) => void) | undefined;
  onNavigate?: (() => void) | undefined;
};
type NavItem = { label: string; href: string; icon: LucideIcon; active: (pathname: string) => boolean; };

export function ShellNavigation({ workspace, project, pathname, collapsed = false, onCollapsedChange, onNavigate }: NavigationProps) {
  const groups = project && workspace ? projectGroups(workspace, project) : workspaceGroups(workspace);
  return <SideNav
    collapsible={onCollapsedChange ? { isCollapsed: collapsed, onCollapsedChange, buttonLabel: collapsed ? "Expand navigation" : "Collapse navigation" } : false}
    className="h-full"
  >
    {groups.map((group) => <SideNavSection key={group.label} title={group.label}>{group.items.map((item) => <NavigationLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />)}</SideNavSection>)}
  </SideNav>;
}

function NavigationLink({ item, pathname, onNavigate }: { item: NavItem; pathname: string; onNavigate?: (() => void) | undefined }) {
  const active = item.active(pathname);
  return <SideNavItem label={item.label} href={item.href} icon={<item.icon size={18} />} isSelected={active} {...(onNavigate ? { onClick: () => onNavigate() } : {})} />;
}

function workspaceGroups(workspace?: Workspace): Array<{ label: string; items: NavItem[] }> {
  const workspaces: NavItem = { label: "Workspaces", href: "/", icon: FolderKanban, active: (pathname) => pathname === "/" };
  if (!workspace) return [{ label: "Workspace", items: [workspaces] }];
  const base = `/workspaces/${workspace.id}`;
  return [{ label: "Workspace", items: [{ label: "Overview", href: base, icon: LayoutDashboard, active: (pathname) => pathname === base }, { label: "Projects", href: `${base}/projects`, icon: FolderKanban, active: (pathname) => pathname === `${base}/projects` }, { label: "Context", href: `${base}/context`, icon: NotebookTabs, active: (pathname) => pathname === `${base}/context` }, { label: "Members", href: `${base}/members`, icon: Users, active: (pathname) => pathname === `${base}/members` }, { label: "Settings", href: `${base}/settings`, icon: SlidersHorizontal, active: (pathname) => pathname === `${base}/settings` }] }];
}

function projectGroups(workspace: Workspace, project: Project): Array<{ label: string; items: NavItem[] }> {
  const base = `/workspaces/${workspace.id}/projects/${project.id}`;
  const item = (label: string, segment: string, icon: LucideIcon): NavItem => ({ label, href: `${base}/${segment}`, icon, active: (pathname) => pathname === `${base}/${segment}` || pathname.startsWith(`${base}/${segment}/`) });
  return [
    { label: "Home", items: [item("Overview", "overview", LayoutDashboard)] },
    { label: "Use", items: [item("Tasks", "tasks", Wrench), item("Files", "files", FileText), item("Context", "context", NotebookTabs), item("Usage", "usage", Gauge)] },
    { label: "Develop", items: [item("Endpoints", "endpoints", Server), item("Credentials", "credentials", FileKey)] },
    { label: "Manage", items: [item("Members", "members", Users), item("Resource policy", "policy", SlidersHorizontal), item("Alerts", "alerts", Bell), item("Audit", "audit", ClipboardList), item("Settings", "settings", Settings)] }
  ];
}
