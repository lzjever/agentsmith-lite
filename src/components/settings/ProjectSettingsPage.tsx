"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, RefreshCw, Save, Trash2, Users } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Banner, Button, DialogHeader, Heading, Layout, LayoutContent, Selector, Spinner, Text, TextInput, useToast } from "@astryxdesign/core";
import { ApiError, apiClient, isReadOnlyMutationError, notifyDirectoryChanged, type CurrentUser, type ProjectMember, type ProjectSettings } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { Dialog, DialogFooter } from "../ui/Dialog";
import { SettingsLoadError } from "./SettingsRouteState";

export function ProjectSettingsPage({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  return <ProjectSettings key={`${workspaceId}:${projectId}`} workspaceId={workspaceId} projectId={projectId} />;
}

function ProjectSettings({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const router = useRouter();
  const mutationKeys = useMutationKeys();
  const showToast = useToast();
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
  const [archiveError, setArchiveError] = useState("");
  const [deleteName, setDeleteName] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [ownerError, setOwnerError] = useState("");
  const [actionError, setActionError] = useState("");
  const [members,setMembers]=useState<ProjectMember[]>([]);const [memberState,setMemberState]=useState<"loading"|"ready"|"error">("loading");const [ownerTarget,setOwnerTarget]=useState("");const [ownerOpen,setOwnerOpen]=useState(false);const [ownerBusy,setOwnerBusy]=useState(false);const [lifecycleBusy,setLifecycleBusy]=useState(false);
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
    if (!settingsDirty || !projectName.trim() || mutationBusy) return;
    setActionError("");
    setSaving(true);
    const input = { name: projectName, expectedName: data!.project.name };
    try {
      const saved = await apiClient.updateProjectSettings(projectId, input, mutationKeys.requestKey("project-settings", projectId, input));
      mutationKeys.complete("project-settings", projectId);
      if (!mounted.current) return;
      setData(saved);
      setProjectName(saved.project.name);
      notifyDirectoryChanged();
      showToast({ body: "Project settings saved." });
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("project-settings", projectId);
      if (!mounted.current) return;
      const changed = reason instanceof ApiError && reason.status === 409 && reason.message === "Project changed elsewhere. Reload and try again.";
      setActionError(changed ? "Project changed elsewhere. Latest settings loaded; review your changes before saving again." : settingsErrorMessage(reason, "Project settings could not be saved."));
      if (changed || isReadOnlyMutationError(reason)) await load();
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
  const settingsDirty = data !== undefined && projectName.trim() !== data.project.name;
  const ownerCandidates = members.filter((member) => member.userId !== user?.id);
  const ownerTargetEligible = !ownerTarget || ownerCandidates.some((member) => member.userId === ownerTarget);
  useEffect(() => {
    if (memberState !== "ready" || !ownerTarget || ownerTargetEligible) return;
    setOwnerOpen(false);
    setOwnerTarget("");
    mutationKeys.clear("project-owner-transfer");
  }, [memberState, ownerTarget, ownerTargetEligible]);
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
      await apiClient.transferProjectOwner(projectId,ownerTarget,mutationKeys.key("project-owner-transfer",ownerTarget));
      mutationKeys.complete("project-owner-transfer",ownerTarget);
      if(!mounted.current)return;
      setData({...data,project:{...data.project,ownerUserId:ownerTarget}});
      notifyDirectoryChanged();
      setOwnerOpen(false);
      setOwnerTarget("");
      setOwnerError("");
      showToast({ body: "Project ownership transferred." });
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("project-owner-transfer",ownerTarget);
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
    {state === "ready" && data ? <>
      <Banner status="info" title="Project status" description={projectLifecycleMessage(lifecycleStatus,workspaceLifecycleStatus)} />
      <form onSubmit={submit} className="mt-5 grid gap-5 border-y border-border py-5">
        <TextInput label="Project name" htmlName="name" value={projectName} onChange={(value) => setProjectName(value.slice(0, 160))} isRequired isDisabled={mutationBusy||!data.capabilities.canManageSettings||!isActive} width="100%" />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"><Text type="supporting" color="secondary">Members and resource limits are managed in their dedicated sections.</Text>{data.capabilities.canManageSettings&&isActive ? <Button type="submit" label={saving ? "Saving..." : "Save project"} variant="primary" icon={<Save size={16} />} isDisabled={mutationBusy || !settingsDirty || !projectName.trim()} isLoading={saving} /> : <Text type="supporting" color="secondary">Read-only access.</Text>}</div>
      </form>
      {showLifecycle?<section className="mt-8 border-t border-border pt-6"><Heading level={3}>Lifecycle</Heading><Text as="p" type="supporting" color="secondary" display="block" className="mt-1">Archived projects remain available for viewing. Only the project owner can restore one.</Text>{archived&&!workspaceActive?<Text as="p" type="supporting" color="secondary" display="block" className="mt-4">Restore the workspace before unarchiving this project.</Text>:<Button className="mt-4" label={archived ? "Unarchive project" : "Archive project"} variant="secondary" icon={<Archive size={16}/>} isDisabled={mutationBusy} onClick={()=>archived?void setArchive():setArchiveDialogOpen(true)} />}</section>:null}
      {canArchive?<Dialog isOpen={archiveOpen} onOpenChange={setArchiveDialogOpen} purpose="form" role="alertdialog" width="min(32rem, calc(100vw - 2rem))" aria-labelledby="project-archive-title" aria-describedby="project-archive-description"><Layout defaultHasDividers header={<DialogHeader id="project-archive-title" title="Archive project" />} content={<LayoutContent><form id="project-archive-form" onSubmit={(event)=>{event.preventDefault();void setArchive();}}><div className="grid gap-4"><Text id="project-archive-description" as="p" display="block" color="secondary">Project data remains available for viewing, but changes and new task runs are disabled until the owner restores this project.</Text>{archiveError?<Banner status="error" title="Project could not be archived" description={archiveError}/>:null}</div></form></LayoutContent>} footer={<DialogFooter secondaryAction={<Button label="Cancel" type="button" variant="ghost" size="lg" isDisabled={lifecycleBusy} onClick={()=>setArchiveDialogOpen(false)}/>} primaryAction={<Button label={lifecycleBusy?"Archiving":"Archive project"} type="submit" form="project-archive-form" variant="destructive" size="lg" isDisabled={lifecycleBusy} isLoading={lifecycleBusy}/>} />} /></Dialog>:null}
      {isOwner?<section className="mt-8 border-t border-border pt-6"><Heading level={3}>Transfer ownership</Heading><Text as="p" type="supporting" color="secondary" display="block" className="mt-1">Choose an existing project member as the new owner.</Text>{memberState==="loading"?<Text as="p" type="supporting" color="secondary" display="block" className="mt-4" role="status">Loading eligible project members...</Text>:null}{memberState==="error"?<Banner className="mt-4" status="error" title="Project members unavailable" description="Project members could not be loaded." endContent={<Button label="Retry" variant="ghost" size="sm" aria-label="Retry member loading" icon={<RefreshCw size={14}/>} isDisabled={mutationBusy} onClick={()=>void loadMembers()} />}/>:null}{memberState==="ready"&&ownerCandidates.length === 0 ? <Text as="p" type="supporting" color="secondary" display="block" className="mt-4" role="status">There are no other project members eligible to become owner.</Text> : null}{memberState==="ready"&&ownerCandidates.length>0?<div className="mt-4 flex flex-wrap items-end gap-2"><Selector id="project-owner-target" label="New project owner" options={ownerCandidates.map((member) => ({ value: member.userId, label: memberLabel(member) }))} value={ownerTargetEligible?ownerTarget:""} onChange={setOwnerTarget} placeholder="Select a member" isDisabled={!canTransferOwnership||mutationBusy} size="lg" width={256} /><Button label="Transfer ownership" variant="secondary" isDisabled={!ownerTarget||!ownerTargetEligible||!canTransferOwnership||mutationBusy} onClick={()=>{setOwnerError("");setOwnerOpen(true);}} /></div>:null}</section>:null}
      {isOwner?<Dialog isOpen={ownerOpen&&ownerTargetEligible} onOpenChange={(open)=>{if(ownerBusy&&!open)return;setOwnerOpen(open);if(!open){setOwnerError("");mutationKeys.clear("project-owner-transfer");}}} purpose="form" role="alertdialog" width="min(32rem, calc(100vw - 2rem))" aria-labelledby="project-owner-transfer-title" aria-describedby="project-owner-transfer-description"><Layout defaultHasDividers header={<DialogHeader id="project-owner-transfer-title" title="Transfer project ownership" />} content={<LayoutContent><div className="grid gap-4"><Text id="project-owner-transfer-description" as="p" display="block" color="secondary">The current owner becomes an administrator.</Text>{ownerError?<Banner status="error" title="Ownership could not be transferred" description={ownerError}/>:null}</div></LayoutContent>} footer={<DialogFooter secondaryAction={<Button label="Cancel" variant="ghost" size="lg" isDisabled={ownerBusy} onClick={()=>setOwnerOpen(false)}/>} primaryAction={<Button label="Transfer ownership" variant="primary" size="lg" isDisabled={!ownerTarget||!ownerTargetEligible||!canTransferOwnership||mutationBusy} isLoading={ownerBusy} onClick={()=>void transferOwner()}/>} />} /></Dialog>:null}
      {canDelete ? <section className="mt-8 border-t border-error pt-6" aria-label="Danger zone"><Heading level={3}>{lifecycleStatus==="deleting"?"Continue project deletion":"Delete project"}</Heading><Text as="p" type="supporting" color="secondary" display="block" className="mt-1">{lifecycleStatus==="deleting"?"Previous cleanup did not finish. Continue deleting the remaining project-owned data.":"This permanently removes this project and its project-owned data."}</Text><Button className="mt-4" label={lifecycleStatus==="deleting"?"Continue deletion":"Delete project"} variant="destructive" aria-label={lifecycleStatus==="deleting"?"Continue project deletion":"Open project deletion confirmation"} icon={<Trash2 size={16} />} isDisabled={mutationBusy} onClick={() => setDialogOpen(true)} /></section> : null}
      {canDelete ? <Dialog isOpen={deleteOpen} onOpenChange={(open)=>{if(deleteBusy&&!open)return;setDialogOpen(open);}} purpose="form" role="alertdialog" width="min(32rem, calc(100vw - 2rem))" aria-labelledby="project-delete-title" aria-describedby="project-delete-description"><Layout defaultHasDividers header={<DialogHeader id="project-delete-title" title={lifecycleStatus==="deleting"?"Continue project deletion":"Delete project"} />} content={<LayoutContent><form id="project-delete-form" className="grid gap-4" onSubmit={(event)=>{event.preventDefault();void deleteProject();}}><Text id="project-delete-description" as="p" display="block" color="secondary">This action permanently removes project-owned data. Type <Text weight="semibold">{data.project.name}</Text> to continue.</Text><TextInput label="Project name" value={deleteName} onChange={setDeleteName} isDisabled={mutationBusy} width="100%" />{deleteError?<Banner status="error" title="Project could not be deleted" description={deleteError}/>:null}</form></LayoutContent>} footer={<DialogFooter secondaryAction={<Button label="Cancel" type="button" variant="ghost" size="lg" isDisabled={deleteBusy} onClick={()=>setDialogOpen(false)}/>} primaryAction={<Button label={deleteBusy ? "Deleting" : lifecycleStatus==="deleting"?"Continue deletion":"Delete project"} type="submit" form="project-delete-form" variant="destructive" size="lg" isDisabled={mutationBusy || deleteName !== data.project.name} isLoading={deleteBusy}/>} />} /></Dialog> : null}
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
function projectLifecycleMessage(status:"active"|"archived"|"deleting",workspaceStatus:ProjectSettings["workspaceLifecycleStatus"]){return status==="archived"?"This project is archived and read-only.":status==="deleting"?"This project is being deleted. Changes are unavailable.":workspaceStatus==="archived"?"This project is read-only because its workspace is archived.":workspaceStatus==="deleting"?"This project is read-only because its workspace is being deleted.":"Project status: Active.";}
