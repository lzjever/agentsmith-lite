"use client";

import { ArrowLeft, ArrowRight, Bell, ClipboardList, FileKey, FileText, Gauge, MessageSquare, Server, Settings, SlidersHorizontal, Users, Wrench, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, type Project, type ProjectMember, type ProjectOverview, type ProjectOverviewAction } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";

type Surface = { href: string; label: string; icon: LucideIcon };
type NextStep = Surface & { description: string };

const surfaceGroups: Array<{ label: string; surfaces: Surface[] }> = [
  { label: "Execution", surfaces: [{ href: "chat", label: "Chat", icon: MessageSquare }, { href: "tasks", label: "Tasks", icon: Wrench }, { href: "files", label: "Files", icon: FileText }, { href: "usage", label: "Usage", icon: Gauge }] },
  { label: "Develop", surfaces: [{ href: "context", label: "Context", icon: FileText }, { href: "endpoints", label: "Endpoints", icon: Server }, { href: "credentials", label: "Credentials", icon: FileKey }] },
  { label: "Manage", surfaces: [{ href: "members", label: "Members", icon: Users }, { href: "policy", label: "Resource policy", icon: SlidersHorizontal }, { href: "alerts", label: "Alerts", icon: Bell }, { href: "audit", label: "Audit", icon: ClipboardList }, { href: "settings", label: "Settings", icon: Settings }] }
];

const actionSteps: Record<ProjectOverviewAction, NextStep> = {
  configure_endpoint: { href: "endpoints", label: "Configure an endpoint", description: "Add the model connection this project will use.", icon: Server },
  start_chat: { href: "chat", label: "Start a chat", description: "Continue in a conversation with a configured model.", icon: MessageSquare },
  create_task: { href: "tasks", label: "Create a task", description: "Run a Botified task with a tool-capable endpoint.", icon: Wrench },
  add_collaborator: { href: "members", label: "Add collaborators", description: "Give existing users access to this project.", icon: Users }
};

