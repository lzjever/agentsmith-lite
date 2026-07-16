"use client";

import { ArrowRight, FolderKanban, NotebookTabs, Settings, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiClient, type Project, type Workspace } from "../../lib/api/client";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";
import { ProjectsTable } from "../projects/ProjectsTable";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";
import { ErrorState } from "../ui/error-state";
import { EmptyState, PageLoading } from "../ui/loading";

export function WorkspaceOverviewPage({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<Workspace>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const load = useCallback(async () => { setState("loading"); try { const found = (await apiClient.workspaces()).find((item) => item.id === workspaceId); if (!found) throw new ApiError(404, "Workspace not found."); setWorkspace(found); setError(""); setState("ready"); } catch (reason) { setError(reason instanceof ApiError ? reason.message : "Workspace could not be loaded."); setState("error"); } }, [workspaceId]);
  useEffect(() => { void load(); }, [load]);
  function created(project: Project) {
    setWorkspace((current) => current ? { ...current, projects: [...current.projects, project] } : current);
    setCreateOpen(false);
    router.push(`/workspaces/${workspaceId}/projects/${project.id}/overview`);
  }
  const canCreate = workspace?.capabilities.canCreateProject === true;
  const canManage = workspace?.capabilities.canManageMembers === true;
  const canManageSettings = canManage || workspace?.memberRole === "owner";
  const base = `/workspaces/${workspaceId}`;
  const owner = workspace?.owner;
  return <PageLayout header={<PageHeader title={workspace?.name ?? "Workspace overview"} subtitle={workspace ? `Owner: ${memberLabel(owner)} · Your access: ${roleLabel(workspace.memberRole)}` : "Projects, shared context, and membership for this workspace."} actions={canCreate ? <Button onClick={() => setCreateOpen(true)}>New project</Button> : undefined} />}>
    {state === "loading" ? <PageState><PageLoading /></PageState> : null}
    {state === "error" ? <PageState><ErrorState title="Workspace unavailable" message={error} onRetry={() => void load()} /></PageState> : null}
    {state === "ready" && workspace ? <div className="space-y-9"><section className="grid gap-6 border-y border-subtle py-6 lg:grid-cols-[minmax(0,1fr)_18rem]"><div><p className="type-caption text-tertiary">Workspace</p><h2 className="type-section-heading mt-2">{workspace.name}</h2><p className="mt-3 max-w-2xl text-sm text-secondary">{canManage ? "You can manage workspace members and create projects." : "Your workspace access is read-only. You can view projects, shared context, members, and settings."}</p></div><dl className="grid grid-cols-2 gap-x-5 gap-y-4 border-t border-subtle pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0"><div><dt className="type-caption text-tertiary">Projects</dt><dd className="mt-1 text-lg text-foreground">{workspace.projects.length}</dd></div><div><dt className="type-caption text-tertiary">Status</dt><dd className="mt-1 text-sm text-foreground">{lifecycleLabel(workspace.lifecycleStatus)}</dd></div><div><dt className="type-caption text-tertiary">Created</dt><dd className="mt-1 text-sm text-foreground">{formatDate(workspace.createdAt)}</dd></div><div className="col-span-2"><dt className="type-caption text-tertiary">Owner</dt><dd className="mt-1 text-sm text-foreground">{owner ? memberLabel(owner) : "Workspace owner"}</dd>{owner?.displayName ? <dd className="mt-1 text-xs text-secondary">{owner.email}</dd> : null}</div><div className="col-span-2"><dt className="type-caption text-tertiary">Access</dt><dd className="mt-1 text-sm text-foreground">{canManage ? "Manage workspace" : "View workspace"}</dd></div></dl></section><section><div className="mb-4 flex items-center justify-between gap-4"><div><p className="type-caption text-tertiary">Projects</p><h2 className="type-title mt-1">Workspace projects</h2></div><Link href={`${base}/projects`} className="inline-flex items-center gap-1 text-sm text-secondary hover:text-foreground">All projects <ArrowRight size={15}/></Link></div>{workspace.projects.length ? <ProjectsTable workspaceId={workspace.id} projects={workspace.projects} /> : <EmptyState icon={FolderKanban} title="No projects yet" description={canCreate ? "Create a project to add endpoints, files, tasks, and collaborators." : "Projects shared with you appear here."} {...(canCreate ? { action: { label: "New project", onClick: () => setCreateOpen(true) } } : {})} />}</section><section className="border-t border-subtle pt-6"><p className="type-caption text-tertiary">Workspace tools</p><div className="mt-3 grid divide-y divide-subtle border-y border-subtle md:grid-cols-3 md:divide-x md:divide-y-0"><QuickLink href={`${base}/context`} icon={NotebookTabs} title="Context" detail="Shared and personal workspace context." action="Open context"/><QuickLink href={`${base}/members`} icon={Users} title="Members" detail={canManage ? "Manage workspace access and roles." : "View workspace access and roles."} action={canManage ? "Manage members" : "View members"}/><QuickLink href={`${base}/settings`} icon={Settings} title="Settings" detail={canManageSettings ? "Update workspace metadata and administration." : "View workspace metadata. Changes require owner or admin access."} action={canManageSettings ? "Open settings" : "View settings"}/></div></section></div> : null}
    {canCreate ? <CreateProjectDialog workspaceId={workspaceId} open={createOpen} onOpenChange={setCreateOpen} onCreated={created} /> : null}
  </PageLayout>;
}

function QuickLink({ href, icon: Icon, title, detail, action }: { href: string; icon: typeof Users; title: string; detail: string; action: string }) { return <Link href={href} className="group px-4 py-5 text-foreground no-underline hover:bg-surface-low"><Icon className="size-5 text-icon-default"/><h3 className="mt-3 font-medium">{title}</h3><p className="mt-1 text-sm text-secondary">{detail}</p><span className="mt-3 inline-flex items-center gap-1 text-sm text-secondary group-hover:text-foreground">{action}<ArrowRight size={14}/></span></Link>; }
function formatDate(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)); }
function lifecycleLabel(status: Workspace["lifecycleStatus"]): string { const value = status ?? "active"; return value[0]!.toUpperCase() + value.slice(1); }
function memberLabel(member: { displayName: string | null; email: string } | undefined): string { return member?.displayName || member?.email || "Workspace owner"; }
function roleLabel(role: Workspace["memberRole"]): string { return role ? role[0]!.toUpperCase() + role.slice(1) : "Member"; }
