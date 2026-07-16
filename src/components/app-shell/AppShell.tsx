"use client";

import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
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
type DirectoryState = "loading" | "ready" | "error";

export function AppShell({ children, workspaceId, projectId }: ShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const routeParams = useParams<{ project?: string | string[] }>();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [status, setStatus] = useState<ShellState>("loading");
  const [directoryState, setDirectoryState] = useState<DirectoryState>("loading");
  const [user, setUser] = useState<CurrentUser>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const routedProjectId = Array.isArray(routeParams.project) ? routeParams.project[0] : routeParams.project;

  async function loadIdentity() {
    setStatus("loading");
    try {
      const identity = await apiClient.currentIdentity();
      setUser(identity.user);
      setStatus("ready");
    } catch (error) {
      setStatus(error instanceof ApiError && error.status === 401 ? "login" : "error");
    }
  }

  async function loadDirectory() {
    setDirectoryState("loading");
    try {
      setWorkspaces(await apiClient.workspaces());
      setDirectoryState("ready");
    } catch {
      setWorkspaces([]);
      setDirectoryState("error");
    }
  }

  useEffect(() => {
    void loadIdentity();
    setCollapsed(window.localStorage.getItem("agentsmith-sidebar-collapsed") === "1");
  }, []);

  useEffect(() => {
    void loadDirectory();
  }, [workspaceId, routedProjectId]);

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
  if (status === "error") return <main className="grid min-h-screen place-items-center bg-background"><ErrorState title="Workspace unavailable" message="The product API could not load your session." onRetry={() => void loadIdentity()} /></main>;
  if (directoryState === "loading") return <ShellLoadingFrame />;

  const workspace = workspaces.find((item) => item.id === workspaceId);
  const project = workspace?.projects.find((item) => item.id === (projectId ?? routedProjectId));
  const requestedProjectId = projectId ?? routedProjectId;
  const projectWorkspace = requestedProjectId ? workspaces.find((item) => item.projects.some((candidate) => candidate.id === requestedProjectId)) : undefined;
  const contextError = directoryState === "ready" && workspaceId && !workspace
    ? <ShellRecoveryState title="Workspace unavailable" detail="This workspace does not exist or you no longer have permission to access it." retry={loadDirectory} />
    : directoryState === "ready" && workspace && requestedProjectId && !project
      ? projectWorkspace
        ? <ShellRecoveryState title="Project and workspace do not match" detail={`This project belongs to ${projectWorkspace.name}, not ${workspace.name}.`} projectHref={`/workspaces/${projectWorkspace.id}/projects/${requestedProjectId}/overview`} retry={loadDirectory} />
        : <ShellRecoveryState title="Project unavailable" detail="This project does not exist in this workspace or you no longer have permission to access it." projectsHref={`/workspaces/${workspace.id}/projects`} retry={loadDirectory} />
      : null;
  return <TooltipProvider><div className="min-h-screen bg-background"><Topbar user={user!} workspaces={workspaces} workspace={workspace} project={project} profileReturnTo={pathname} onOpenNavigation={() => setMobileNavigationOpen(true)} /><div className="flex min-h-[calc(100vh-2.75rem)]"><aside className={`hidden shrink-0 flex-col border-r border-border bg-panel transition-[width] duration-200 md:flex ${collapsed ? "w-[var(--sidebar-width-collapsed)]" : "w-[var(--sidebar-width)]"}`}><ShellNavigation workspace={workspace} project={project} pathname={pathname} collapsed={collapsed} /><Button variant="quiet" size="icon" className="m-3 self-end" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} onClick={toggleCollapsed}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</Button></aside><Sheet open={mobileNavigationOpen} onOpenChange={setMobileNavigationOpen}><SheetContent aria-describedby={undefined}><div className="border-b border-border px-4 py-3"><span className="font-display text-lg text-foreground">AgentSmith</span>{workspace && project ? <div className="mt-3"><ProjectSwitcher workspace={workspace} project={project} mobile onSelect={(id) => router.push(`/workspaces/${workspace.id}/projects/${id}/overview`)} onViewAll={() => router.push(`/workspaces/${workspace.id}/projects`)} /></div> : null}</div><ShellNavigation workspace={workspace} project={project} pathname={pathname} onNavigate={() => setMobileNavigationOpen(false)} /><ThemeToggle mobile /></SheetContent></Sheet><main className="min-w-0 flex-1">{directoryState === "error" ? <DirectoryNotice onRetry={loadDirectory} /> : null}{contextError ?? children}</main></div><ToastContainer /></div></TooltipProvider>;
}

function ShellLoadingFrame() {
  return <div className="min-h-screen bg-background"><header className="sticky top-0 flex h-11 items-center border-b border-border px-4 md:px-5"><span className="font-display text-lg text-foreground">AgentSmith</span></header><div className="flex min-h-[calc(100vh-2.75rem)]"><aside className="hidden w-[var(--sidebar-width)] border-r border-border bg-panel md:block" aria-hidden="true" /><main className="grid min-w-0 flex-1 place-items-center"><PageLoading description="Loading workspace..." /></main></div></div>;
}

function ShellStatePage({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <main className="grid min-h-screen place-items-center bg-background px-6"><section className="max-w-md text-center"><p className="type-caption text-tertiary">AgentSmith</p><h1 className="type-section-heading mt-3">{title}</h1>{detail ? <p className="type-body-ui mt-3 text-secondary">{detail}</p> : null}{action ? <p className="mt-6">{action}</p> : null}</section></main>;
}

function DirectoryNotice({ onRetry }: { onRetry: () => Promise<void> }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface-low px-4 py-2 text-sm text-secondary" role="status"><span>Workspace navigation is unavailable. This page may still be used.</span><Button size="sm" variant="quiet" onClick={() => void onRetry()}>Retry navigation</Button></div>;
}

function ShellRecoveryState({ title, detail, projectsHref, projectHref, retry }: { title: string; detail: string; projectsHref?: string; projectHref?: string; retry: () => Promise<void> }) {
  return <section className="grid min-h-[calc(100vh-2.75rem)] place-items-center px-6"><div className="max-w-lg text-center"><h1 className="type-section-heading">{title}</h1><p className="mt-3 text-sm text-secondary">{detail}</p><div className="mt-6 flex flex-wrap justify-center gap-2">{projectHref ? <Link className="inline-flex min-h-9 items-center rounded-sm bg-accent px-3 text-sm text-white no-underline hover:bg-accent/90" href={projectHref}>Open project</Link> : null}{projectsHref ? <Link className="inline-flex min-h-9 items-center rounded-sm bg-accent px-3 text-sm text-white no-underline hover:bg-accent/90" href={projectsHref}>View all projects</Link> : null}<Link className="inline-flex min-h-9 items-center rounded-sm border border-border px-3 text-sm text-secondary no-underline hover:text-foreground" href="/">Back to workspaces</Link><Button variant="quiet" onClick={() => void retry()}>Check access again</Button></div></div></section>;
}
