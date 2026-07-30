"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, Save, Trash2, Users } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { Banner, Button, Dialog, DialogHeader, Heading, Spinner, Text, TextInput, useToast } from "@astryxdesign/core";
import { ApiError, apiClient, isReadOnlyMutationError, notifyDirectoryChanged, type CurrentUser, type ProjectMemberCandidate, type ProjectSettings } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { MemberDirectoryPicker } from "../members/MemberDirectoryPicker";
import { SettingsLoadError } from "./SettingsRouteState";
import { decodeSettingsDraft, encodeSettingsDraft, resolveSettingsDraftSnapshot, settingsDraftStorageKey, settingsDraftUpdateInput } from "./settings-draft-state";

export function ProjectSettingsPage({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  return <ProjectSettings key={`${workspaceId}:${projectId}`} workspaceId={workspaceId} projectId={projectId} />;
}

function ProjectSettings({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
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
  const [data, setData] = useState<ProjectSettings>();
  const [user, setUser] = useState<CurrentUser>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [baselineName, setBaselineName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [deleteName, setDeleteName] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [ownerError, setOwnerError] = useState("");
  const [actionError, setActionError] = useState("");
  const [ownerTarget,setOwnerTarget]=useState<ProjectMemberCandidate>();const [ownerOpen,setOwnerOpen]=useState(false);const [ownerBusy,setOwnerBusy]=useState(false);const [lifecycleBusy,setLifecycleBusy]=useState(false);
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    if (!loadedRef.current) setState("loading");
    setLoadError("");
    try {
      const [settings, identity] = await Promise.all([apiClient.projectSettings(projectId), apiClient.currentIdentity()]);
      if (!mounted.current || request !== loadRequest.current) return;
      if (settings.project.workspaceId !== workspaceId) throw new ApiError(404, "This project does not belong to this workspace.");
      const wasLoaded = loadedRef.current;
      const stored = wasLoaded ? null : decodeSettingsDraft(
        sessionStorage.getItem(settingsDraftStorageKey(identity.user.id, "project", projectId)),
        { actorId: identity.user.id, resourceKind: "project", resourceId: projectId }
      );
      const knownDraft = wasLoaded
        ? { baselineName: baselineNameRef.current, draftName: draftNameRef.current }
        : stored
          ? { baselineName: stored.baselineName, draftName: stored.name }
          : undefined;
      const resolved = resolveSettingsDraftSnapshot(settings.project.name, knownDraft);
      loadedRef.current = true;
      baselineNameRef.current = resolved.baselineName;
      draftNameRef.current = resolved.draftName;
      setData(settings);
      setBaselineName(resolved.baselineName);
      setProjectName(resolved.draftName);
      setUser(identity.user);
      setActionError(resolved.conflicted
        ? wasLoaded
          ? "The project name changed while you were editing. Your name was kept; review it against the latest name before saving."
          : "Your saved project name overlaps a newer server name. Review it before saving."
        : "");
      setState("ready");
    } catch (reason) {
      if (!mounted.current || request !== loadRequest.current) return;
      const message = settingsErrorMessage(reason, "Project settings could not be loaded.");
      setLoadError(message);
      if (loadedRef.current) setActionError(message);
      else setState("error");
    }
  }, [projectId, workspaceId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!data || !user || !loadedRef.current) return;
    const key = settingsDraftStorageKey(user.id, "project", projectId);
    if (projectName.trim() !== baselineName) {
      sessionStorage.setItem(key, encodeSettingsDraft({
        actorId: user.id,
        resourceKind: "project",
        resourceId: projectId,
        baselineName,
        name: projectName
      }));
    } else {
      sessionStorage.removeItem(key);
    }
  }, [baselineName, data, projectId, projectName, user]);

  function replaceProjectName(name: string) {
    draftNameRef.current = name;
    setProjectName(name);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settingsDirty || !projectName.trim() || mutationBusy) return;
    setActionError("");
    setSaving(true);
    const input = settingsDraftUpdateInput(baselineNameRef.current, projectName);
    try {
      const saved = await apiClient.updateProjectSettings(projectId, input, mutationKeys.requestKey("project-settings", projectId, input));
      mutationKeys.complete("project-settings", projectId);
      if (!mounted.current) return;
      baselineNameRef.current = saved.project.name;
      draftNameRef.current = saved.project.name;
      setData(saved);
      setBaselineName(saved.project.name);
      setProjectName(saved.project.name);
      if (user) sessionStorage.removeItem(settingsDraftStorageKey(user.id, "project", projectId));
      notifyDirectoryChanged();
      showToast({ body: "Project settings saved." });
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("project-settings", projectId);
      if (!mounted.current) return;
      const changed = reason instanceof ApiError && reason.status === 409 && reason.message === "Project changed elsewhere. Reload and try again.";
      if (changed) {
        const baselineBeforeRefresh = baselineNameRef.current;
        const draftBeforeRefresh = draftNameRef.current;
        try {
          const [latest, identity] = await Promise.all([apiClient.projectSettings(projectId), apiClient.currentIdentity()]);
          if (!mounted.current) return;
          if (latest.project.workspaceId !== workspaceId) throw new ApiError(404, "This project does not belong to this workspace.");
          const rebased = resolveSettingsDraftSnapshot(latest.project.name, {
            baselineName: baselineBeforeRefresh,
            draftName: draftBeforeRefresh
          });
          baselineNameRef.current = rebased.baselineName;
          draftNameRef.current = rebased.draftName;
          setData(latest);
          setUser(identity.user);
          setBaselineName(rebased.baselineName);
          setProjectName(rebased.draftName);
          setActionError(rebased.conflicted
            ? "Project changed elsewhere. Your project name was kept; review it against the latest name before saving again."
            : "Project changed elsewhere. Your name was rebased onto the latest settings.");
        } catch {
          if (mounted.current) setActionError("Project changed elsewhere, but the latest settings could not be loaded. Your name was kept.");
        }
      } else {
        setActionError(settingsErrorMessage(reason, "Project settings could not be saved."));
        if (isReadOnlyMutationError(reason)) await load();
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const lifecycleStatus=data?.project.lifecycleStatus??"active";
  const workspaceLifecycleStatus=data?.workspaceLifecycleStatus??"active";
  const workspaceActive=workspaceLifecycleStatus==="active";
  const archived=lifecycleStatus==="archived";
  const isActive=lifecycleStatus==="active";
  const isOwner = data?.project.ownerUserId === user?.id;
  const canDelete = isOwner;
  const canArchive=data?.capabilities.canManageSettings===true&&isActive;
  const canRestore=isOwner&&archived&&workspaceActive;
  const showLifecycle=canArchive||(isOwner&&archived);
  const canTransferOwnership=isOwner&&isActive&&data?.capabilities.canManageSettings===true;
  const mutationBusy=saving||lifecycleBusy||ownerBusy||deleteBusy;
  const ownerTargetLabel=ownerTarget?.displayName||ownerTarget?.email||ownerTarget?.userId||"the selected member";
  const settingsDirty = data !== undefined && projectName.trim() !== baselineName;
  function discardName() {
    replaceProjectName(baselineNameRef.current);
    setActionError("");
    if (user) sessionStorage.removeItem(settingsDraftStorageKey(user.id, "project", projectId));
  }
  function setArchiveDialogOpen(open: boolean) {
    if (lifecycleBusy && !open) return;
    setArchiveOpen(open);
    if (!open) {
      setArchiveError("");
      mutationKeys.clear("project-archive");
    }
  }
  async function setArchive(){
    if(!data||mutationBusy)return;
    const operation=archived?"project-unarchive":"project-archive";
    setActionError("");
    setArchiveError("");
    setLifecycleBusy(true);
    try{
      if(archived)await apiClient.unarchiveProject(projectId,mutationKeys.key(operation,projectId));
      else await apiClient.archiveProject(projectId,mutationKeys.key(operation,projectId));
      mutationKeys.complete(operation,projectId);
      if(!mounted.current)return;
      notifyDirectoryChanged();
      setArchiveOpen(false);
      await load();
      if(mounted.current)showToast({ body: archived?"Project restored.":"Project archived." });
    }catch(reason){
      if(reason instanceof ApiError)mutationKeys.complete(operation,projectId);
      if(!mounted.current)return;
      const message=settingsErrorMessage(reason,"Project lifecycle could not be updated.");
      if(archived)setActionError(message);
      else setArchiveError(message);
    }finally{
      if(mounted.current)setLifecycleBusy(false);
    }
  }
  async function transferOwner(){
    if(!data||!canTransferOwnership||mutationBusy)return;
    setOwnerBusy(true);
    setOwnerError("");
    try {
      if(!ownerTarget)return;
      await apiClient.transferProjectOwner(projectId,ownerTarget.userId,mutationKeys.key("project-owner-transfer",ownerTarget.userId));
      mutationKeys.complete("project-owner-transfer",ownerTarget.userId);
      if(!mounted.current)return;
      notifyDirectoryChanged();
      setOwnerOpen(false);
      setOwnerTarget(undefined);
      setOwnerError("");
      await load();
      requestAnimationFrame(() => settingsRegionRef.current?.focus({ preventScroll: true }));
      showToast({ body: "Project ownership transferred." });
    } catch (reason) {
      if (reason instanceof ApiError&&ownerTarget) mutationKeys.complete("project-owner-transfer",ownerTarget.userId);
      if (mounted.current) setOwnerError(settingsErrorMessage(reason, "Project ownership could not be transferred."));
    } finally { if(mounted.current)setOwnerBusy(false); }
  }
  async function deleteProject() {
    if (mutationBusy) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await apiClient.deleteProject(projectId,mutationKeys.key("project-delete",projectId));
      mutationKeys.complete("project-delete",projectId);
      if (!mounted.current) return;
      showToast({ body: "Project deleted." });
      router.push(`/workspaces/${workspaceId}`);
    } catch (error) {
      if (error instanceof ApiError) mutationKeys.complete("project-delete",projectId);
      if (!mounted.current) return;
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        setDialogOpen(false);
        notifyDirectoryChanged();
        router.push(`/workspaces/${workspaceId}`);
        return;
      }
      setDeleteError(deletionMessage(error));
    } finally {
      if (mounted.current) setDeleteBusy(false);
    }
  }

  function setDialogOpen(open: boolean) {
    setDeleteOpen(open);
    if (!open) {
      setDeleteName("");
      setDeleteError("");
      mutationKeys.clear("project-delete");
    }
  }

  return <PageLayout contentWidth="narrow" header={<PageHeader title="Project settings" subtitle="Project metadata and access administration." actions={<Link className="inline-flex items-center gap-2 text-secondary hover:text-primary" href={`/workspaces/${workspaceId}/projects/${projectId}/members`}><Users size={16} /><Text type="supporting" color="inherit">Manage members</Text></Link>} />}>
    {state === "loading" ? <div className="flex min-h-48 items-center justify-center"><Spinner label="Loading project settings..." /></div> : null}
    {state === "error" ? <SettingsLoadError message={loadError} onRetry={() => void load()} backHref={`/workspaces/${workspaceId}/projects/${projectId}/overview`} backLabel="Back to project" /> : null}
    {state === "ready" && actionError ? <Banner className="mb-5" status="error" title="Project could not be updated" description={actionError} /> : null}
    {state === "ready" && data ? <div ref={settingsRegionRef} tabIndex={-1} className="outline-none">
      <Banner status="info" title="Project status" description={projectLifecycleMessage(lifecycleStatus,workspaceLifecycleStatus)} />
      <form onSubmit={submit} className="mt-5 grid gap-5 border-y border-border py-5">
        <TextInput label="Project name" htmlName="name" value={projectName} onChange={(value) => replaceProjectName(value.slice(0, 160))} isRequired isDisabled={mutationBusy||!data.capabilities.canManageSettings||!isActive} width="100%" />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"><Text type="supporting" color="secondary">Members and resource limits are managed in their dedicated sections.</Text><div className="flex items-center gap-2">{settingsDirty ? <Button label="Discard" variant="secondary" isDisabled={mutationBusy} onClick={discardName} /> : null}{data.capabilities.canManageSettings&&isActive ? <Button type="submit" label={saving ? "Saving..." : "Save project"} variant="primary" icon={<Save size={16} />} isDisabled={mutationBusy || !settingsDirty || !projectName.trim()} isLoading={saving} /> : <Text type="supporting" color="secondary">Read-only access.</Text>}</div></div>
      </form>
      {showLifecycle?<section className="mt-8 border-t border-border pt-6"><Heading level={3} accessibilityLevel={2}>Lifecycle</Heading><Text as="p" type="supporting" color="secondary" display="block" className="mt-1">Archived projects remain available for viewing. Only the project owner can restore one.</Text>{archived&&!workspaceActive?<Text as="p" type="supporting" color="secondary" display="block" className="mt-4">Restore the workspace before unarchiving this project.</Text>:<Button className="mt-4" label={archived ? "Unarchive project" : "Archive project"} variant="secondary" icon={<Archive size={16}/>} isDisabled={mutationBusy} onClick={()=>archived?void setArchive():setArchiveDialogOpen(true)} />}</section>:null}
      {canArchive?<Dialog className="[&_button]:min-h-11 [&_button]:min-w-11" isOpen={archiveOpen} onOpenChange={setArchiveDialogOpen} role="alertdialog" purpose={lifecycleBusy?"required":"form"} padding={0} width="min(32rem, calc(100dvw - 1rem))" maxHeight="calc(100dvh - 1rem)" aria-label="Archive project" aria-describedby={archiveDescriptionId}>
        <DialogHeader className="p-4 sm:px-6" title="Archive project" hasDivider/>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6"><Text id={archiveDescriptionId} as="p" display="block" color="secondary">Project data remains available for viewing, but changes and new Task runs are disabled until the owner restores this project.</Text><div className="mt-4">{archiveError?<Banner status="error" title="Project could not be archived" description={archiveError}/>:null}</div></div>
        <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal"><Button data-autofocus="" type="button" label="Cancel" variant="ghost" size="lg" isDisabled={lifecycleBusy} onClick={()=>setArchiveDialogOpen(false)}/><Button type="button" label={lifecycleBusy?"Archiving":"Archive project"} variant="secondary" size="lg" isDisabled={mutationBusy} isLoading={lifecycleBusy} onClick={()=>{if(!mutationBusy)void setArchive()}}/></div>
      </Dialog>:null}
      {isOwner?<section className="mt-8 border-t border-border pt-6"><Heading level={3} accessibilityLevel={2}>Transfer ownership</Heading><Text as="p" type="supporting" color="secondary" display="block" className="mt-1">Choose an existing project member as the new owner.</Text><div className="mt-4 grid max-w-md gap-2"><MemberDirectoryPicker kind="project" scopeId={projectId} label="New project owner" value={ownerTarget?.userId??""} onChange={setOwnerTarget} {...(user?{excludeUserId:user.id}:{})} disabled={!canTransferOwnership||mutationBusy} pinned={ownerTarget?[ownerTarget]:[]}/><Button label="Transfer ownership" variant="secondary" isDisabled={!ownerTarget||!canTransferOwnership||mutationBusy} onClick={()=>{setOwnerError("");setOwnerOpen(true)}}/></div></section>:null}
      {isOwner?<Dialog className="[&_button]:min-h-11 [&_button]:min-w-11" isOpen={ownerOpen&&Boolean(ownerTarget)} onOpenChange={(open)=>{if(ownerBusy&&!open)return;setOwnerOpen(open);if(!open){setOwnerError("");mutationKeys.clear("project-owner-transfer");}}} role="alertdialog" purpose={ownerBusy?"required":"form"} padding={0} width="min(32rem, calc(100dvw - 1rem))" maxHeight="calc(100dvh - 1rem)" aria-label="Transfer project ownership" aria-describedby={ownerDescriptionId}>
        <DialogHeader className="p-4 sm:px-6" title="Transfer project ownership" hasDivider/>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6"><Text id={ownerDescriptionId} as="p" display="block" color="secondary">Transfer this project to {ownerTargetLabel}? You will become a project administrator.</Text><div className="mt-4">{ownerError?<Banner status="error" title="Ownership could not be transferred" description={ownerError}/>:null}</div></div>
        <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal"><Button data-autofocus="" type="button" label="Cancel" variant="ghost" size="lg" isDisabled={ownerBusy} onClick={()=>{setOwnerOpen(false);setOwnerError("");mutationKeys.clear("project-owner-transfer")}}/><Button type="button" label={ownerBusy?"Transferring":"Transfer ownership"} variant="primary" size="lg" isDisabled={!ownerTarget||!canTransferOwnership||mutationBusy} isLoading={ownerBusy} onClick={()=>{if(!mutationBusy)void transferOwner()}}/></div>
      </Dialog>:null}
      {canDelete ? <section className="mt-8 border-t border-error pt-6" aria-label="Danger zone"><Heading level={3} accessibilityLevel={2}>{lifecycleStatus==="deleting"?"Continue project deletion":"Delete project"}</Heading><Text as="p" type="supporting" color="secondary" display="block" className="mt-1">{lifecycleStatus==="deleting"?"Previous cleanup did not finish. Continue deleting the remaining project-owned data.":"This permanently removes this project and its project-owned data."}</Text><Button className="mt-4" label={lifecycleStatus==="deleting"?"Continue deletion":"Delete project"} variant="destructive" aria-label={lifecycleStatus==="deleting"?"Continue project deletion":"Open project deletion confirmation"} icon={<Trash2 size={16} />} isDisabled={mutationBusy} onClick={() => setDialogOpen(true)} /></section> : null}
      {canDelete ? <Dialog className="[&_button]:min-h-11 [&_button]:min-w-11" isOpen={deleteOpen} onOpenChange={(open)=>{if(deleteBusy&&!open)return;setDialogOpen(open);}} role="alertdialog" purpose={deleteBusy?"required":"form"} padding={0} width="min(34rem, calc(100dvw - 1rem))" maxHeight="calc(100dvh - 1rem)" aria-label={lifecycleStatus==="deleting"?"Continue project deletion":"Delete project"} aria-describedby={deleteDescriptionId}>
        <DialogHeader className="p-4 sm:px-6" title={lifecycleStatus==="deleting"?"Continue project deletion":"Delete project"} hasDivider/>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6"><Text id={deleteDescriptionId} as="p" display="block" color="secondary">This permanently removes all project-owned data, including Tasks and conversations, File Libraries and files, Artifacts, endpoints and credentials, alerts, audit and usage records, project context, and project memberships. The workspace and its other projects remain. All Sandboxes must be released first.</Text><form id="project-delete-form" className="mt-4 grid gap-4" onSubmit={(event)=>{event.preventDefault();void deleteProject();}}><TextInput label={`Type ${data.project.name} to confirm`} value={deleteName} onChange={setDeleteName} isDisabled={mutationBusy} width="100%" /><div>{deleteError?<Banner status="error" title="Project could not be deleted" description={deleteError}/>:null}</div></form></div>
        <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal"><Button data-autofocus="" type="button" label="Cancel" variant="ghost" size="lg" isDisabled={deleteBusy} onClick={()=>setDialogOpen(false)}/><Button type="submit" form="project-delete-form" label={deleteBusy ? "Deleting" : lifecycleStatus==="deleting"?"Continue deletion":"Delete project"} variant="destructive" size="lg" isDisabled={mutationBusy || deleteName !== data.project.name} isLoading={deleteBusy}/></div>
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

function projectLifecycleMessage(status:"active"|"archived"|"deleting",workspaceStatus:ProjectSettings["workspaceLifecycleStatus"]){return status==="archived"?"This project is archived and read-only.":status==="deleting"?"This project is being deleted. Changes are unavailable.":workspaceStatus==="archived"?"This project is read-only because its workspace is archived.":workspaceStatus==="deleting"?"This project is read-only because its workspace is being deleted.":"Project status: Active.";}
