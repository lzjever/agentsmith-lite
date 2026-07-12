"use client";

import { FolderKanban, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError, apiClient, type Project, type Workspace, type WorkspaceMemberRole } from "../../lib/api/client";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";
import { ProjectsTable } from "../projects/ProjectsTable";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";
import { ErrorState } from "../ui/error-state";
import { EmptyState, PageLoading } from "../ui/loading";

type LoadState = "loading" | "ready" | "error";

export function WorkspaceProjectsEntryPage({ workspaceId }: { workspaceId: string }) {
  const [workspace, setWorkspace] = useState<Workspace>();
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [pinnedProjectIds, setPinnedProjectIds] = useState<Set<string>>(new Set());

  async function load() {
    setState("loading");
    setError("");
    try {
      const found = (await apiClient.workspaces()).find((item) => item.id === workspaceId);
      if (!found) throw new ApiError(404, "Workspace not found.");
      setWorkspace(found);
      setState("ready");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Projects could not be loaded.");
      setState("error");
    }
  }

  useEffect(() => { void load(); }, [workspaceId]);
  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(`agentsmith:projects:pinned:${workspaceId}`) ?? "[]") as unknown;
      setPinnedProjectIds(new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []));
    } catch { setPinnedProjectIds(new Set()); }
  }, [workspaceId]);
  function created(project: Project) {
    setWorkspace((current) => current ? { ...current, projects: [...current.projects, project] } : current);
    setCreateOpen(false);
  }
  function togglePin(projectId: string) { setPinnedProjectIds((current) => { const next = new Set(current); next.has(projectId) ? next.delete(projectId) : next.add(projectId); window.localStorage.setItem(`agentsmith:projects:pinned:${workspaceId}`, JSON.stringify([...next])); return next; }); }

  const canCreateProject = workspace?.capabilities.canCreateProject === true;
  return <PageLayout header={<PageHeader title={workspace?.name ?? "Projects"} subtitle={workspace ? `Owner: ${workspace.owner?.displayName || workspace.owner?.email || "Workspace owner"} · Your access: ${roleLabel(workspace.memberRole)}` : "Projects keep endpoints, members, files, and tasks together."} actions={canCreateProject ? <Button disabled={state !== "ready"} onClick={() => setCreateOpen(true)}><Plus size={16} />New project</Button> : undefined} />}>
    {state === "loading" ? <PageState state="loading"><PageLoading /></PageState> : null}
    {state === "error" ? <WorkspaceProjectsError message={error} onRetry={load} /> : null}
    {state === "ready" && workspace?.projects.length === 0 ? <ProjectsEmpty canCreateProject={canCreateProject} onCreate={() => setCreateOpen(true)} /> : null}
    {state === "ready" && workspace && workspace.projects.length > 0 ? <ProjectsTable workspaceId={workspace.id} projects={workspace.projects} pinnedProjectIds={pinnedProjectIds} onTogglePin={togglePin} /> : null}
    {canCreateProject ? <CreateProjectDialog workspaceId={workspaceId} open={createOpen} onOpenChange={setCreateOpen} onCreated={created} /> : null}
  </PageLayout>;
}

function ProjectsEmpty({ canCreateProject, onCreate }: { canCreateProject: boolean; onCreate: () => void }) {
  return <PageState state="empty"><EmptyState icon={FolderKanban} title="No projects yet" description={canCreateProject ? "Create a project to add an endpoint, invite collaborators, and start work." : "No projects are available in this workspace."} {...(canCreateProject ? { action: { label: "New project", onClick: onCreate } } : {})} /></PageState>;
}

function WorkspaceProjectsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <PageState state="error"><div className="space-y-4"><ErrorState title="Projects unavailable" message={message} onRetry={() => void onRetry()} /><p className="text-center"><Link href="/" className="text-sm text-secondary hover:text-foreground">Back to workspaces</Link></p></div></PageState>;
}

function roleLabel(role: WorkspaceMemberRole | undefined): string { return role ? role[0]!.toUpperCase() + role.slice(1) : "Member"; }
