"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, Save, Trash2, Users } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, apiClient, type CurrentUser, type ProjectMember, type ProjectSettings } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { toast } from "../ui/toast";

export function ProjectSettingsPage({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const router = useRouter();
  const [data, setData] = useState<ProjectSettings>();
  const [user, setUser] = useState<CurrentUser>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteName, setDeleteName] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [members,setMembers]=useState<ProjectMember[]>([]);const [ownerTarget,setOwnerTarget]=useState("");const [ownerOpen,setOwnerOpen]=useState(false);const [lifecycleBusy,setLifecycleBusy]=useState(false);
  const load = useCallback(async () => {
    setState("loading");
    try {
      const [settings, identity] = await Promise.all([apiClient.projectSettings(projectId), apiClient.currentIdentity()]);
      const listed = settings.project.ownerUserId === identity.user.id ? await apiClient.members(projectId).catch(() => []) : [];
      setData(settings);
      setUser(identity.user);
      setMembers(listed);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    try {
      setData(await apiClient.updateProjectSettings(projectId, { name: String(form.get("name") || ""), taskConcurrencyLimit: Number(form.get("taskConcurrencyLimit")) }));
      toast.success("Project settings saved.");
    } catch {
      toast.error("Project settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const lifecycleStatus=data?.project.lifecycleStatus??"active";
  const archived=lifecycleStatus==="archived";
  const lifecycleDeleting=lifecycleStatus==="deleting";
  const isActive=lifecycleStatus==="active";
  const isOwner = data?.project.ownerUserId === user?.id;
  const canDelete = isOwner&&isActive;
  const canManageLifecycle=isOwner&&!lifecycleDeleting;
  const ownerCandidates = members.filter((member) => member.userId !== user?.id);
  async function setArchive(){if(!data)return;setLifecycleBusy(true);try{const project=archived?await apiClient.unarchiveProject(projectId):await apiClient.archiveProject(projectId);setData({...data,project});toast.success(archived?"Project restored.":"Project archived.");}catch{toast.error("Project lifecycle could not be updated.");}finally{setLifecycleBusy(false)}}
  async function transferOwner(){await apiClient.transferProjectOwner(projectId,ownerTarget);toast.success("Project ownership transferred.");await load();}
  async function deleteProject() {
    setDeleteError(null);
    setDeleteBusy(true);
    try {
      await apiClient.deleteProject(projectId);
      toast.success("Project deleted.");
      router.push(`/workspaces/${workspaceId}`);
    } catch (error) {
      setDeleteError(deletionMessage(error));
      throw error;
    } finally {
      setDeleteBusy(false);
    }
  }

  function setDialogOpen(open: boolean) {
    setDeleteOpen(open);
    if (!open) {
      setDeleteName("");
      setDeleteError(null);
    }
  }

  return <PageLayout contentWidth="narrow" header={<PageHeader title="Project settings" subtitle="Project metadata and access administration." actions={<Link className="inline-flex items-center gap-2 text-sm text-secondary hover:text-foreground" href={`/workspaces/${workspaceId}/projects/${projectId}/members`}><Users size={16} />Manage members</Link>} />}>
    {state === "loading" ? <PageState state="loading">Loading project settings...</PageState> : null}
    {state === "error" ? <PageState state="error"><Button onClick={() => void load()}>Try again</Button></PageState> : null}
    {state === "ready" && data ? <>
      <p role="status" className="border-y border-subtle bg-surface-low px-4 py-3 text-sm text-secondary">{lifecycleMessage("project",lifecycleStatus)}</p>
      <form onSubmit={submit} className="grid gap-5 border-y border-subtle py-5 sm:grid-cols-2">
        <label className="grid gap-2 text-sm"><span>Project name</span><Input name="name" defaultValue={data.project.name} disabled={!data.capabilities.canManageSettings||!isActive} /></label>
        <label className="grid gap-2 text-sm"><span>Task concurrency</span><Input name="taskConcurrencyLimit" type="number" min="1" defaultValue={data.project.taskConcurrencyLimit} disabled={!data.capabilities.canManageSettings||!isActive} /></label>
        <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3 border-t border-subtle pt-4"><p className="text-sm text-secondary">Owners and member roles are managed in Members.</p>{data.capabilities.canManageSettings&&isActive ? <Button type="submit" disabled={saving}><Save size={16} />{saving ? "Saving..." : "Save project"}</Button> : <span className="text-sm text-secondary">Read-only access.</span>}</div>
      </form>
      {canManageLifecycle?<section className="mt-8 border-t border-subtle pt-6"><h2 className="type-title">Lifecycle</h2><p className="mt-1 text-sm text-secondary">Archived projects remain available for viewing.</p><Button className="mt-4" variant="outline" disabled={lifecycleBusy} onClick={()=>void setArchive()}><Archive size={16}/>{archived?"Unarchive project":"Archive project"}</Button></section>:null}
      {isOwner?<section className="mt-8 border-t border-subtle pt-6"><h2 className="type-title">Transfer ownership</h2><p className="mt-1 text-sm text-secondary">Choose an existing project member as the new owner.</p>{ownerCandidates.length === 0 ? <p className="mt-4 text-sm text-secondary" role="status">There are no other project members eligible to become owner.</p> : <div className="mt-4 flex flex-wrap items-end gap-2"><div className="grid w-64 gap-2"><Label htmlFor="project-owner-target">New project owner</Label><Select value={ownerTarget} onValueChange={setOwnerTarget} disabled={!isActive}><SelectTrigger id="project-owner-target"><SelectValue placeholder="Select a member" /></SelectTrigger><SelectContent>{ownerCandidates.map(member=><SelectItem key={member.userId} value={member.userId}>{memberLabel(member)}</SelectItem>)}</SelectContent></Select></div><Button variant="outline" disabled={!ownerTarget||!isActive} onClick={()=>setOwnerOpen(true)}>Transfer ownership</Button></div>}</section>:null}
      {isOwner?<ConfirmationDialog open={ownerOpen} onOpenChange={setOwnerOpen} title="Transfer project ownership" description="The current owner becomes an administrator." confirmText="Transfer ownership" variant="default" confirmDisabled={!ownerTarget} onConfirm={transferOwner}/>:null}
      {canDelete ? <section className="mt-8 border-t border-danger/40 pt-6" aria-label="Danger zone"><h2 className="type-title">Delete project</h2><p className="mt-1 text-sm text-secondary">This permanently removes this project and its project-owned data.</p><Button className="mt-4" variant="destructive-primary" aria-label="Open project deletion confirmation" onClick={() => setDialogOpen(true)}><Trash2 size={16} />Delete project</Button></section> : null}
      {canDelete ? <ConfirmationDialog open={deleteOpen} onOpenChange={setDialogOpen} title="Delete project" description={<><span>Type <strong className="text-foreground">{data.project.name}</strong> to permanently delete this project.</span><label className="mt-4 grid gap-2"><span className="text-xs font-medium text-foreground">Project name</span><Input aria-label="Project name confirmation" value={deleteName} onChange={(event) => setDeleteName(event.target.value)} autoComplete="off" />{deleteError ? <span role="alert" className="text-danger">{deleteError} Try again when cleanup is available.</span> : null}</label></>} confirmText={deleteBusy ? "Deleting" : "Delete project"} confirmDisabled={deleteBusy || deleteName !== data.project.name} onConfirm={deleteProject} errorContext="Project could not be deleted" /> : null}
    </> : null}
  </PageLayout>;
}

function deletionMessage(error: unknown): string {
  if (error instanceof ApiError) return error.status === 409 ? `Deletion is pending: ${error.message}` : error.message;
  return error instanceof Error ? error.message : "The deletion could not be completed.";
}

function memberLabel(member: ProjectMember): string { return member.displayName || member.email || member.userId; }
function lifecycleMessage(kind:"project"|"workspace",status:"active"|"archived"|"deleting"){return status==="active"?`${kind[0]!.toUpperCase()+kind.slice(1)} status: Active.`:status==="archived"?`This ${kind} is archived and read-only.`:`This ${kind} is being deleted. Changes are unavailable.`;}
