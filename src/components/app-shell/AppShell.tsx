"use client";

import { AppShell as AstryxAppShell, Button, MobileNav, Spinner } from "@astryxdesign/core";
import { useParams, usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, DIRECTORY_CHANGED_EVENT, IDENTITY_CHANGED_EVENT, oidcStartUrlForReturnTo, SESSION_EXPIRED_EVENT, type CurrentUser, type Project, type Workspace } from "../../lib/api/client";
import { DocumentTitle } from "../layout/DocumentTitle";
import { ShellNavigation } from "./Sidebar";
import { Topbar } from "./Topbar";

type ShellProps = { children: ReactNode; workspaceId?: string; projectId?: string; };
type ShellState = "loading" | "ready" | "login" | "error";
type DirectoryState = "loading" | "ready" | "error";

export function AppShell({ children, workspaceId, projectId }: ShellProps) {
  const mounted = useRef(true);
  const identityRequest = useRef(0);
  const directoryRequest = useRef(0);
  const hasDirectory = useRef(false);
  const contentStart = useRef<HTMLDivElement>(null);
  const lastPathname = useRef<string | undefined>(undefined);
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

  async function loadIdentity(preservePage = false) {
    const request = ++identityRequest.current;
    if (!preservePage) setStatus("loading");
    try {
      const identity = await apiClient.currentIdentity();
      if (!mounted.current || request !== identityRequest.current) return;
      setUser(identity.user);
      setStatus("ready");
    } catch (error) {
      if (!mounted.current || request !== identityRequest.current) return;
      if (error instanceof ApiError && error.status === 401) setStatus("login");
      else if (!preservePage) setStatus("error");
    }
  }

  async function loadDirectory(preservePage = hasDirectory.current) {
    const request = ++directoryRequest.current;
    if (!preservePage) setDirectoryState("loading");
    try {
      const listed = await apiClient.workspaces();
      if (!mounted.current || request !== directoryRequest.current) return;
      setWorkspaces(listed);
      hasDirectory.current = true;
      setDirectoryState("ready");
    } catch {
      if (!mounted.current || request !== directoryRequest.current) return;
      setDirectoryState("error");
    }
  }

  useEffect(() => {
    mounted.current = true;
    const expireSession = () => {
      identityRequest.current += 1;
      directoryRequest.current += 1;
      setUser(undefined);
      setStatus("login");
    };
    const refreshDirectory = () => { void loadDirectory(true); };
    const refreshIdentity = () => { void loadIdentity(true); };
    window.addEventListener(SESSION_EXPIRED_EVENT, expireSession);
    window.addEventListener(DIRECTORY_CHANGED_EVENT, refreshDirectory);
    window.addEventListener(IDENTITY_CHANGED_EVENT, refreshIdentity);
    return () => {
      mounted.current = false;
      window.removeEventListener(SESSION_EXPIRED_EVENT, expireSession);
      window.removeEventListener(DIRECTORY_CHANGED_EVENT, refreshDirectory);
      window.removeEventListener(IDENTITY_CHANGED_EVENT, refreshIdentity);
    };
  }, []);
  useEffect(() => {
    void loadIdentity();
    setCollapsed(window.localStorage.getItem("agentsmith-sidebar-collapsed") === "1");
  }, []);

  useEffect(() => {
    void loadDirectory(hasDirectory.current);
  }, [workspaceId, routedProjectId]);

  useEffect(() => {
    const target = contentStart.current;
    if (!target) return;
    if (lastPathname.current && lastPathname.current !== pathname) target.focus();
    lastPathname.current = pathname;
  }, [pathname, status, directoryState]);

  function setNavigationCollapsed(next: boolean) {
    setCollapsed(() => {
      window.localStorage.setItem("agentsmith-sidebar-collapsed", next ? "1" : "0");
      return next;
    });
  }

  if (status === "loading") return <ShellLoadingFrame />;
  if (status === "login") {
    const returnTo = typeof window === "undefined" ? pathname : `${window.location.pathname}${window.location.search}${window.location.hash}`;
    return <ShellStatePage title="Sign in to continue" detail="Use your configured identity provider to access projects." action={<Button label="Sign in" variant="primary" onClick={() => window.location.assign(oidcStartUrlForReturnTo(returnTo))} />} />;
  }
  if (status === "error") return <ShellStatePage title="Workspace unavailable" detail="The product API could not load your session." action={<Button label="Try again" variant="secondary" onClick={() => void loadIdentity()} />} />;
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
  const profileReturnTo = typeof window === "undefined" ? pathname : `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return <AstryxAppShell
    variant="section"
    height="auto"
    topNav={<Topbar user={user!} workspaces={workspaces} workspace={workspace} project={project} profileReturnTo={profileReturnTo} onOpenNavigation={() => setMobileNavigationOpen(true)} />}
    sideNav={<ShellNavigation workspace={workspace} project={project} pathname={pathname} collapsed={collapsed} onCollapsedChange={setNavigationCollapsed} />}
    mobileNav={<MobileNav isOpen={mobileNavigationOpen} onOpenChange={setMobileNavigationOpen} side="start" header="Navigation"><ShellNavigation workspace={workspace} project={project} pathname={pathname} onNavigate={() => setMobileNavigationOpen(false)} /></MobileNav>}
  ><main ref={contentStart} tabIndex={-1} className="min-h-full outline-none">{directoryState === "error" ? <DirectoryNotice onRetry={() => loadDirectory(true)} /> : null}{contextError ?? children}</main></AstryxAppShell>;
}

function ShellLoadingFrame() {
  return <><DocumentTitle title="Loading" /><div className="min-h-screen bg-background"><header className="sticky top-0 flex h-[3.25rem] items-center border-b border-border bg-surface px-4 md:px-5"><span className="font-display text-lg text-foreground">AgentSmith</span></header><div className="flex min-h-[calc(100vh-3.25rem)]"><aside className="hidden w-[var(--sidebar-width)] border-r border-border bg-panel md:block" aria-hidden="true" /><main className="grid min-w-0 flex-1 place-items-center"><h1 className="sr-only">Loading AgentSmith</h1><Spinner label="Loading workspace..." /></main></div></div></>;
}

function ShellStatePage({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <><DocumentTitle title={title} /><main className="grid min-h-screen place-items-center bg-background px-6"><section className="max-w-md text-center"><p className="type-caption text-tertiary">AgentSmith</p><h1 className="type-section-heading mt-3">{title}</h1>{detail ? <p className="type-body-ui mt-3 text-secondary">{detail}</p> : null}{action ? <p className="mt-6">{action}</p> : null}</section></main></>;
}

function DirectoryNotice({ onRetry }: { onRetry: () => Promise<void> }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface-low px-4 py-2 text-sm text-secondary" role="status"><span>Workspace navigation is unavailable. This page may still be used.</span><Button label="Retry navigation" size="sm" variant="ghost" onClick={() => void onRetry()} /></div>;
}

function ShellRecoveryState({ title, detail, projectsHref, projectHref, retry }: { title: string; detail: string; projectsHref?: string; projectHref?: string; retry: () => Promise<void> }) {
  return <><DocumentTitle title={title} /><section className="grid min-h-[calc(100vh-3.25rem)] place-items-center px-6"><div className="max-w-lg text-center"><h1 className="type-section-heading">{title}</h1><p className="mt-3 text-sm text-secondary">{detail}</p><div className="mt-6 flex flex-wrap justify-center gap-2">{projectHref ? <Button label="Open project" variant="primary" href={projectHref} /> : null}{projectsHref ? <Button label="View all projects" variant="secondary" href={projectsHref} /> : null}<Button label="Back to workspaces" variant="secondary" href="/" /><Button label="Check access again" variant="ghost" onClick={() => void retry()} /></div></div></section></>;
}
