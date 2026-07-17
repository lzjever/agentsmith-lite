"use client";

import { useRouter } from "next/navigation";
import { Archive, RefreshCw, Save, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, notifyDirectoryChanged, type CurrentUser, type WorkspaceMember, type WorkspaceSettings } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
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
  return <WorkspaceSettings key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceSettings({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const mutationKeys = useMutationKeys();
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const memberRequest = useRef(0);
  const [data, setData] = useState<WorkspaceSettings>();
  const [user, setUser] = useState<CurrentUser>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteName, setDeleteName] = useState("");
  const [members,setMembers]=useState<WorkspaceMember[]>([]); const [memberState,setMemberState]=useState<"loading"|"ready"|"error">("loading"); const [ownerTarget,setOwnerTarget]=useState(""); const [ownerOpen,setOwnerOpen]=useState(false); const [ownerBusy,setOwnerBusy]=useState(false); const [lifecycleBusy,setLifecycleBusy]=useState(false);
  const loadMembers = useCallback(async () => {
    const request = ++memberRequest.current;
    setMemberState("loading");
    try {
      const listed = await apiClient.workspaceMembers(workspaceId);
      if (!mounted.current || request !== memberRequest.current) return;
      setMembers(listed);
      setMemberState("ready");
    } catch {
      if (!mounted.current || request !== memberRequest.current) return;
      setMemberState("error");
    }
  }, [workspaceId]);
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setState("loading");
    setLoadError("");
    try {
      const [settings, identity] = await Promise.all([apiClient.workspaceSettings(workspaceId), apiClient.currentIdentity()]);
      if (!mounted.current || request !== loadRequest.current) return;
      setData(settings);
      setWorkspaceName(settings.workspace.name);
      setUser(identity.user);
      setState("ready");
      if(settings.workspace.ownerUserId===identity.user.id)await loadMembers();else{setMembers([]);setMemberState("ready");}
    } catch (reason) {
      if (!mounted.current || request !== loadRequest.current) return;
      setLoadError(settingsErrorMessage(reason, "Workspace settings could not be loaded."));
      setState("error");
    }
  }, [loadMembers,workspaceId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settingsDirty || mutationBusy) return;
    setSaving(true);
    try {
      const requestIdentity = workspaceName.trim();
      const saved = await apiClient.updateWorkspaceSettings(workspaceId, { name: workspaceName }, mutationKeys.key("workspace-settings", requestIdentity));
      mutationKeys.complete("workspace-settings", requestIdentity);
      if (!mounted.current) return;
      setData(saved);
      setWorkspaceName(saved.workspace.name);
      notifyDirectoryChanged();
      toast.success("Workspace settings saved.");
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("workspace-settings", workspaceName.trim());
      if (!mounted.current) return;
      toast.error(settingsErrorMessage(reason, "Workspace settings could not be saved."));
      if (isReadOnlyMutationError(reason)) await load();
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const lifecycleStatus=data?.workspace.lifecycleStatus??"active";
  const archived=lifecycleStatus === "archived";
  const isActive=lifecycleStatus === "active";
  const isOwner=data?.workspace.ownerUserId === user?.id;
  const canDelete=isOwner;
  const canArchive=data?.capabilities.canManageSettings===true&&isActive;
  const canRestore=isOwner&&archived;
  const mutationBusy=saving||lifecycleBusy||ownerBusy||deleting;
  const settingsDirty = data !== undefined && workspaceName.trim() !== data.workspace.name;
  const ownerCandidates = members.filter((member) => member.userId !== user?.id);
  const ownerTargetEligible = !ownerTarget || ownerCandidates.some((member) => member.userId === ownerTarget);
  useEffect(() => {
    if (memberState !== "ready" || !ownerTarget || ownerTargetEligible) return;
    setOwnerOpen(false);
    setOwnerTarget("");
    mutationKeys.clear("workspace-owner-transfer");
  }, [memberState, ownerTarget, ownerTargetEligible]);
  async function setArchive(){if(!data||mutationBusy)return;const operation=archived?"workspace-unarchive":"workspace-archive";setLifecycleBusy(true);try{if(archived)await apiClient.unarchiveWorkspace(workspaceId,mutationKeys.key(operation,workspaceId));else await apiClient.archiveWorkspace(workspaceId,mutationKeys.key(operation,workspaceId));mutationKeys.complete(operation,workspaceId);if(!mounted.current)return;notifyDirectoryChanged();await load();if(mounted.current)toast.success(archived?"Workspace restored.":"Workspace archived.");}catch(reason){if(reason instanceof ApiError)mutationKeys.complete(operation,workspaceId);if(!mounted.current)return;toast.error(settingsErrorMessage(reason,"Workspace lifecycle could not be updated."));if(isReadOnlyMutationError(reason))await load();}finally{if(mounted.current)setLifecycleBusy(false)}}
  async function transferOwner(){
    if(!data||mutationBusy)return;
    setOwnerBusy(true);
    try {
      await apiClient.transferWorkspaceOwner(workspaceId,ownerTarget,mutationKeys.key("workspace-owner-transfer",ownerTarget));
      mutationKeys.complete("workspace-owner-transfer",ownerTarget);
      if(!mounted.current)return;
      setData({...data,workspace:{...data.workspace,ownerUserId:ownerTarget}});
      notifyDirectoryChanged();
      setOwnerOpen(false);
      setOwnerTarget("");
      toast.success("Workspace ownership transferred.");
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("workspace-owner-transfer",ownerTarget);
      if (mounted.current) await load();
      throw reason;
    } finally { if(mounted.current)setOwnerBusy(false); }
  }
  async function deleteWorkspace() {
    if (mutationBusy) return;
    setDeleting(true);
    try {
      await apiClient.deleteWorkspace(workspaceId,mutationKeys.key("workspace-delete",workspaceId));
      mutationKeys.complete("workspace-delete",workspaceId);
      if (!mounted.current) return;
      toast.success("Workspace deleted.");
      router.push("/");
    } catch (error) {
      if (error instanceof ApiError) mutationKeys.complete("workspace-delete",workspaceId);
      if (!mounted.current) return;
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        setDialogOpen(false);
        if (error.status === 403) toast.error(deletionMessage(error));
        notifyDirectoryChanged();
        router.push("/");
        return;
      }
      throw new Error(deletionMessage(error));
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }

  function setDialogOpen(open: boolean) {
    setDeleteOpen(open);
    if (!open) {
      setDeleteName("");
      mutationKeys.clear("workspace-delete");
    }
  }

  return <PageLayout contentWidth="narrow" header={<PageHeader title="Workspace settings" subtitle="Workspace metadata and project administration." />}>
    {state === "loading" ? <PageState state="loading">Loading workspace settings...</PageState> : null}
    {state === "error" ? <SettingsLoadError message={loadError} onRetry={() => void load()} backHref={`/workspaces/${workspaceId}`} backLabel="Back to workspace" /> : null}
    {state === "ready" && data ? <>
      <p role="status" className="border-y border-subtle bg-surface-low px-4 py-3 text-sm text-secondary">{lifecycleMessage("workspace",lifecycleStatus)}</p>
      <form onSubmit={submit} className="space-y-5 border-y border-subtle py-5"><label className="grid gap-2 text-sm"><span>Workspace name</span><Input name="name" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} disabled={mutationBusy||!data.capabilities.canManageSettings||!isActive} /></label><p className="text-sm text-secondary">Project access is managed from each project.</p>{data.capabilities.canManageSettings&&isActive ? <div className="flex justify-end"><Button type="submit" disabled={mutationBusy || !settingsDirty}><Save size={16} />{saving ? "Saving..." : "Save workspace"}</Button></div> : <p className="text-sm text-secondary">Read-only access.</p>}</form>
      {canArchive||canRestore?<section className="mt-8 border-t border-subtle pt-6"><h2 className="type-title">Lifecycle</h2><p className="mt-1 text-sm text-secondary">Archived workspaces remain available for viewing. Only the workspace owner can restore one.</p><Button className="mt-4" variant="outline" disabled={mutationBusy} onClick={()=>archived?void setArchive():setArchiveOpen(true)}><Archive size={16}/>{archived?"Unarchive workspace":"Archive workspace"}</Button></section>:null}
      {canArchive?<ConfirmationDialog open={archiveOpen} onOpenChange={(open)=>{setArchiveOpen(open);if(!open)mutationKeys.clear("workspace-archive");}} title="Archive workspace" description="Projects and workspace data remain available for viewing, but changes are disabled until the owner restores this workspace." confirmText="Archive workspace" confirmDisabled={mutationBusy} onConfirm={setArchive}/>:null}
      {isOwner?<section className="mt-8 border-t border-subtle pt-6"><h2 className="type-title">Transfer ownership</h2><p className="mt-1 text-sm text-secondary">The new owner must already be a workspace member.</p>{memberState==="loading"?<p className="mt-4 text-sm text-secondary" role="status">Loading eligible workspace members...</p>:null}{memberState==="error"?<div className="mt-4 flex items-center justify-between gap-3 border border-error/30 bg-error/10 px-3 py-2" role="alert"><span className="text-sm text-error">Workspace members could not be loaded.</span><Button variant="quiet" size="sm" aria-label="Retry member loading" disabled={mutationBusy} onClick={()=>void loadMembers()}><RefreshCw size={14}/>Retry</Button></div>:null}{memberState==="ready"&&ownerCandidates.length===0?<p className="mt-4 text-sm text-secondary" role="status">There are no other workspace members eligible to become owner.</p>:null}{memberState==="ready"&&ownerCandidates.length>0?<div className="mt-4 flex flex-wrap items-end gap-2"><div className="grid w-64 gap-2"><Label htmlFor="workspace-owner-target">New workspace owner</Label><Select value={ownerTargetEligible?ownerTarget:""} onValueChange={setOwnerTarget} disabled={!isActive||mutationBusy}><SelectTrigger id="workspace-owner-target"><SelectValue placeholder="Select a member" /></SelectTrigger><SelectContent>{ownerCandidates.map(member=><SelectItem key={member.userId} value={member.userId}>{memberLabel(member)}</SelectItem>)}</SelectContent></Select></div><Button variant="outline" disabled={!ownerTarget||!ownerTargetEligible||!isActive||mutationBusy} onClick={()=>setOwnerOpen(true)}>Transfer ownership</Button></div>:null}</section>:null}
      {isOwner?<ConfirmationDialog open={ownerOpen&&ownerTargetEligible} onOpenChange={(open)=>{setOwnerOpen(open);if(!open)mutationKeys.clear("workspace-owner-transfer");}} title="Transfer workspace ownership" description="The current owner becomes an administrator." confirmText="Transfer ownership" variant="default" confirmDisabled={!ownerTarget||!ownerTargetEligible||mutationBusy} onConfirm={transferOwner}/>:null}
      {canDelete ? <section className="mt-8 border-t border-danger/40 pt-6" aria-label="Danger zone"><h2 className="type-title">{lifecycleStatus==="deleting"?"Continue workspace deletion":"Delete workspace"}</h2><p className="mt-1 text-sm text-secondary">{lifecycleStatus==="deleting"?"Previous cleanup did not finish. Continue deleting the remaining workspace-owned data.":"This permanently removes this workspace and all of its projects."}</p><Button className="mt-4" variant="destructive-primary" aria-label={lifecycleStatus==="deleting"?"Continue workspace deletion":"Open workspace deletion confirmation"} disabled={mutationBusy} onClick={() => setDialogOpen(true)}><Trash2 size={16} />{lifecycleStatus==="deleting"?"Continue deletion":"Delete workspace"}</Button></section> : null}
      {canDelete ? <ConfirmationDialog open={deleteOpen} onOpenChange={setDialogOpen} title={lifecycleStatus==="deleting"?"Continue workspace deletion":"Delete workspace"} description={<><span>Type <strong className="text-foreground">{data.workspace.name}</strong> to permanently delete this workspace.</span><label className="mt-4 grid gap-2"><span className="text-xs font-medium text-foreground">Workspace name</span><Input aria-label="Workspace name confirmation" value={deleteName} onChange={(event) => setDeleteName(event.target.value)} disabled={mutationBusy} autoComplete="off" /></label></>} confirmText={deleting ? "Deleting" : lifecycleStatus==="deleting"?"Continue deletion":"Delete workspace"} confirmDisabled={mutationBusy || deleteName !== data.workspace.name} onConfirm={deleteWorkspace} errorContext="Workspace could not be deleted" /> : null}
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
