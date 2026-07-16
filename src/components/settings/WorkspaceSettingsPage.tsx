"use client";

import { useRouter } from "next/navigation";
import { Archive, Save, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, apiClient, type CurrentUser, type WorkspaceMember, type WorkspaceSettings } from "../../lib/api/client";
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

export function WorkspaceSettingsPage({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [data, setData] = useState<WorkspaceSettings>();
  const [user, setUser] = useState<CurrentUser>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteName, setDeleteName] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [members,setMembers]=useState<WorkspaceMember[]>([]); const [ownerTarget,setOwnerTarget]=useState(""); const [ownerOpen,setOwnerOpen]=useState(false); const [lifecycleBusy,setLifecycleBusy]=useState(false);
  const load = useCallback(async () => {
    setState("loading");
    setLoadError("");
    try {
      const [settings, identity] = await Promise.all([apiClient.workspaceSettings(workspaceId), apiClient.currentIdentity()]);
      const listed = settings.workspace.ownerUserId === identity.user.id ? await apiClient.workspaceMembers(workspaceId).catch(() => []) : [];
      setData(settings);
      setUser(identity.user);
      setMembers(listed);
      setState("ready");
    } catch (reason) {
      setLoadError(settingsErrorMessage(reason, "Workspace settings could not be loaded."));
      setState("error");
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      setData(await apiClient.updateWorkspaceSettings(workspaceId, { name: String(new FormData(event.currentTarget).get("name") || "") }));
      toast.success("Workspace settings saved.");
    } catch (reason) {
      toast.error(settingsErrorMessage(reason, "Workspace settings could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  const lifecycleStatus=data?.workspace.lifecycleStatus??"active";
  const archived=lifecycleStatus === "archived";
  const isActive=lifecycleStatus === "active";
  const isOwner=data?.workspace.ownerUserId === user?.id;
  const canDelete=isOwner&&isActive;
  const canArchive=data?.capabilities.canManageSettings===true&&isActive;
  const canRestore=isOwner&&archived;
  const ownerCandidates = members.filter((member) => member.userId !== user?.id);
  async function setArchive(){if(!data)return;setLifecycleBusy(true);try{const workspace=archived?await apiClient.unarchiveWorkspace(workspaceId):await apiClient.archiveWorkspace(workspaceId);setData({...data,workspace});toast.success(archived?"Workspace restored.":"Workspace archived.");}catch(reason){toast.error(settingsErrorMessage(reason,"Workspace lifecycle could not be updated."));}finally{setLifecycleBusy(false)}}
  async function transferOwner(){await apiClient.transferWorkspaceOwner(workspaceId,ownerTarget);toast.success("Workspace ownership transferred.");await load();}
  async function deleteWorkspace() {
    setDeleteError(null);
    setDeleting(true);
    try {
      await apiClient.deleteWorkspace(workspaceId);
      toast.success("Workspace deleted.");
      router.push("/");
    } catch (error) {
      setDeleteError(deletionMessage(error));
      throw error;
    } finally {
      setDeleting(false);
    }
  }

  function setDialogOpen(open: boolean) {
    setDeleteOpen(open);
    if (!open) {
      setDeleteName("");
      setDeleteError(null);
    }
  }

  return <PageLayout contentWidth="narrow" header={<PageHeader title="Workspace settings" subtitle="Workspace metadata and project administration." />}>
    {state === "loading" ? <PageState state="loading">Loading workspace settings...</PageState> : null}
    {state === "error" ? <SettingsLoadError message={loadError} onRetry={() => void load()} backHref={`/workspaces/${workspaceId}`} backLabel="Back to workspace" /> : null}
    {state === "ready" && data ? <>
      <p role="status" className="border-y border-subtle bg-surface-low px-4 py-3 text-sm text-secondary">{lifecycleMessage("workspace",lifecycleStatus)}</p>
      <form onSubmit={submit} className="space-y-5 border-y border-subtle py-5"><label className="grid gap-2 text-sm"><span>Workspace name</span><Input name="name" defaultValue={data.workspace.name} disabled={!data.capabilities.canManageSettings||!isActive} /></label><p className="text-sm text-secondary">Project access is managed from each project.</p>{data.capabilities.canManageSettings&&isActive ? <div className="flex justify-end"><Button type="submit" disabled={saving}><Save size={16} />{saving ? "Saving..." : "Save workspace"}</Button></div> : <p className="text-sm text-secondary">Read-only access.</p>}</form>
      {canArchive||canRestore?<section className="mt-8 border-t border-subtle pt-6"><h2 className="type-title">Lifecycle</h2><p className="mt-1 text-sm text-secondary">Archived workspaces remain available for viewing. Only the workspace owner can restore one.</p><Button className="mt-4" variant="outline" disabled={lifecycleBusy} onClick={()=>archived?void setArchive():setArchiveOpen(true)}><Archive size={16}/>{archived?"Unarchive workspace":"Archive workspace"}</Button></section>:null}
      {canArchive?<ConfirmationDialog open={archiveOpen} onOpenChange={setArchiveOpen} title="Archive workspace" description="Projects and workspace data remain available for viewing, but changes are disabled until the owner restores this workspace." confirmText="Archive workspace" onConfirm={setArchive}/>:null}
      {isOwner?<section className="mt-8 border-t border-subtle pt-6"><h2 className="type-title">Transfer ownership</h2><p className="mt-1 text-sm text-secondary">The new owner must already be a workspace member.</p>{ownerCandidates.length === 0 ? <p className="mt-4 text-sm text-secondary" role="status">There are no other workspace members eligible to become owner.</p> : <div className="mt-4 flex flex-wrap items-end gap-2"><div className="grid w-64 gap-2"><Label htmlFor="workspace-owner-target">New workspace owner</Label><Select value={ownerTarget} onValueChange={setOwnerTarget} disabled={!isActive}><SelectTrigger id="workspace-owner-target"><SelectValue placeholder="Select a member" /></SelectTrigger><SelectContent>{ownerCandidates.map(member=><SelectItem key={member.userId} value={member.userId}>{memberLabel(member)}</SelectItem>)}</SelectContent></Select></div><Button variant="outline" disabled={!ownerTarget||!isActive} onClick={()=>setOwnerOpen(true)}>Transfer ownership</Button></div>}</section>:null}
      {isOwner?<ConfirmationDialog open={ownerOpen} onOpenChange={setOwnerOpen} title="Transfer workspace ownership" description="The current owner becomes an administrator." confirmText="Transfer ownership" variant="default" confirmDisabled={!ownerTarget} onConfirm={transferOwner}/>:null}
      {canDelete ? <section className="mt-8 border-t border-danger/40 pt-6" aria-label="Danger zone"><h2 className="type-title">Delete workspace</h2><p className="mt-1 text-sm text-secondary">This permanently removes this workspace and all of its projects.</p><Button className="mt-4" variant="destructive-primary" aria-label="Open workspace deletion confirmation" onClick={() => setDialogOpen(true)}><Trash2 size={16} />Delete workspace</Button></section> : null}
      {canDelete ? <ConfirmationDialog open={deleteOpen} onOpenChange={setDialogOpen} title="Delete workspace" description={<><span>Type <strong className="text-foreground">{data.workspace.name}</strong> to permanently delete this workspace.</span><label className="mt-4 grid gap-2"><span className="text-xs font-medium text-foreground">Workspace name</span><Input aria-label="Workspace name confirmation" value={deleteName} onChange={(event) => setDeleteName(event.target.value)} autoComplete="off" />{deleteError ? <span role="alert" className="text-danger">{deleteError} Try again when cleanup is available.</span> : null}</label></>} confirmText={deleting ? "Deleting" : "Delete workspace"} confirmDisabled={deleting || deleteName !== data.workspace.name} onConfirm={deleteWorkspace} errorContext="Workspace could not be deleted" /> : null}
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

function memberLabel(member: WorkspaceMember): string { return member.displayName || member.email || member.userId; }
function lifecycleMessage(kind:"project"|"workspace",status:"active"|"archived"|"deleting"){return status==="active"?`${kind[0]!.toUpperCase()+kind.slice(1)} status: Active.`:status==="archived"?`This ${kind} is archived and read-only.`:`This ${kind} is being deleted. Changes are unavailable.`;}
