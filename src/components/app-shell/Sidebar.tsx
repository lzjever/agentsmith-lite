import type { LucideIcon } from "lucide-react";
import { Bell, ClipboardList, FileKey, FileText, FolderKanban, Gauge, LayoutDashboard, MessageSquare, NotebookTabs, Server, Settings, SlidersHorizontal, Users, Wrench } from "lucide-react";
import Link from "next/link";
import { cn } from "../ui/cn";
import { Tooltip, TooltipContent } from "../ui/tooltip";
import type { Project, Workspace } from "../../lib/api/client";

type NavigationProps = { workspace?: Workspace | undefined; project?: Project | undefined; pathname: string; collapsed?: boolean | undefined; onNavigate?: (() => void) | undefined; };
type NavItem = { label: string; href: string; icon: LucideIcon; active: (pathname: string) => boolean; };

export function ShellNavigation({ workspace, project, pathname, collapsed = false, onNavigate }: NavigationProps) {
  const groups = project && workspace ? projectGroups(workspace, project) : workspaceGroups(workspace);
  return <nav aria-label="Primary navigation" className="flex-1 overflow-y-auto px-2.5 py-4">{groups.map((group) => <section className="mb-5" key={group.label}><p className={cn("mb-1.5 px-2.5 text-[11px] font-medium text-tertiary", collapsed && "sr-only")}>{group.label}</p><div className="space-y-1">{group.items.map((item) => <NavigationLink key={item.href} item={item} pathname={pathname} collapsed={collapsed} onNavigate={onNavigate} />)}</div></section>)}</nav>;
}

function NavigationLink({ item, pathname, collapsed, onNavigate }: { item: NavItem; pathname: string; collapsed: boolean; onNavigate?: (() => void) | undefined }) {
  const active = item.active(pathname);
  const link = <Link href={item.href} {...(onNavigate ? { onClick: onNavigate } : {})} aria-label={collapsed ? item.label : undefined} aria-current={active ? "page" : undefined} className={cn("relative flex h-9 items-center rounded-md border border-transparent text-sm transition-[background-color,border-color,color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30", collapsed ? "justify-center px-0" : "gap-3 px-2.5", active ? "border-border bg-surface font-medium text-foreground shadow-ambient before:absolute before:-left-[3px] before:h-5 before:w-0.5 before:rounded-pill before:bg-accent" : "text-secondary hover:bg-hover hover:text-foreground")}><item.icon className={cn("size-[18px] shrink-0", active ? "text-accent" : "text-icon-default")} /><span className={cn("truncate", collapsed && "hidden")}>{item.label}</span></Link>;
  return collapsed ? <Tooltip.Root><Tooltip.Trigger asChild>{link}</Tooltip.Trigger><TooltipContent>{item.label}</TooltipContent></Tooltip.Root> : link;
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
    { label: "Use", items: [item("Chat", "chat", MessageSquare), item("Tasks", "tasks", Wrench), item("Files", "files", FileText), item("Context", "context", NotebookTabs), item("Usage", "usage", Gauge)] },
    { label: "Develop", items: [item("Endpoints", "endpoints", Server), item("Credentials", "credentials", FileKey)] },
    { label: "Manage", items: [item("Members", "members", Users), item("Resource policy", "policy", SlidersHorizontal), item("Alerts", "alerts", Bell), item("Audit", "audit", ClipboardList), item("Settings", "settings", Settings)] }
  ];
}
