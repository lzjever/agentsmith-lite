"use client";

import { useRouter } from "next/navigation";
import { Archive, RefreshCw, Save, Trash2 } from "lucide-react";
import { Banner, Button, DialogHeader, Heading, Layout, LayoutContent, Selector, Spinner, Text, TextInput, useToast } from "@astryxdesign/core";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, notifyDirectoryChanged, type CurrentUser, type WorkspaceMember, type WorkspaceSettings } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { Dialog, DialogFooter } from "../ui/Dialog";
import { SettingsLoadError } from "./SettingsRouteState";

export function WorkspaceSettingsPage({ workspaceId }: { workspaceId: string }) {
  return <WorkspaceSettings key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceSettings({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const mutationKeys = useMutationKeys();
  const showToast = useToast();
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
  const [archiveError, setArchiveError] = useState("");
  const [deleteName, setDeleteName] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [ownerError, setOwnerError] = useState("");
  const [actionError, setActionError] = useState("");
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
    if (!settingsDirty || !workspaceName.trim() || mutationBusy) return;
    setActionError("");
    setSaving(true);
    const input = { name: workspaceName, expectedName: data!.workspace.name };
    try {
      const saved = await apiClient.updateWorkspaceSettings(workspaceId, input, mutationKeys.requestKey("workspace-settings", workspaceId, input));
      mutationKeys.complete("workspace-settings", workspaceId);
      if (!mounted.current) return;
      setData(saved);
      setWorkspaceName(saved.workspace.name);
      notifyDirectoryChanged();
      showToast({ body: "Workspace settings saved." });
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("workspace-settings", workspaceId);
      if (!mounted.current) return;
      const changed = reason instanceof ApiError && reason.status === 409 && reason.message === "Workspace changed elsewhere. Reload and try again.";
      setActionError(changed ? "Workspace changed elsewhere. Latest settings loaded; review your changes before saving again." : settingsErrorMessage(reason, "Workspace settings could not be saved."));
      if (changed || isReadOnlyMutationError(reason)) await load();
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
  function setArchiveDialogOpen(open: boolean) {
    if (lifecycleBusy && !open) return;
    setArchiveOpen(open);
    if (!open) {
      setArchiveError("");
      mutationKeys.clear("workspace-archive");
    }
  }
  async function setArchive(){
    if(!data||mutationBusy)return;
    const operation=archived?"workspace-unarchive":"workspace-archive";
    setActionError("");
    setArchiveError("");
    setLifecycleBusy(true);
    try{
      if(archived)await apiClient.unarchiveWorkspace(workspaceId,mutationKeys.key(operation,workspaceId));
      else await apiClient.archiveWorkspace(workspaceId,mutationKeys.key(operation,workspaceId));
      mutationKeys.complete(operation,workspaceId);
      if(!mounted.current)return;
      notifyDirectoryChanged();
      setArchiveOpen(false);
      await load();
      if(mounted.current)showToast({ body: archived?"Workspace restored.":"Workspace archived." });
    }catch(reason){
      if(reason instanceof ApiError)mutationKeys.complete(operation,workspaceId);
      if(!mounted.current)return;
      const message=settingsErrorMessage(reason,"Workspace lifecycle could not be updated.");
      if(archived)setActionError(message);
      else setArchiveError(message);
    }finally{
      if(mounted.current)setLifecycleBusy(false);
    }
  }
  async function transferOwner(){
    if(!data||mutationBusy)return;
    setOwnerBusy(true);
    setOwnerError("");
    try {
      await apiClient.transferWorkspaceOwner(workspaceId,ownerTarget,mutationKeys.key("workspace-owner-transfer",ownerTarget));
      mutationKeys.complete("workspace-owner-transfer",ownerTarget);
      if(!mounted.current)return;
      setData({...data,workspace:{...data.workspace,ownerUserId:ownerTarget}});
      notifyDirectoryChanged();
      setOwnerOpen(false);
      setOwnerTarget("");
      setOwnerError("");
      showToast({ body: "Workspace ownership transferred." });
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("workspace-owner-transfer",ownerTarget);
      if (mounted.current) setOwnerError(settingsErrorMessage(reason, "Workspace ownership could not be transferred."));
    } finally { if(mounted.current)setOwnerBusy(false); }
  }
  async function deleteWorkspace() {
    if (mutationBusy) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await apiClient.deleteWorkspace(workspaceId,mutationKeys.key("workspace-delete",workspaceId));
      mutationKeys.complete("workspace-delete",workspaceId);
      if (!mounted.current) return;
      showToast({ body: "Workspace deleted." });
      router.push("/");
    } catch (error) {
      if (error instanceof ApiError) mutationKeys.complete("workspace-delete",workspaceId);
      if (!mounted.current) return;
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        setDialogOpen(false);
        notifyDirectoryChanged();
        router.push("/");
        return;
      }
      setDeleteError(deletionMessage(error));
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }

  function setDialogOpen(open: boolean) {
    setDeleteOpen(open);
    if (!open) {
      setDeleteName("");
      setDeleteError("");
      mutationKeys.clear("workspace-delete");
    }
  }

  return <PageLayout contentWidth="narrow" header={<PageHeader title="Workspace settings" subtitle="Workspace metadata and project administration." />}>
    {state === "loading" ? <div className="flex min-h-48 items-center justify-center"><Spinner label="Loading workspace settings..." /></div> : null}
    {state === "error" ? <SettingsLoadError message={loadError} onRetry={() => void load()} backHref={`/workspaces/${workspaceId}`} backLabel="Back to workspace" /> : null}
    {state === "ready" && actionError ? <Banner className="mb-5" status="error" title="Workspace could not be updated" description={actionError} /> : null}
    {state === "ready" && data ? <>
      <Banner status="info" title="Workspace status" description={lifecycleMessage("workspace",lifecycleStatus)} />
      <form onSubmit={submit} className="mt-5 space-y-5 border-y border-border py-5"><TextInput label="Workspace name" htmlName="name" value={workspaceName} onChange={(value) => setWorkspaceName(value.slice(0, 160))} isRequired isDisabled={mutationBusy||!data.capabilities.canManageSettings||!isActive} width="100%" /><Text as="p" type="supporting" color="secondary" display="block">Project access is managed from each project.</Text>{data.capabilities.canManageSettings&&isActive ? <div className="flex justify-end"><Button type="submit" label={saving ? "Saving..." : "Save workspace"} variant="primary" icon={<Save size={16} />} isDisabled={mutationBusy || !settingsDirty || !workspaceName.trim()} isLoading={saving} /></div> : <Text as="p" type="supporting" color="secondary" display="block">Read-only access.</Text>}</form>
      {canArchive||canRestore?<section className="mt-8 border-t border-border pt-6"><Heading level={3}>Lifecycle</Heading><Text as="p" type="supporting" color="secondary" display="block" className="mt-1">Archived workspaces remain available for viewing. Only the workspace owner can restore one.</Text><Button className="mt-4" label={archived?"Unarchive workspace":"Archive workspace"} variant="secondary" icon={<Archive size={16}/>} isDisabled={mutationBusy} onClick={()=>archived?void setArchive():setArchiveDialogOpen(true)} /></section>:null}
      {canArchive?<Dialog isOpen={archiveOpen} onOpenChange={setArchiveDialogOpen} purpose="form" role="alertdialog" width="min(32rem, calc(100vw - 2rem))" aria-labelledby="workspace-archive-title" aria-describedby="workspace-archive-description"><Layout defaultHasDividers header={<DialogHeader id="workspace-archive-title" title="Archive workspace" />} content={<LayoutContent><form id="workspace-archive-form" onSubmit={(event)=>{event.preventDefault();void setArchive();}}><div className="grid gap-4"><Text id="workspace-archive-description" as="p" display="block" color="secondary">Projects and workspace data remain available for viewing, but changes are disabled until the owner restores this workspace.</Text>{archiveError?<Banner status="error" title="Workspace could not be archived" description={archiveError}/>:null}</div></form></LayoutContent>} footer={<DialogFooter secondaryAction={<Button label="Cancel" type="button" variant="ghost" size="lg" isDisabled={lifecycleBusy} onClick={()=>setArchiveDialogOpen(false)}/>} primaryAction={<Button label={lifecycleBusy?"Archiving":"Archive workspace"} type="submit" form="workspace-archive-form" variant="destructive" size="lg" isDisabled={lifecycleBusy} isLoading={lifecycleBusy}/>} />} /></Dialog>:null}
      {isOwner?<section className="mt-8 border-t border-border pt-6"><Heading level={3}>Transfer ownership</Heading><Text as="p" type="supporting" color="secondary" display="block" className="mt-1">The new owner must already be a workspace member.</Text>{memberState==="loading"?<Text as="p" type="supporting" color="secondary" display="block" className="mt-4" role="status">Loading eligible workspace members...</Text>:null}{memberState==="error"?<Banner className="mt-4" status="error" title="Workspace members unavailable" description="Workspace members could not be loaded." endContent={<Button label="Retry" variant="ghost" size="sm" aria-label="Retry member loading" icon={<RefreshCw size={14}/>} isDisabled={mutationBusy} onClick={()=>void loadMembers()} />}/>:null}{memberState==="ready"&&ownerCandidates.length===0?<Text as="p" type="supporting" color="secondary" display="block" className="mt-4" role="status">There are no other workspace members eligible to become owner.</Text>:null}{memberState==="ready"&&ownerCandidates.length>0?<div className="mt-4 flex flex-wrap items-end gap-2"><Selector id="workspace-owner-target" label="New workspace owner" options={ownerCandidates.map((member) => ({ value: member.userId, label: memberLabel(member) }))} value={ownerTargetEligible?ownerTarget:""} onChange={setOwnerTarget} placeholder="Select a member" isDisabled={!isActive||mutationBusy} size="lg" width={256} /><Button label="Transfer ownership" variant="secondary" isDisabled={!ownerTarget||!ownerTargetEligible||!isActive||mutationBusy} onClick={()=>{setOwnerError("");setOwnerOpen(true);}} /></div>:null}</section>:null}
      {isOwner?<Dialog isOpen={ownerOpen&&ownerTargetEligible} onOpenChange={(open)=>{if(ownerBusy&&!open)return;setOwnerOpen(open);if(!open){setOwnerError("");mutationKeys.clear("workspace-owner-transfer");}}} purpose="form" role="alertdialog" width="min(32rem, calc(100vw - 2rem))" aria-labelledby="workspace-owner-transfer-title" aria-describedby="workspace-owner-transfer-description"><Layout defaultHasDividers header={<DialogHeader id="workspace-owner-transfer-title" title="Transfer workspace ownership" />} content={<LayoutContent><div className="grid gap-4"><Text id="workspace-owner-transfer-description" as="p" display="block" color="secondary">The current owner becomes an administrator.</Text>{ownerError?<Banner status="error" title="Ownership could not be transferred" description={ownerError}/>:null}</div></LayoutContent>} footer={<DialogFooter secondaryAction={<Button label="Cancel" variant="ghost" size="lg" isDisabled={ownerBusy} onClick={()=>setOwnerOpen(false)}/>} primaryAction={<Button label="Transfer ownership" variant="primary" size="lg" isDisabled={!ownerTarget||!ownerTargetEligible||mutationBusy} isLoading={ownerBusy} onClick={()=>void transferOwner()}/>} />} /></Dialog>:null}
      {canDelete ? <section className="mt-8 border-t border-error pt-6" aria-label="Danger zone"><Heading level={3}>{lifecycleStatus==="deleting"?"Continue workspace deletion":"Delete workspace"}</Heading><Text as="p" type="supporting" color="secondary" display="block" className="mt-1">{lifecycleStatus==="deleting"?"Previous cleanup did not finish. Continue deleting the remaining workspace-owned data.":"This permanently removes this workspace and all of its projects."}</Text><Button className="mt-4" label={lifecycleStatus==="deleting"?"Continue deletion":"Delete workspace"} variant="destructive" aria-label={lifecycleStatus==="deleting"?"Continue workspace deletion":"Open workspace deletion confirmation"} icon={<Trash2 size={16} />} isDisabled={mutationBusy} onClick={() => setDialogOpen(true)} /></section> : null}
      {canDelete ? <Dialog isOpen={deleteOpen} onOpenChange={(open)=>{if(deleting&&!open)return;setDialogOpen(open);}} purpose="form" role="alertdialog" width="min(32rem, calc(100vw - 2rem))" aria-labelledby="workspace-delete-title" aria-describedby="workspace-delete-description"><Layout defaultHasDividers header={<DialogHeader id="workspace-delete-title" title={lifecycleStatus==="deleting"?"Continue workspace deletion":"Delete workspace"} />} content={<LayoutContent><form id="workspace-delete-form" className="grid gap-4" onSubmit={(event)=>{event.preventDefault();void deleteWorkspace();}}><Text id="workspace-delete-description" as="p" display="block" color="secondary">This action permanently removes the workspace and its projects. Type <Text weight="semibold">{data.workspace.name}</Text> to continue.</Text><TextInput label="Workspace name" value={deleteName} onChange={setDeleteName} isDisabled={mutationBusy} width="100%" />{deleteError?<Banner status="error" title="Workspace could not be deleted" description={deleteError}/>:null}</form></LayoutContent>} footer={<DialogFooter secondaryAction={<Button label="Cancel" type="button" variant="ghost" size="lg" isDisabled={deleting} onClick={()=>setDialogOpen(false)}/>} primaryAction={<Button label={deleting ? "Deleting" : lifecycleStatus==="deleting"?"Continue deletion":"Delete workspace"} type="submit" form="workspace-delete-form" variant="destructive" size="lg" isDisabled={mutationBusy || deleteName !== data.workspace.name} isLoading={deleting}/>} />} /></Dialog> : null}
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
