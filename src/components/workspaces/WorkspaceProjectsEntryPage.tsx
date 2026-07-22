"use client";

import { FolderKanban, Plus } from "lucide-react";
import Link from "next/link";
import { Button, EmptyState, Spinner } from "@astryxdesign/core";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiClient, type Project, type Workspace, type WorkspaceMemberRole } from "../../lib/api/client";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";
import { ProjectsTable } from "../projects/ProjectsTable";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { ErrorState } from "../ui/error-state";

type LoadState = "loading" | "ready" | "error";

export function WorkspaceProjectsEntryPage({ workspaceId }: { workspaceId: string }) {
  return <WorkspaceProjectsScope key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceProjectsScope({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const active = useRef(true);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [pinBusyId, setPinBusyId] = useState<string | null>(null);
  const [pinError, setPinError] = useState<{ projectId:string;pinned:boolean;message:string } | null>(null);

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function load() {
    setState("loading");
    setError("");
    setWorkspace(undefined);
    try {
      const found = (await apiClient.workspaces()).find((item) => item.id === workspaceId);
      if (!active.current) return;
      if (!found) throw new ApiError(404, "Workspace not found.");
      setWorkspace(found);
      setState("ready");
    } catch (reason) {
      if (!active.current) return;
      setError(reason instanceof ApiError ? reason.message : "Projects could not be loaded.");
      setState("error");
    }
  }

  useEffect(() => { void load(); }, [workspaceId]);
  function created(project: Project) {
    if (!active.current) return;
    setWorkspace((current) => current ? { ...current, projects: [...current.projects, project] } : current);
    setCreateOpen(false);
    router.push(`/workspaces/${workspaceId}/projects/${project.id}/overview`);
  }
  async function togglePin(projectId:string,desired?:boolean){const project=workspace?.projects.find((item)=>item.id===projectId);if(!project||pinBusyId)return;const pinned=desired??!project.pinnedAt;setPinBusyId(projectId);setPinError(null);try{const saved=await apiClient.setProjectPinned(projectId,pinned);if(!active.current)return;setWorkspace((current)=>current?{...current,projects:current.projects.map((item)=>item.id===projectId?{...item,pinnedAt:saved.pinnedAt??null}:item)}:current)}catch(reason){if(!active.current)return;if(reason instanceof ApiError&&[403,404,409].includes(reason.status)){await load();return}setPinError({projectId,pinned,message:reason instanceof Error?reason.message:"Project pin could not be updated."})}finally{if(active.current)setPinBusyId(null)}}

  const canCreateProject = workspace?.capabilities.canCreateProject === true;
  return <PageLayout header={<PageHeader title="Projects" subtitle={workspace ? `${workspace.name} · Owner: ${workspace.owner?.displayName || workspace.owner?.email || "Workspace owner"} · Your access: ${roleLabel(workspace.memberRole)}` : "Projects keep endpoints, members, files, and tasks together."} actions={canCreateProject ? <Button label="New project" variant="primary" icon={<Plus size={16} />} isDisabled={state !== "ready"} onClick={() => setCreateOpen(true)} /> : undefined} />}>
    {state === "loading" ? <PageState state="loading"><Spinner label="Loading projects..." /></PageState> : null}
    {state === "error" ? <WorkspaceProjectsError message={error} onRetry={load} /> : null}
    {state === "ready" && pinError ? <div className="mb-4 flex items-center justify-between gap-3 border border-error/30 bg-error/10 px-3 py-2" role="alert"><span className="text-sm text-error">{pinError.message}</span><Button label="Retry" variant="ghost" size="sm" onClick={()=>void togglePin(pinError.projectId,pinError.pinned)}/></div> : null}
    {state === "ready" && workspace?.projects.length === 0 ? <ProjectsEmpty canCreateProject={canCreateProject} onCreate={() => setCreateOpen(true)} /> : null}
    {state === "ready" && workspace && workspace.projects.length > 0 ? <ProjectsTable workspaceId={workspace.id} projects={workspace.projects} pinBusyId={pinBusyId} onTogglePin={(projectId)=>void togglePin(projectId)} /> : null}
    {canCreateProject ? <CreateProjectDialog workspaceId={workspaceId} open={createOpen} onOpenChange={setCreateOpen} onCreated={created} onAccessChanged={load} /> : null}
  </PageLayout>;
}

function ProjectsEmpty({ canCreateProject, onCreate }: { canCreateProject: boolean; onCreate: () => void }) {
  return <PageState state="empty"><EmptyState icon={<FolderKanban />} title="No projects yet" description={canCreateProject ? "Create a project to configure an endpoint, add members, and start work." : "No projects are available in this workspace."} {...(canCreateProject ? { actions: <Button label="New project" variant="primary" onClick={onCreate}/> } : {})} /></PageState>;
}

function WorkspaceProjectsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <PageState state="error"><div className="space-y-4"><ErrorState title="Projects unavailable" message={message} onRetry={() => void onRetry()} /><p className="text-center"><Link href="/" className="text-sm text-secondary hover:text-foreground">Back to workspaces</Link></p></div></PageState>;
}

function roleLabel(role: WorkspaceMemberRole | undefined): string { return role ? role[0]!.toUpperCase() + role.slice(1) : "Member"; }