export function ProjectOverviewPage({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  return <ProjectOverviewProjectPage key={`${workspaceId}:${projectId}`} workspaceId={workspaceId} projectId={projectId} />;
}

function ProjectOverviewProjectPage({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const active = useRef(true);
  const base = `/workspaces/${workspaceId}/projects/${projectId}`;
  const [overview, setOverview] = useState<ProjectOverview>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const load = useCallback(async () => {
    setState("loading");
    setOverview(undefined);
    try {
      const projected = await apiClient.projectOverview(projectId);
      if (!active.current) return;
      if (projected.project.id !== projectId || projected.project.workspaceId !== workspaceId) throw new ApiError(404, "This project does not belong to this workspace.");
      setOverview(projected);
      setError("");
      setState("ready");
    } catch (reason) {
      if (!active.current) return;
      setOverview(undefined);
      setError(reason instanceof ApiError ? reason.message : "Project overview could not be loaded.");
      setState("error");
    }
  }, [projectId, workspaceId]);
  useEffect(() => { void load(); }, [load]);

  const steps = overview?.recommendedActions.map((action) => actionSteps[action]) ?? [];
  const [primaryStep, ...secondarySteps] = steps;
  const readOnly = overview !== undefined && !Object.values(overview.capabilities).some(Boolean);
  const noUsableEndpoint = overview !== undefined && !readOnly && overview.chatReadyEndpointCount === 0;
  const lifecycleStatus = overview?.project.lifecycleStatus ?? (overview ? "active" : undefined);
  const workspaceLifecycleStatus = overview?.workspaceLifecycleStatus ?? "active";
  const workspaceReadOnly = lifecycleStatus === "active" && workspaceLifecycleStatus !== "active";
  const headerSubtitle = overview?.owner
    ? `Owner: ${memberLabel(overview.owner)} · Your access: ${roleLabel(overview.memberRole)} · Status: ${lifecycleLabel(lifecycleStatus)}`
    : state === "loading" ? "Loading project status..." : "Project status is unavailable.";
  const header = <PageHeader title={overview?.project.name ?? "Project overview"} subtitle={headerSubtitle} actions={primaryStep ? <Link href={`${base}/${primaryStep.href}`} className="inline-flex min-h-9 items-center justify-center rounded-sm bg-accent px-3 text-sm text-white no-underline hover:bg-accent/90">{primaryStep.label}</Link> : undefined} />;

  return <PageLayout header={header}>
    {state === "loading" ? <PageState><span className="text-secondary">Loading project overview...</span></PageState> : null}
    {state === "error" ? <PageState><div className="space-y-3"><h2 className="type-title">Project overview unavailable</h2><p className="text-sm text-secondary">{error}</p><Button onClick={() => void load()}>Try again</Button></div></PageState> : null}
    {state === "ready" && overview ? <div className="space-y-6">
      <Link href={`/workspaces/${workspaceId}`} className="inline-flex items-center gap-2 text-sm text-secondary no-underline hover:text-foreground"><ArrowLeft size={16} />Back to workspace</Link>
      <p role="status" className="border-y border-subtle bg-surface-low px-4 py-3 text-sm text-secondary">{projectLifecycleMessage(lifecycleStatus, workspaceLifecycleStatus)}</p>
      <section className="grid gap-8 border-t border-subtle pt-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(20rem,1fr)]">
        <div className="space-y-8">
          <section className="space-y-3">
            <p className="type-caption text-tertiary">{primaryStep ? "Next step" : readOnly ? "Read-only" : "Project"}</p>
            <h2 className="type-section-heading">{primaryStep ? primaryStep.label : workspaceReadOnly ? workspaceLifecycleStatus === "archived" ? "Workspace archived" : "Workspace deletion in progress" : readOnly ? "This project is available for viewing." : noUsableEndpoint ? "No usable endpoint is available." : "This project is ready for work."}</h2>
            <p className="type-body-ui max-w-2xl text-secondary">{primaryStep ? primaryStep.description : workspaceReadOnly ? workspaceLifecycleStatus === "archived" ? "Restore the workspace before changing this project or starting new work." : "Workspace deletion must finish before this project is no longer available." : readOnly ? "You can open the project surfaces available to you." : noUsableEndpoint ? "Ask a project administrator to configure a healthy endpoint." : "Choose a project surface to continue."}</p>
          </section>
          {secondarySteps.length ? <section><p className="type-caption text-tertiary">Then</p><div className="mt-3 divide-y divide-subtle border-y border-subtle">{secondarySteps.map((step, index) => <Link key={step.href} href={`${base}/${step.href}`} className="group flex items-start justify-between gap-4 py-4 text-foreground no-underline"><span><span className="type-caption text-tertiary">Step {index + 2}</span><strong className="mt-1 block font-medium">{step.label}</strong><span className="mt-1 block text-sm text-secondary">{step.description}</span></span><ArrowRight size={16} className="mt-2 shrink-0 text-icon-default group-hover:translate-x-0.5" /></Link>)}</div></section> : null}
        </div>
        <aside className="space-y-5 border-t border-subtle pt-5 xl:border-l xl:border-t-0 xl:pl-8 xl:pt-0">{surfaceGroups.map((group) => <section key={group.label}><h3 className="type-caption text-tertiary">{group.label}</h3><ul className="mt-2 divide-y divide-subtle">{group.surfaces.map((surface) => <li key={surface.href}><Link href={`${base}/${surface.href}`} className="flex items-center gap-3 py-3 text-sm text-secondary no-underline hover:text-foreground"><surface.icon size={16} className="text-icon-default" />{surface.label}</Link></li>)}</ul></section>)}</aside>
      </section>
    </div> : null}
  </PageLayout>;
}

function memberLabel(member: { displayName: string | null; email: string }): string { return member.displayName || member.email || "Project owner"; }
function roleLabel(role: ProjectMember["role"]): string { return role[0]!.toUpperCase() + role.slice(1); }
function lifecycleLabel(status: Project["lifecycleStatus"]): string { return status ? status[0]!.toUpperCase() + status.slice(1) : "Unknown"; }
function projectLifecycleMessage(status: Project["lifecycleStatus"], workspaceStatus: ProjectOverview["workspaceLifecycleStatus"]): string { return status === "archived" ? "This project is archived and read-only." : status === "deleting" ? "This project is being deleted. Changes are unavailable." : workspaceStatus === "archived" ? "This project is read-only because its workspace is archived." : workspaceStatus === "deleting" ? "This project is read-only because its workspace is being deleted." : status === "active" ? "Project status: Active." : "Project status: Unknown."; }
