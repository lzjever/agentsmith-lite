"use client";

import { ArrowLeft, ArrowRight, Server, Users, Wrench, type LucideIcon } from "lucide-react";
import { Button } from "@astryxdesign/core";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, type Project, type ProjectMember, type ProjectOverview, type ProjectOverviewAction } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";

type NextStep = { href: string; label: string; icon: LucideIcon; description: string };

const actionSteps: Record<ProjectOverviewAction, NextStep> = {
  configure_endpoint: { href: "endpoints", label: "Configure an endpoint", description: "Add the model connection this project will use.", icon: Server },
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
  const noUsableEndpoint = overview !== undefined && !readOnly && overview.taskReadyEndpointCount === 0;
  const lifecycleStatus = overview?.project.lifecycleStatus ?? (overview ? "active" : undefined);
  const workspaceLifecycleStatus = overview?.workspaceLifecycleStatus ?? "active";
  const workspaceReadOnly = lifecycleStatus === "active" && workspaceLifecycleStatus !== "active";
  const headerSubtitle = overview?.owner
    ? `Owner: ${memberLabel(overview.owner)} · Your access: ${roleLabel(overview.memberRole)} · Status: ${lifecycleLabel(lifecycleStatus)}`
    : state === "loading" ? "Loading project status..." : "Project status is unavailable.";
  const header = <PageHeader title={overview?.project.name ?? "Project overview"} subtitle={headerSubtitle} />;

  return <PageLayout header={header}>
    {state === "loading" ? <PageState><span className="text-secondary">Loading project overview...</span></PageState> : null}
    {state === "error" ? <PageState><div className="space-y-3"><h2 className="type-title">Project overview unavailable</h2><p className="text-sm text-secondary">{error}</p><Button label="Try again" variant="secondary" onClick={() => void load()} /></div></PageState> : null}
    {state === "ready" && overview ? <div className="space-y-7">
      <Link href={`/workspaces/${workspaceId}`} className="inline-flex items-center gap-2 text-sm text-secondary no-underline hover:text-foreground"><ArrowLeft size={16} />Back to workspace</Link>
      {lifecycleStatus !== "active" || workspaceLifecycleStatus !== "active" ? <p role="status" className="border-l-2 border-warning bg-warning-soft px-4 py-3 text-sm text-secondary">{projectLifecycleMessage(lifecycleStatus, workspaceLifecycleStatus)}</p> : null}
      <section className="grid divide-y divide-subtle border-y border-subtle sm:grid-cols-2 sm:divide-x sm:divide-y-0" aria-label="Project availability">
        <Availability label="Task endpoints" value={overview.taskReadyEndpointCount} detail={overview.taskReadyEndpointCount === 1 ? "tool-capable connection" : "tool-capable connections"} />
        <Availability label="Task capacity" value={overview.project.taskConcurrencyLimit} detail="concurrent sandboxes" />
      </section>
      <section className="grid gap-10 pt-1 xl:grid-cols-[minmax(0,1.6fr)_minmax(18rem,0.8fr)]">
        <div>
          <p className="type-caption text-tertiary">{primaryStep ? "Recommended next" : readOnly ? "Read-only access" : "Ready"}</p>
          <h2 className="type-section-heading mt-2 max-w-2xl">{primaryStep ? primaryStep.label : workspaceReadOnly ? workspaceLifecycleStatus === "archived" ? "Workspace archived" : "Workspace deletion in progress" : readOnly ? "Explore this project" : noUsableEndpoint ? "Connect a model to begin" : "Continue your work"}</h2>
          <p className="type-body-ui mt-2 max-w-2xl text-secondary">{primaryStep ? primaryStep.description : workspaceReadOnly ? workspaceLifecycleStatus === "archived" ? "Restore the workspace before changing this project or starting new work." : "Workspace deletion must finish before this project is no longer available." : readOnly ? "You can inspect the project areas available to your role." : noUsableEndpoint ? "A project administrator needs to configure a healthy OpenAI-compatible endpoint." : "Create or continue an agent task from the project navigation."}</p>
          {primaryStep ? <Link href={`${base}/${primaryStep.href}`} className="mt-5 inline-flex min-h-9 items-center gap-2 rounded-sm bg-accent px-3 text-sm text-white no-underline hover:bg-accent/90"><primaryStep.icon size={16} />{primaryStep.label}<ArrowRight size={15} /></Link> : null}
        </div>
        <aside className="border-t border-subtle pt-5 xl:border-l xl:border-t-0 xl:pl-8 xl:pt-0">
          <p className="type-caption text-tertiary">Project access</p>
          <dl className="mt-3 divide-y divide-subtle text-sm">
            <ProjectDetail label="Role" value={roleLabel(overview.memberRole)} />
            <ProjectDetail label="Owner" value={overview.owner ? memberLabel(overview.owner) : "Unavailable"} />
            <ProjectDetail label="Status" value={lifecycleLabel(lifecycleStatus)} />
          </dl>
        </aside>
      </section>
      {secondarySteps.length ? <section className="border-t border-subtle pt-6"><p className="type-caption text-tertiary">Also available</p><div className={`mt-3 grid gap-px overflow-hidden rounded-md border border-subtle bg-subtle ${secondarySteps.length > 1 ? "sm:grid-cols-2" : "sm:grid-cols-1"}`}>{secondarySteps.map((step) => <Link key={step.href} href={`${base}/${step.href}`} className="group flex min-h-28 items-start justify-between gap-4 bg-surface p-4 text-foreground no-underline hover:bg-hover"><span><step.icon size={17} className="mb-3 text-accent" /><strong className="block text-sm font-medium">{step.label}</strong><span className="mt-1 block text-sm text-secondary">{step.description}</span></span><ArrowRight size={16} className="mt-1 shrink-0 text-icon-default transition-transform group-hover:translate-x-0.5" /></Link>)}</div></section> : null}
    </div> : null}
  </PageLayout>;
}

function Availability({ label, value, detail }: { label: string; value: number; detail: string }) { return <div className="px-4 py-4 sm:px-5"><p className="type-caption text-tertiary">{label}</p><p className="mt-2 flex items-baseline gap-2"><strong className="text-2xl font-medium tabular-nums text-foreground">{value}</strong><span className="text-sm text-secondary">{detail}</span></p></div>; }
function ProjectDetail({ label, value }: { label: string; value: string }) { return <div className="flex items-start justify-between gap-4 py-3"><dt className="text-secondary">{label}</dt><dd className="max-w-[70%] break-words text-right text-foreground">{value}</dd></div>; }

function memberLabel(member: { displayName: string | null; email: string }): string { return member.displayName || member.email || "Project owner"; }
function roleLabel(role: ProjectMember["role"]): string { return role[0]!.toUpperCase() + role.slice(1); }
function lifecycleLabel(status: Project["lifecycleStatus"]): string { return status ? status[0]!.toUpperCase() + status.slice(1) : "Unknown"; }
function projectLifecycleMessage(status: Project["lifecycleStatus"], workspaceStatus: ProjectOverview["workspaceLifecycleStatus"]): string { return status === "archived" ? "This project is archived and read-only." : status === "deleting" ? "This project is being deleted. Changes are unavailable." : workspaceStatus === "archived" ? "This project is read-only because its workspace is archived." : workspaceStatus === "deleting" ? "This project is read-only because its workspace is being deleted." : status === "active" ? "Project status: Active." : "Project status: Unknown."; }
