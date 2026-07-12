"use client";

import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { ApiError, apiClient, oidcStartUrlForReturnTo, type CurrentUser, type Project, type Workspace } from "../../lib/api/client";
import { Button } from "../ui/button";
import { ErrorState } from "../ui/error-state";
import { PageLoading } from "../ui/loading";
import { Sheet, SheetContent } from "../ui/sheet";
import { ToastContainer } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import { ShellNavigation } from "./Sidebar";
import { ProjectSwitcher, Topbar } from "./Topbar";
import { ThemeToggle } from "../theme/ThemeToggle";

type ShellProps = { children: ReactNode; workspaceId?: string; projectId?: string; };
type ShellState = "loading" | "ready" | "login" | "error";

export function AppShell({ children, workspaceId, projectId }: ShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const routeParams = useParams<{ project?: string | string[] }>();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [status, setStatus] = useState<ShellState>("loading");
  const [user, setUser] = useState<CurrentUser>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);

  async function load() {
    setStatus("loading");
    try {
      const [identity, allWorkspaces] = await Promise.all([apiClient.currentIdentity(), apiClient.workspaces()]);
      setUser(identity.user);
      setWorkspaces(allWorkspaces);
      setStatus("ready");
    } catch (error) {
      setStatus(error instanceof ApiError && error.status === 401 ? "login" : "error");
    }
  }

  useEffect(() => {
    void load();
    setCollapsed(window.localStorage.getItem("agentsmith-sidebar-collapsed") === "1");
  }, []);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem("agentsmith-sidebar-collapsed", next ? "1" : "0");
      return next;
    });
  }

  if (status === "loading") return <ShellLoadingFrame />;
  if (status === "login") {
    const returnTo = typeof window === "undefined" ? pathname : `${window.location.pathname}${window.location.search}${window.location.hash}`;
    return <ShellStatePage title="Sign in to continue" detail="Use your configured identity provider to access projects." action={<a className="inline-flex min-h-9 items-center justify-center rounded-sm border border-accent bg-accent px-3 text-sm text-white no-underline hover:bg-accent/90" href={oidcStartUrlForReturnTo(returnTo)}>Sign in</a>} />;
  }
  if (status === "error") return <main className="grid min-h-screen place-items-center bg-background"><ErrorState title="Workspace unavailable" message="The product API could not load your session." onRetry={() => void load()} /></main>;

  const workspace = workspaces.find((item) => item.id === workspaceId);
  const routedProjectId = Array.isArray(routeParams.project) ? routeParams.project[0] : routeParams.project;
  const project = workspace?.projects.find((item) => item.id === (projectId ?? routedProjectId));
  return <TooltipProvider><div className="min-h-screen bg-background"><Topbar user={user!} workspaces={workspaces} workspace={workspace} project={project} onOpenNavigation={() => setMobileNavigationOpen(true)} /><div className="flex min-h-[calc(100vh-2.75rem)]"><aside className={`hidden shrink-0 flex-col border-r border-border bg-panel transition-[width] duration-200 md:flex ${collapsed ? "w-[var(--sidebar-width-collapsed)]" : "w-[var(--sidebar-width)]"}`}><ShellNavigation workspace={workspace} project={project} pathname={pathname} collapsed={collapsed} /><Button variant="quiet" size="icon" className="m-3 self-end" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} onClick={toggleCollapsed}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</Button></aside><Sheet open={mobileNavigationOpen} onOpenChange={setMobileNavigationOpen}><SheetContent aria-describedby={undefined}><div className="border-b border-border px-4 py-3"><span className="font-display text-lg text-foreground">AgentSmith</span>{workspace && project ? <div className="mt-3"><ProjectSwitcher workspace={workspace} project={project} mobile onSelect={(id) => router.push(`/workspaces/${workspace.id}/projects/${id}/overview`)} /></div> : null}</div><ShellNavigation workspace={workspace} project={project} pathname={pathname} onNavigate={() => setMobileNavigationOpen(false)} /><ThemeToggle mobile /></SheetContent></Sheet><main className="min-w-0 flex-1">{children}</main></div><ToastContainer /></div></TooltipProvider>;
}

function ShellLoadingFrame() {
  return <div className="min-h-screen bg-background"><header className="sticky top-0 flex h-11 items-center border-b border-border px-4 md:px-5"><span className="font-display text-lg text-foreground">AgentSmith</span></header><div className="flex min-h-[calc(100vh-2.75rem)]"><aside className="hidden w-[var(--sidebar-width)] border-r border-border bg-panel md:block" aria-hidden="true" /><main className="grid min-w-0 flex-1 place-items-center"><PageLoading description="Loading workspace..." /></main></div></div>;
}

function ShellStatePage({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <main className="grid min-h-screen place-items-center bg-background px-6"><section className="max-w-md text-center"><p className="type-caption text-tertiary">AgentSmith</p><h1 className="type-section-heading mt-3">{title}</h1>{detail ? <p className="type-body-ui mt-3 text-secondary">{detail}</p> : null}{action ? <p className="mt-6">{action}</p> : null}</section></main>;
}
