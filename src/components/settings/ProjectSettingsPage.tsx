"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, RefreshCw, Save, Trash2, Users } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, notifyDirectoryChanged, type CurrentUser, type ProjectMember, type ProjectSettings } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { SettingsLoadError } from "./SettingsRouteState";
import { Button } from "../ui/button";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { toast } from "../ui/toast";

export function ProjectSettingsPage({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  return <ProjectSettings key={`${workspaceId}:${projectId}`} workspaceId={workspaceId} projectId={projectId} />;
}

function ProjectSettings({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const router = useRouter();
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const memberRequest = useRef(0);
  const [data, setData] = useState<ProjectSettings>();
  const [user, setUser] = useState<CurrentUser>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [projectName, setProjectName] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteName, setDeleteName] = useState("");
  const [members,setMembers]=useState<ProjectMember[]>([]);const [memberState,setMemberState]=useState<"loading"|"ready"|"error">("loading");const [ownerTarget,setOwnerTarget]=useState("");const [ownerOpen,setOwnerOpen]=useState(false);const [lifecycleBusy,setLifecycleBusy]=useState(false);
  const loadMembers = useCallback(async () => {
    const request = ++memberRequest.current;
    setMemberState("loading");
    try {
      const listed = await apiClient.members(projectId);
      if (!mounted.current || request !== memberRequest.current) return;
      setMembers(listed);
      setMemberState("ready");
    } catch {
      if (!mounted.current || request !== memberRequest.current) return;
      setMemberState("error");
    }
  }, [projectId]);
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setState("loading");
    setLoadError("");
    try {
      const [settings, identity] = await Promise.all([apiClient.projectSettings(projectId), apiClient.currentIdentity()]);
      if (!mounted.current || request !== loadRequest.current) return;
      if (settings.project.workspaceId !== workspaceId) throw new ApiError(404, "This project does not belong to this workspace.");
      setData(settings);
      setProjectName(settings.project.name);
      setUser(identity.user);
      setState("ready");
      if (settings.project.ownerUserId === identity.user.id) await loadMembers(); else { setMembers([]); setMemberState("ready"); }
    } catch (reason) {
      if (!mounted.current || request !== loadRequest.current) return;
      setLoadError(settingsErrorMessage(reason, "Project settings could not be loaded."));
      setState("error");
    }
  }, [loadMembers, projectId, workspaceId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const saved = await apiClient.updateProjectSettings(projectId, { name: projectName });
      if (!mounted.current) return;
      setData(saved);
      setProjectName(saved.project.name);
      notifyDirectoryChanged();
      toast.success("Project settings saved.");
    } catch (reason) {
      if (!mounted.current) return;
      toast.error(settingsErrorMessage(reason, "Project settings could not be saved."));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const lifecycleStatus=data?.project.lifecycleStatus??"active";
  const archived=lifecycleStatus==="archived";
  const isActive=lifecycleStatus==="active";
  const isOwner = data?.project.ownerUserId === user?.id;
  const canDelete = isOwner;
  const canArchive=data?.capabilities.canManageSettings===true&&isActive;
  const canRestore=isOwner&&archived;
  const ownerCandidates = members.filter((member) => member.userId !== user?.id);
  async function setArchive(){if(!data)return;setLifecycleBusy(true);try{const project=archived?await apiClient.unarchiveProject(projectId):await apiClient.archiveProject(projectId);if(!mounted.current)return;setData({...data,project});notifyDirectoryChanged();toast.success(archived?"Project restored.":"Project archived.");}catch(reason){if(!mounted.current)return;toast.error(settingsErrorMessage(reason,"Project lifecycle could not be updated."));}finally{if(mounted.current)setLifecycleBusy(false)}}
  async function transferOwner(){
    if(!data)return;
    await apiClient.transferProjectOwner(projectId,ownerTarget);
    if(!mounted.current)return;
    setData({...data,project:{...data.project,ownerUserId:ownerTarget}});
    notifyDirectoryChanged();
    setOwnerOpen(false);
    setOwnerTarget("");
    toast.success("Project ownership transferred.");
  }
  async function deleteProject() {
    setDeleteBusy(true);
    try {
      await apiClient.deleteProject(projectId);
      if (!mounted.current) return;
      toast.success("Project deleted.");
      router.push(`/workspaces/${workspaceId}`);
    } catch (error) {
      if (!mounted.current) return;
      throw new Error(deletionMessage(error));
    } finally {
      if (mounted.current) setDeleteBusy(false);
    }
  }

  function setDialogOpen(open: boolean) {
    setDeleteOpen(open);
    if (!open) {
      setDeleteName("");
    }
  }

  return <PageLayout contentWidth="narrow" header={<PageHeader title="Project settings" subtitle="Project metadata and access administration." actions={<Link className="inline-flex items-center gap-2 text-sm text-secondary hover:text-foreground" href={`/workspaces/${workspaceId}/projects/${projectId}/members`}><Users size={16} />Manage members</Link>} />}>
    {state === "loading" ? <PageState state="loading">Loading project settings...</PageState> : null}
    {state === "error" ? <SettingsLoadError message={loadError} onRetry={() => void load()} backHref={`/workspaces/${workspaceId}/projects/${projectId}/overview`} backLabel="Back to project" /> : null}
    {state === "ready" && data ? <>
      <p role="status" className="border-y border-subtle bg-surface-low px-4 py-3 text-sm text-secondary">{lifecycleMessage("project",lifecycleStatus)}</p>
      <form onSubmit={submit} className="grid gap-5 border-y border-subtle py-5">
        <label className="grid gap-2 text-sm"><span>Project name</span><Input name="name" value={projectName} onChange={(event) => setProjectName(event.target.value)} disabled={saving||!data.capabilities.canManageSettings||!isActive} /></label>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-subtle pt-4"><p className="text-sm text-secondary">Members and resource limits are managed in their dedicated sections.</p>{data.capabilities.canManageSettings&&isActive ? <Button type="submit" disabled={saving}><Save size={16} />{saving ? "Saving..." : "Save project"}</Button> : <span className="text-sm text-secondary">Read-only access.</span>}</div>
      </form>
      {canArchive||canRestore?<section className="mt-8 border-t border-subtle pt-6"><h2 className="type-title">Lifecycle</h2><p className="mt-1 text-sm text-secondary">Archived projects remain available for viewing. Only the project owner can restore one.</p><Button className="mt-4" variant="outline" disabled={lifecycleBusy} onClick={()=>archived?void setArchive():setArchiveOpen(true)}><Archive size={16}/>{archived?"Unarchive project":"Archive project"}</Button></section>:null}
      {canArchive?<ConfirmationDialog open={archiveOpen} onOpenChange={setArchiveOpen} title="Archive project" description="Project data remains available for viewing, but changes and new task runs are disabled until the owner restores this project." confirmText="Archive project" onConfirm={setArchive}/>:null}
      {isOwner?<section className="mt-8 border-t border-subtle pt-6"><h2 className="type-title">Transfer ownership</h2><p className="mt-1 text-sm text-secondary">Choose an existing project member as the new owner.</p>{memberState==="loading"?<p className="mt-4 text-sm text-secondary" role="status">Loading eligible project members...</p>:null}{memberState==="error"?<div className="mt-4 flex items-center justify-between gap-3 border border-error/30 bg-error/10 px-3 py-2" role="alert"><span className="text-sm text-error">Project members could not be loaded.</span><Button variant="quiet" size="sm" aria-label="Retry member loading" onClick={()=>void loadMembers()}><RefreshCw size={14}/>Retry</Button></div>:null}{memberState==="ready"&&ownerCandidates.length === 0 ? <p className="mt-4 text-sm text-secondary" role="status">There are no other project members eligible to become owner.</p> : null}{memberState==="ready"&&ownerCandidates.length>0?<div className="mt-4 flex flex-wrap items-end gap-2"><div className="grid w-64 gap-2"><Label htmlFor="project-owner-target">New project owner</Label><Select value={ownerTarget} onValueChange={setOwnerTarget} disabled={!isActive}><SelectTrigger id="project-owner-target"><SelectValue placeholder="Select a member" /></SelectTrigger><SelectContent>{ownerCandidates.map(member=><SelectItem key={member.userId} value={member.userId}>{memberLabel(member)}</SelectItem>)}</SelectContent></Select></div><Button variant="outline" disabled={!ownerTarget||!isActive} onClick={()=>setOwnerOpen(true)}>Transfer ownership</Button></div>:null}</section>:null}
      {isOwner?<ConfirmationDialog open={ownerOpen} onOpenChange={setOwnerOpen} title="Transfer project ownership" description="The current owner becomes an administrator." confirmText="Transfer ownership" variant="default" confirmDisabled={!ownerTarget} onConfirm={transferOwner}/>:null}
      {canDelete ? <section className="mt-8 border-t border-danger/40 pt-6" aria-label="Danger zone"><h2 className="type-title">{lifecycleStatus==="deleting"?"Continue project deletion":"Delete project"}</h2><p className="mt-1 text-sm text-secondary">{lifecycleStatus==="deleting"?"Previous cleanup did not finish. Continue deleting the remaining project-owned data.":"This permanently removes this project and its project-owned data."}</p><Button className="mt-4" variant="destructive-primary" aria-label={lifecycleStatus==="deleting"?"Continue project deletion":"Open project deletion confirmation"} onClick={() => setDialogOpen(true)}><Trash2 size={16} />{lifecycleStatus==="deleting"?"Continue deletion":"Delete project"}</Button></section> : null}
      {canDelete ? <ConfirmationDialog open={deleteOpen} onOpenChange={setDialogOpen} title={lifecycleStatus==="deleting"?"Continue project deletion":"Delete project"} description={<><span>Type <strong className="text-foreground">{data.project.name}</strong> to permanently delete this project.</span><label className="mt-4 grid gap-2"><span className="text-xs font-medium text-foreground">Project name</span><Input aria-label="Project name confirmation" value={deleteName} onChange={(event) => setDeleteName(event.target.value)} autoComplete="off" /></label></>} confirmText={deleteBusy ? "Deleting" : lifecycleStatus==="deleting"?"Continue deletion":"Delete project"} confirmDisabled={deleteBusy || deleteName !== data.project.name} onConfirm={deleteProject} errorContext="Project could not be deleted" /> : null}
    </> : null}
  </PageLayout>;
}

function deletionMessage(error: unknown): string {
  if (error instanceof ApiError) return error.status === 409 ? `Deletion is pending: ${error.message}` : error.message;
  return error instanceof Error ? error.message : "The deletion could not be completed.";
}

function settingsErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : fallback;
}

function memberLabel(member: ProjectMember): string { return member.displayName || member.email || member.userId; }
function lifecycleMessage(kind:"project"|"workspace",status:"active"|"archived"|"deleting"){return status==="active"?`${kind[0]!.toUpperCase()+kind.slice(1)} status: Active.`:status==="archived"?`This ${kind} is archived and read-only.`:`This ${kind} is being deleted. Changes are unavailable.`;}
