"use client";

import { ArrowLeft, ArrowRight, Server, Users, Wrench, type LucideIcon } from "lucide-react";
import { Banner, Button, Heading, Spinner, Text } from "@astryxdesign/core";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, type Project, type ProjectMember, type ProjectOverview, type ProjectOverviewAction } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";

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
    {state === "loading" ? <div className="flex min-h-48 items-center justify-center"><Spinner label="Loading project overview..." /></div> : null}
    {state === "error" ? <Banner status="error" title="Project overview unavailable" description={error} endContent={<Button label="Try again" variant="secondary" onClick={() => void load()} />} /> : null}
    {state === "ready" && overview ? <div className="space-y-7">
      <Link href={`/workspaces/${workspaceId}`} className="inline-flex items-center gap-2 no-underline hover:text-primary"><ArrowLeft size={16} /><Text type="supporting" color="secondary">Back to workspace</Text></Link>
      {lifecycleStatus !== "active" || workspaceLifecycleStatus !== "active" ? <Banner status="warning" title="Project is read-only" description={projectLifecycleMessage(lifecycleStatus, workspaceLifecycleStatus)} /> : null}
      <section className="grid divide-y divide-border border-y border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0" aria-label="Project availability">
        <Availability label="Task endpoints" value={overview.taskReadyEndpointCount} detail={overview.taskReadyEndpointCount === 1 ? "tool-capable connection" : "tool-capable connections"} />
        <Availability label="Task capacity" value={overview.project.taskConcurrencyLimit} detail="concurrent sandboxes" />
      </section>
      <section className="grid gap-10 pt-1 xl:grid-cols-[minmax(0,1.6fr)_minmax(18rem,0.8fr)]">
        <div>
          <Text as="p" type="supporting" color="secondary" display="block">{primaryStep ? "Recommended next" : readOnly ? "Read-only access" : "Ready"}</Text>
          <Heading level={2} className="mt-2 max-w-2xl">{primaryStep ? primaryStep.label : workspaceReadOnly ? workspaceLifecycleStatus === "archived" ? "Workspace archived" : "Workspace deletion in progress" : readOnly ? "Explore this project" : noUsableEndpoint ? "Connect a model to begin" : "Continue your work"}</Heading>
          <Text as="p" color="secondary" display="block" className="mt-2 max-w-2xl">{primaryStep ? primaryStep.description : workspaceReadOnly ? workspaceLifecycleStatus === "archived" ? "Restore the workspace before changing this project or starting new work." : "Workspace deletion must finish before this project is no longer available." : readOnly ? "You can inspect the project areas available to your role." : noUsableEndpoint ? "A project administrator needs to configure a healthy OpenAI-compatible endpoint." : "Create or continue an agent task from the project navigation."}</Text>
          {primaryStep ? <Button className="mt-5" href={`${base}/${primaryStep.href}`} label={primaryStep.label} variant="primary" icon={<primaryStep.icon size={16} />} endContent={<ArrowRight size={15} />} /> : null}
        </div>
        <aside className="border-t border-border pt-5 xl:border-l xl:border-t-0 xl:pl-8 xl:pt-0">
          <Text as="p" type="supporting" color="secondary" display="block">Project access</Text>
          <dl className="mt-3 divide-y divide-border">
            <ProjectDetail label="Role" value={roleLabel(overview.memberRole)} />
            <ProjectDetail label="Owner" value={overview.owner ? memberLabel(overview.owner) : "Unavailable"} />
            <ProjectDetail label="Status" value={lifecycleLabel(lifecycleStatus)} />
          </dl>
        </aside>
      </section>
      {secondarySteps.length ? <section className="border-t border-border pt-6"><Text as="p" type="supporting" color="secondary" display="block">Also available</Text><div className={`mt-3 grid gap-px overflow-hidden rounded-md border border-border bg-border ${secondarySteps.length > 1 ? "sm:grid-cols-2" : "sm:grid-cols-1"}`}>{secondarySteps.map((step) => <Link key={step.href} href={`${base}/${step.href}`} className="group flex min-h-28 items-start justify-between gap-4 bg-surface p-4 text-primary no-underline hover:bg-overlay-hover"><span><step.icon size={17} className="mb-3 text-accent-text" /><Text weight="medium">{step.label}</Text><Text as="span" type="supporting" color="secondary" display="block" className="mt-1">{step.description}</Text></span><ArrowRight size={16} className="mt-1 shrink-0 text-icon-secondary group-hover:translate-x-0.5" /></Link>)}</div></section> : null}
    </div> : null}
  </PageLayout>;
}

function Availability({ label, value, detail }: { label: string; value: number; detail: string }) { return <div className="px-4 py-4 sm:px-5"><Text as="p" type="supporting" color="secondary" display="block">{label}</Text><div className="mt-2 flex items-baseline gap-2"><Text size="2xl" weight="medium" hasTabularNumbers>{value}</Text><Text type="supporting" color="secondary">{detail}</Text></div></div>; }
function ProjectDetail({ label, value }: { label: string; value: string }) { return <div className="flex items-start justify-between gap-4 py-3"><dt><Text color="secondary">{label}</Text></dt><dd className="max-w-[70%]"><Text wordBreak="break-word" justify="end">{value}</Text></dd></div>; }

function memberLabel(member: { displayName: string | null; email: string }): string { return member.displayName || member.email || "Project owner"; }
function roleLabel(role: ProjectMember["role"]): string { return role[0]!.toUpperCase() + role.slice(1); }
function lifecycleLabel(status: Project["lifecycleStatus"]): string { return status ? status[0]!.toUpperCase() + status.slice(1) : "Unknown"; }
function projectLifecycleMessage(status: Project["lifecycleStatus"], workspaceStatus: ProjectOverview["workspaceLifecycleStatus"]): string { return status === "archived" ? "This project is archived and read-only." : status === "deleting" ? "This project is being deleted. Changes are unavailable." : workspaceStatus === "archived" ? "This project is read-only because its workspace is archived." : workspaceStatus === "deleting" ? "This project is read-only because its workspace is being deleted." : status === "active" ? "Project status: Active." : "Project status: Unknown."; }
