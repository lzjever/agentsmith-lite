"use client";

import { ArrowLeft, ArrowRight, Bell, ClipboardList, FileKey, FileText, Gauge, LayoutDashboard, MessageSquare, Server, Settings, SlidersHorizontal, Users, Wrench, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiClient, type Project, type ProjectCapabilities, type ProjectMember } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";

type Surface = { href: string; label: string; icon: LucideIcon };

const surfaceGroups: Array<{ label: string; surfaces: Surface[] }> = [
  { label: "Execution", surfaces: [{ href: "chat", label: "Chat", icon: MessageSquare }, { href: "tasks", label: "Tasks", icon: Wrench }, { href: "files", label: "Files", icon: FileText }, { href: "usage", label: "Usage", icon: Gauge }] },
  { label: "Develop", surfaces: [{ href: "context", label: "Context", icon: FileText }, { href: "endpoints", label: "Endpoints", icon: Server }, { href: "credentials", label: "Credentials", icon: FileKey }] },
  { label: "Manage", surfaces: [{ href: "members", label: "Members", icon: Users }, { href: "policy", label: "Resource policy", icon: SlidersHorizontal }, { href: "alerts", label: "Alerts", icon: Bell }, { href: "audit", label: "Audit", icon: ClipboardList }, { href: "settings", label: "Settings", icon: Settings }] }
];

export function ProjectOverviewPage({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const base = `/workspaces/${workspaceId}/projects/${projectId}`;
  const [capabilities, setCapabilities] = useState<ProjectCapabilities>();
  const [project, setProject] = useState<Project>();
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [currentUserId, setCurrentUserId] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setState("loading");
    try {
      const [projectCapabilities, listed, identity] = await Promise.all([apiClient.projectCapabilities(projectId), apiClient.members(projectId), apiClient.currentIdentity()]);
      const settings = await apiClient.projectSettings(projectId).catch(() => undefined);
      setCapabilities(projectCapabilities);
      setProject(settings?.project);
      setMembers(listed);
      setCurrentUserId(identity.user.id);
      setError("");
      setState("ready");
    }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : "Project access could not be loaded."); setState("error"); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const steps = capabilities ? nextSteps(capabilities) : [];
  const [primaryStep, ...secondarySteps] = steps;
  const readOnly = capabilities !== undefined && !Object.values(capabilities).some(Boolean);
  const owner = members.find((member) => member.role === "owner");
  const access = members.find((member) => member.userId === currentUserId)?.role;
  const lifecycleStatus = project?.lifecycleStatus ?? "active";
  const header = <PageHeader title="Project overview" subtitle={owner && access ? `Owner: ${memberLabel(owner)} · Your access: ${roleLabel(access)} · Status: ${lifecycleLabel(lifecycleStatus)}` : readOnly ? `Status: ${lifecycleLabel(lifecycleStatus)} · You can view this project, but you cannot make changes.` : `Status: ${lifecycleLabel(lifecycleStatus)} · Set up the project, then begin work.`} actions={primaryStep ? <Link href={`${base}/${primaryStep.href}`} className="inline-flex min-h-9 items-center justify-center rounded-sm bg-accent px-3 text-sm text-white no-underline hover:bg-accent/90">Open {primaryStep.label}</Link> : undefined} />;

  return <PageLayout header={header}>
    {state === "loading" ? <PageState><span className="text-secondary">Loading project access...</span></PageState> : null}
    {state === "error" ? <PageState><div className="space-y-3"><h2 className="type-title">Project access unavailable</h2><p className="text-sm text-secondary">{error}</p><Button onClick={() => void load()}>Try again</Button></div></PageState> : null}
    {state === "ready" ? <div className="space-y-6"><Link href={`/workspaces/${workspaceId}`} className="inline-flex items-center gap-2 text-sm text-secondary no-underline hover:text-foreground"><ArrowLeft size={16} />Back to workspace</Link><p role="status" className="border-y border-subtle bg-surface-low px-4 py-3 text-sm text-secondary">{lifecycleMessage(lifecycleStatus)}</p><section className="grid gap-8 border-t border-subtle pt-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(20rem,1fr)]"><div className="space-y-8"><section className="space-y-3"><p className="type-caption text-tertiary">{primaryStep ? "Next step" : readOnly ? "Read-only" : "Project"}</p><h2 className="type-section-heading">{primaryStep ? primaryStep.label : readOnly ? "This project is available for viewing." : "This project is ready for work."}</h2><p className="type-body-ui max-w-2xl text-secondary">{primaryStep ? primaryStep.description : readOnly ? "You can open the project surfaces available to you." : "Choose a project surface to continue."}</p></section>{secondarySteps.length ? <section><p className="type-caption text-tertiary">Then</p><div className="mt-3 divide-y divide-subtle border-y border-subtle">{secondarySteps.map((step, index) => <Link key={step.href} href={`${base}/${step.href}`} className="group flex items-start justify-between gap-4 py-4 text-foreground no-underline"><span><span className="type-caption text-tertiary">Step {index + 2}</span><strong className="mt-1 block font-medium">{step.label}</strong><span className="mt-1 block text-sm text-secondary">{step.description}</span></span><ArrowRight size={16} className="mt-2 shrink-0 text-icon-default group-hover:translate-x-0.5" /></Link>)}</div></section> : null}</div><aside className="space-y-5 border-t border-subtle pt-5 xl:border-l xl:border-t-0 xl:pl-8 xl:pt-0">{surfaceGroups.map((group) => <section key={group.label}><h3 className="type-caption text-tertiary">{group.label}</h3><ul className="mt-2 divide-y divide-subtle">{group.surfaces.map((surface) => <li key={surface.href}><Link href={`${base}/${surface.href}`} className="flex items-center gap-3 py-3 text-sm text-secondary no-underline hover:text-foreground"><surface.icon size={16} className="text-icon-default" />{surface.label}</Link></li>)}</ul></section>)}</aside></section></div> : null}
  </PageLayout>;
}

function nextSteps(capabilities: ProjectCapabilities): Array<Surface & { description: string }> {
  return [
    ...(capabilities.canManageEndpoints ? [{ href: "endpoints", label: "Configure an endpoint", description: "Add the model connection this project will use.", icon: Server }] : []),
    ...(capabilities.canManageMembers ? [{ href: "members", label: "Add collaborators", description: "Give existing users access to this project.", icon: Users }] : []),
    ...(capabilities.canCreateTasks ? [{ href: "tasks", label: "Create a task", description: "Run a Botified task once an endpoint is ready.", icon: Wrench }] : [])
  ];
}

function memberLabel(member: ProjectMember): string { return member.displayName || member.email || "Project owner"; }
function roleLabel(role: ProjectMember["role"]): string { return role[0]!.toUpperCase() + role.slice(1); }
function lifecycleLabel(status: Project["lifecycleStatus"]): string { const value=status??"active"; return value[0]!.toUpperCase()+value.slice(1); }
function lifecycleMessage(status: Project["lifecycleStatus"]): string { return status==="archived"?"This project is archived and read-only.":status==="deleting"?"This project is being deleted. Changes are unavailable.":"Project status: Active."; }
