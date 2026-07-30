"use client";

import { useRouter } from "next/navigation";
import { Archive, Save, Trash2 } from "lucide-react";
import { Banner, Button, Dialog, DialogHeader, Heading, Spinner, Text, TextInput, useToast } from "@astryxdesign/core";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, notifyDirectoryChanged, type CurrentUser, type ProjectMemberCandidate, type WorkspaceSettings } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { MemberDirectoryPicker } from "../members/MemberDirectoryPicker";
import { SettingsLoadError } from "./SettingsRouteState";
import { decodeSettingsDraft, encodeSettingsDraft, resolveSettingsDraftSnapshot, settingsDraftStorageKey, settingsDraftUpdateInput } from "./settings-draft-state";

export function WorkspaceSettingsPage({ workspaceId }: { workspaceId: string }) {
  return <WorkspaceSettings key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceSettings({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const mutationKeys = useMutationKeys();
  const showToast = useToast();
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const loadedRef = useRef(false);
  const baselineNameRef = useRef("");
  const draftNameRef = useRef("");
  const settingsRegionRef = useRef<HTMLDivElement>(null);
  const archiveDescriptionId = useId();
  const ownerDescriptionId = useId();
  const deleteDescriptionId = useId();
  const [data, setData] = useState<WorkspaceSettings>();
  const [user, setUser] = useState<CurrentUser>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [baselineName, setBaselineName] = useState("");
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
  const [ownerTarget,setOwnerTarget]=useState<ProjectMemberCandidate>(); const [ownerOpen,setOwnerOpen]=useState(false); const [ownerBusy,setOwnerBusy]=useState(false); const [lifecycleBusy,setLifecycleBusy]=useState(false);
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    if (!loadedRef.current) setState("loading");
    setLoadError("");
    try {
      const [settings, identity] = await Promise.all([apiClient.workspaceSettings(workspaceId), apiClient.currentIdentity()]);
      if (!mounted.current || request !== loadRequest.current) return;
      const wasLoaded = loadedRef.current;
      const stored = wasLoaded ? null : decodeSettingsDraft(
        sessionStorage.getItem(settingsDraftStorageKey(identity.user.id, "workspace", workspaceId)),
        { actorId: identity.user.id, resourceKind: "workspace", resourceId: workspaceId }
      );
      const knownDraft = wasLoaded
        ? { baselineName: baselineNameRef.current, draftName: draftNameRef.current }
        : stored
          ? { baselineName: stored.baselineName, draftName: stored.name }
          : undefined;
      const resolved = resolveSettingsDraftSnapshot(settings.workspace.name, knownDraft);
      loadedRef.current = true;
      baselineNameRef.current = resolved.baselineName;
      draftNameRef.current = resolved.draftName;
      setData(settings);
      setBaselineName(resolved.baselineName);
      setWorkspaceName(resolved.draftName);
      setUser(identity.user);
      setActionError(resolved.conflicted
        ? wasLoaded
          ? "The workspace name changed while you were editing. Your name was kept; review it against the latest name before saving."
          : "Your saved workspace name overlaps a newer server name. Review it before saving."
        : "");
      setState("ready");
    } catch (reason) {
      if (!mounted.current || request !== loadRequest.current) return;
      const message = settingsErrorMessage(reason, "Workspace settings could not be loaded.");
      setLoadError(message);
      if (loadedRef.current) setActionError(message);
      else setState("error");
    }
  }, [workspaceId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!data || !user || !loadedRef.current) return;
    const key = settingsDraftStorageKey(user.id, "workspace", workspaceId);
    if (workspaceName.trim() !== baselineName) {
      sessionStorage.setItem(key, encodeSettingsDraft({
        actorId: user.id,
        resourceKind: "workspace",
        resourceId: workspaceId,
        baselineName,
        name: workspaceName
      }));
    } else {
      sessionStorage.removeItem(key);
    }
  }, [baselineName, data, user, workspaceId, workspaceName]);

  function replaceWorkspaceName(name: string) {
    draftNameRef.current = name;
    setWorkspaceName(name);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settingsDirty || !workspaceName.trim() || mutationBusy) return;
    setActionError("");
    setSaving(true);
    const input = settingsDraftUpdateInput(baselineNameRef.current, workspaceName);
    try {
      const saved = await apiClient.updateWorkspaceSettings(workspaceId, input, mutationKeys.requestKey("workspace-settings", workspaceId, input));
      mutationKeys.complete("workspace-settings", workspaceId);
      if (!mounted.current) return;
      baselineNameRef.current = saved.workspace.name;
      draftNameRef.current = saved.workspace.name;
      setData(saved);
      setBaselineName(saved.workspace.name);
      setWorkspaceName(saved.workspace.name);
      if (user) sessionStorage.removeItem(settingsDraftStorageKey(user.id, "workspace", workspaceId));
      notifyDirectoryChanged();
      showToast({ body: "Workspace settings saved." });
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("workspace-settings", workspaceId);
      if (!mounted.current) return;
      const changed = reason instanceof ApiError && reason.status === 409 && reason.message === "Workspace changed elsewhere. Reload and try again.";
      if (changed) {
        const baselineBeforeRefresh = baselineNameRef.current;
        const draftBeforeRefresh = draftNameRef.current;
        try {
          const [latest, identity] = await Promise.all([apiClient.workspaceSettings(workspaceId), apiClient.currentIdentity()]);
          if (!mounted.current) return;
          const rebased = resolveSettingsDraftSnapshot(latest.workspace.name, {
            baselineName: baselineBeforeRefresh,
            draftName: draftBeforeRefresh
          });
          baselineNameRef.current = rebased.baselineName;
          draftNameRef.current = rebased.draftName;
          setData(latest);
          setUser(identity.user);
          setBaselineName(rebased.baselineName);
          setWorkspaceName(rebased.draftName);
          setActionError(rebased.conflicted
            ? "Workspace changed elsewhere. Your workspace name was kept; review it against the latest name before saving again."
            : "Workspace changed elsewhere. Your name was rebased onto the latest settings.");
        } catch {
          if (mounted.current) setActionError("Workspace changed elsewhere, but the latest settings could not be loaded. Your name was kept.");
        }
      } else {
        setActionError(settingsErrorMessage(reason, "Workspace settings could not be saved."));
        if (isReadOnlyMutationError(reason)) await load();
      }
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
  const ownerTargetLabel=ownerTarget?.displayName||ownerTarget?.email||ownerTarget?.userId||"the selected member";
  const settingsDirty = data !== undefined && workspaceName.trim() !== baselineName;
  function discardName() {
    replaceWorkspaceName(baselineNameRef.current);
    setActionError("");
    if (user) sessionStorage.removeItem(settingsDraftStorageKey(user.id, "workspace", workspaceId));
  }
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
      if(!ownerTarget)return;
      await apiClient.transferWorkspaceOwner(workspaceId,ownerTarget.userId,mutationKeys.key("workspace-owner-transfer",ownerTarget.userId));
      mutationKeys.complete("workspace-owner-transfer",ownerTarget.userId);
      if(!mounted.current)return;
      notifyDirectoryChanged();
      setOwnerOpen(false);
      setOwnerTarget(undefined);
      setOwnerError("");
      await load();
      requestAnimationFrame(() => settingsRegionRef.current?.focus({ preventScroll: true }));
      showToast({ body: "Workspace ownership transferred." });
    } catch (reason) {
      if (reason instanceof ApiError&&ownerTarget) mutationKeys.complete("workspace-owner-transfer",ownerTarget.userId);
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
    {state === "ready" && data ? <div ref={settingsRegionRef} tabIndex={-1} className="outline-none">
      <Banner status="info" title="Workspace status" description={lifecycleMessage("workspace",lifecycleStatus)} />
      <form onSubmit={submit} className="mt-5 space-y-5 border-y border-border py-5"><TextInput label="Workspace name" htmlName="name" value={workspaceName} onChange={(value) => replaceWorkspaceName(value.slice(0, 160))} isRequired isDisabled={mutationBusy||!data.capabilities.canManageSettings||!isActive} width="100%" /><Text as="p" type="supporting" color="secondary" display="block">Project access is managed from each project.</Text><div className="flex items-center justify-end gap-2">{settingsDirty ? <Button label="Discard" variant="secondary" isDisabled={mutationBusy} onClick={discardName} /> : null}{data.capabilities.canManageSettings&&isActive ? <Button type="submit" label={saving ? "Saving..." : "Save workspace"} variant="primary" icon={<Save size={16} />} isDisabled={mutationBusy || !settingsDirty || !workspaceName.trim()} isLoading={saving} /> : <Text type="supporting" color="secondary">Read-only access.</Text>}</div></form>
      {canArchive||canRestore?<section className="mt-8 border-t border-border pt-6"><Heading level={3} accessibilityLevel={2}>Lifecycle</Heading><Text as="p" type="supporting" color="secondary" display="block" className="mt-1">Archived workspaces remain available for viewing. Only the workspace owner can restore one.</Text><Button className="mt-4" label={archived?"Unarchive workspace":"Archive workspace"} variant="secondary" icon={<Archive size={16}/>} isDisabled={mutationBusy} onClick={()=>archived?void setArchive():setArchiveDialogOpen(true)} /></section>:null}
      {canArchive?<Dialog className="[&_button]:min-h-11 [&_button]:min-w-11" isOpen={archiveOpen} onOpenChange={setArchiveDialogOpen} role="alertdialog" purpose={lifecycleBusy?"required":"form"} padding={0} width="min(32rem, calc(100dvw - 1rem))" maxHeight="calc(100dvh - 1rem)" aria-label="Archive workspace" aria-describedby={archiveDescriptionId}>
        <DialogHeader className="p-4 sm:px-6" title="Archive workspace" hasDivider/>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6"><Text id={archiveDescriptionId} as="p" display="block" color="secondary">Projects and workspace data remain available for viewing, but changes are disabled until the owner restores this workspace.</Text><div className="mt-4">{archiveError?<Banner status="error" title="Workspace could not be archived" description={archiveError}/>:null}</div></div>
        <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal"><Button data-autofocus="" type="button" label="Cancel" variant="ghost" size="lg" isDisabled={lifecycleBusy} onClick={()=>setArchiveDialogOpen(false)}/><Button type="button" label={lifecycleBusy?"Archiving":"Archive workspace"} variant="secondary" size="lg" isDisabled={mutationBusy} isLoading={lifecycleBusy} onClick={()=>{if(!mutationBusy)void setArchive()}}/></div>
      </Dialog>:null}
      {isOwner?<section className="mt-8 border-t border-border pt-6"><Heading level={3} accessibilityLevel={2}>Transfer ownership</Heading><Text as="p" type="supporting" color="secondary" display="block" className="mt-1">The new owner must already be a workspace member.</Text><div className="mt-4 grid max-w-md gap-2"><MemberDirectoryPicker kind="workspace" scopeId={workspaceId} label="New workspace owner" value={ownerTarget?.userId??""} onChange={setOwnerTarget} {...(user?{excludeUserId:user.id}:{})} disabled={!isActive||mutationBusy} pinned={ownerTarget?[ownerTarget]:[]}/><Button label="Transfer ownership" variant="secondary" isDisabled={!ownerTarget||!isActive||mutationBusy} onClick={()=>{setOwnerError("");setOwnerOpen(true)}}/></div></section>:null}
      {isOwner?<Dialog className="[&_button]:min-h-11 [&_button]:min-w-11" isOpen={ownerOpen&&Boolean(ownerTarget)} onOpenChange={(open)=>{if(ownerBusy&&!open)return;setOwnerOpen(open);if(!open){setOwnerError("");mutationKeys.clear("workspace-owner-transfer");}}} role="alertdialog" purpose={ownerBusy?"required":"form"} padding={0} width="min(32rem, calc(100dvw - 1rem))" maxHeight="calc(100dvh - 1rem)" aria-label="Transfer workspace ownership" aria-describedby={ownerDescriptionId}>
        <DialogHeader className="p-4 sm:px-6" title="Transfer workspace ownership" hasDivider/>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6"><Text id={ownerDescriptionId} as="p" display="block" color="secondary">Transfer this workspace to {ownerTargetLabel}? You will become a workspace administrator.</Text><div className="mt-4">{ownerError?<Banner status="error" title="Ownership could not be transferred" description={ownerError}/>:null}</div></div>
        <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal"><Button data-autofocus="" type="button" label="Cancel" variant="ghost" size="lg" isDisabled={ownerBusy} onClick={()=>{setOwnerOpen(false);setOwnerError("");mutationKeys.clear("workspace-owner-transfer")}}/><Button type="button" label={ownerBusy?"Transferring":"Transfer ownership"} variant="primary" size="lg" isDisabled={!ownerTarget||mutationBusy} isLoading={ownerBusy} onClick={()=>{if(!mutationBusy)void transferOwner()}}/></div>
      </Dialog>:null}
      {canDelete ? <section className="mt-8 border-t border-error pt-6" aria-label="Danger zone"><Heading level={3} accessibilityLevel={2}>{lifecycleStatus==="deleting"?"Continue workspace deletion":"Delete workspace"}</Heading><Text as="p" type="supporting" color="secondary" display="block" className="mt-1">{lifecycleStatus==="deleting"?"Previous cleanup did not finish. Continue deleting the remaining workspace-owned data.":"This permanently removes this workspace and all of its projects."}</Text><Button className="mt-4" label={lifecycleStatus==="deleting"?"Continue deletion":"Delete workspace"} variant="destructive" aria-label={lifecycleStatus==="deleting"?"Continue workspace deletion":"Open workspace deletion confirmation"} icon={<Trash2 size={16} />} isDisabled={mutationBusy} onClick={() => setDialogOpen(true)} /></section> : null}
      {canDelete ? <Dialog className="[&_button]:min-h-11 [&_button]:min-w-11" isOpen={deleteOpen} onOpenChange={(open)=>{if(deleting&&!open)return;setDialogOpen(open);}} role="alertdialog" purpose={deleting?"required":"form"} padding={0} width="min(34rem, calc(100dvw - 1rem))" maxHeight="calc(100dvh - 1rem)" aria-label={lifecycleStatus==="deleting"?"Continue workspace deletion":"Delete workspace"} aria-describedby={deleteDescriptionId}>
        <DialogHeader className="p-4 sm:px-6" title={lifecycleStatus==="deleting"?"Continue workspace deletion":"Delete workspace"} hasDivider/>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6"><Text id={deleteDescriptionId} as="p" display="block" color="secondary">This permanently removes the workspace, workspace context and memberships, every project, and all project-owned Tasks and conversations, File Libraries and files, Artifacts, endpoints and credentials, alerts, audit and usage records, context, and memberships. Your identity remains. All Sandboxes must be released first.</Text><form id="workspace-delete-form" className="mt-4 grid gap-4" onSubmit={(event)=>{event.preventDefault();void deleteWorkspace();}}><TextInput label={`Type ${data.workspace.name} to confirm`} value={deleteName} onChange={setDeleteName} isDisabled={mutationBusy} width="100%" /><div>{deleteError?<Banner status="error" title="Workspace could not be deleted" description={deleteError}/>:null}</div></form></div>
        <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal"><Button data-autofocus="" type="button" label="Cancel" variant="ghost" size="lg" isDisabled={deleting} onClick={()=>setDialogOpen(false)}/><Button type="submit" form="workspace-delete-form" label={deleting ? "Deleting" : lifecycleStatus==="deleting"?"Continue deletion":"Delete workspace"} variant="destructive" size="lg" isDisabled={mutationBusy || deleteName !== data.workspace.name} isLoading={deleting}/></div>
      </Dialog> : null}
    </div> : null}
  </PageLayout>;
}

function deletionMessage(error: unknown): string {
  if (error instanceof ApiError) return error.status === 409 ? `Deletion is pending: ${error.message}` : error.message;
  return error instanceof Error ? error.message : "The deletion could not be completed.";
}

function settingsErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : fallback;
}

function lifecycleMessage(kind:"project"|"workspace",status:"active"|"archived"|"deleting"){return status==="active"?`${kind[0]!.toUpperCase()+kind.slice(1)} status: Active.`:status==="archived"?`This ${kind} is archived and read-only.`:`This ${kind} is being deleted. Changes are unavailable.`;}
