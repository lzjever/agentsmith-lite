"use client";

import { ArrowRight, FolderKanban, NotebookTabs, Settings, Users } from "lucide-react";
import Link from "next/link";
import { Banner, Button, EmptyState, Heading, Spinner, Text } from "@astryxdesign/core";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, type Project, type Workspace, type WorkspaceDetail } from "../../lib/api/client";
import { formatLocalDate as formatDate } from "../../lib/format/date";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";
import { ProjectsTable } from "../projects/ProjectsTable";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";

export function WorkspaceOverviewPage({ workspaceId }: { workspaceId: string }) {
  return <WorkspaceOverviewScope key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceOverviewScope({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const active = useRef(true);
  const [detail, setDetail] = useState<WorkspaceDetail>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState("");
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const load = useCallback(async () => { setState("loading"); setDetail(undefined); try { const [workspace,projectPage]=await Promise.all([apiClient.workspace(workspaceId),apiClient.workspaceProjects(workspaceId,{limit:20})]); if (!active.current) return; setDetail(workspace);setProjects(projectPage.items);setError(""); setState("ready"); } catch (reason) { if (!active.current) return; setError(reason instanceof ApiError ? reason.message : "Workspace could not be loaded."); setState("error"); } }, [workspaceId]);
  useEffect(() => { void load(); }, [load]);
  function created(project: Project) {
    if (!active.current) return;
    setCreateOpen(false);
    router.push(`/workspaces/${workspaceId}/projects/${project.id}/overview`);
  }
  const workspace=detail?.workspace;
  const canCreate = detail?.capabilities.canCreateProject === true;
  const canManage = detail?.capabilities.canManageMembers === true;
  const canManageSettings = canManage || detail?.memberRole === "owner";
  const base = `/workspaces/${workspaceId}`;
  const owner = detail?.owner;
  return <PageLayout header={<PageHeader title={workspace?.name ?? "Workspace overview"} subtitle={detail ? `Owner: ${memberLabel(owner)} · Your access: ${roleLabel(detail.memberRole)}` : "Projects, shared context, and membership for this workspace."} actions={canCreate ? <Button label="New project" variant="primary" onClick={() => { setCreateError(""); setCreateOpen(true); }} /> : undefined} />}>
    {state === "loading" ? <div className="flex min-h-48 items-center justify-center"><Spinner label="Loading workspace..." /></div> : null}
    {state === "error" ? <Banner status="error" title="Workspace unavailable" description={error} endContent={<Button label="Try again" variant="secondary" onClick={() => void load()} />} /> : null}
    {state === "ready" && createError ? <Banner className="mb-5" status="error" title="Project could not be created" description={createError} /> : null}
    {state === "ready" && workspace && detail ? <div className="space-y-9"><section className="grid gap-6 border-y border-border py-6 lg:grid-cols-[minmax(0,1fr)_18rem]"><div><Text as="p" type="supporting" color="secondary" display="block">Workspace</Text><Heading level={2} className="mt-2">{workspace.name}</Heading><Text as="p" type="supporting" color="secondary" display="block" className="mt-3 max-w-2xl">{canManage ? "You can manage workspace members and create projects." : "Your workspace access is read-only. You can view projects, shared context, members, and settings."}</Text></div><dl className="grid grid-cols-2 gap-x-5 gap-y-4 border-t border-border pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0"><Metadata label="Projects" value={String(detail.projectCount)} /><Metadata label="Status" value={lifecycleLabel(workspace.lifecycleStatus)} /><Metadata label="Created" value={formatDate(workspace.createdAt)} /><div className="col-span-2"><Metadata label="Owner" value={memberLabel(detail.owner)} />{detail.owner.displayName ? <dd className="mt-1"><Text type="supporting" color="secondary">{detail.owner.email}</Text></dd> : null}</div><div className="col-span-2"><Metadata label="Access" value={canManage ? "Manage workspace" : "View workspace"} /></div></dl></section><section><div className="mb-4 flex items-center justify-between gap-4"><div><Text as="p" type="supporting" color="secondary" display="block">Projects</Text><Heading level={3} className="mt-1">Workspace projects</Heading></div><Link href={`${base}/projects`} className="inline-flex items-center gap-1 hover:text-primary"><Text type="supporting" color="secondary">All projects</Text> <ArrowRight size={15}/></Link></div>{projects.length ? <ProjectsTable workspaceId={workspace.id} projects={projects} /> : <EmptyState icon={<FolderKanban />} title="No projects yet" description={canCreate ? "Create a project to add endpoints, files, tasks, and collaborators." : "Projects shared with you appear here."} {...(canCreate ? { actions: <Button label="New project" variant="primary" onClick={() => setCreateOpen(true)} /> } : {})} />}</section><section className="border-t border-border pt-6"><Text as="p" type="supporting" color="secondary" display="block">Workspace tools</Text><div className="mt-3 grid divide-y divide-border border-y border-border md:grid-cols-3 md:divide-x md:divide-y-0"><QuickLink href={`${base}/context`} icon={NotebookTabs} title="Context" detail="Shared and personal workspace context." action="Open context"/><QuickLink href={`${base}/members`} icon={Users} title="Members" detail={canManage ? "Manage workspace access and roles." : "View workspace access and roles."} action={canManage ? "Manage members" : "View members"}/><QuickLink href={`${base}/settings`} icon={Settings} title="Settings" detail={canManageSettings ? "Update workspace metadata and administration." : "View workspace metadata. Changes require owner or admin access."} action={canManageSettings ? "Open settings" : "View settings"}/></div></section></div> : null}
    {canCreate ? <CreateProjectDialog workspaceId={workspaceId} open={createOpen} onOpenChange={setCreateOpen} onCreated={created} onAccessChanged={async (message) => { setCreateError(message); await load(); }} /> : null}
  </PageLayout>;
}

function QuickLink({ href, icon: Icon, title, detail, action }: { href: string; icon: typeof Users; title: string; detail: string; action: string }) { return <Link href={href} className="group px-4 py-5 text-primary no-underline hover:bg-overlay-hover"><Icon className="size-5 text-icon-secondary"/><Heading level={4} className="mt-3">{title}</Heading><Text as="p" type="supporting" color="secondary" display="block" className="mt-1">{detail}</Text><Text as="span" type="supporting" color="secondary" className="mt-3 inline-flex items-center gap-1 group-hover:text-primary">{action}<ArrowRight size={14}/></Text></Link>; }
function Metadata({ label, value }: { label: string; value: string }) { return <div><dt><Text type="supporting" color="secondary">{label}</Text></dt><dd className="mt-1"><Text>{value}</Text></dd></div>; }
function lifecycleLabel(status: Workspace["lifecycleStatus"]): string { const value = status ?? "active"; return value[0]!.toUpperCase() + value.slice(1); }
function memberLabel(member: { displayName: string | null; email: string } | undefined): string { return member?.displayName || member?.email || "Workspace owner"; }
function roleLabel(role: WorkspaceDetail["memberRole"]): string { return role[0]!.toUpperCase() + role.slice(1); }
