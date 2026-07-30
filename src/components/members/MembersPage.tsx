"use client";

import { Banner, Button, Dialog, DialogHeader, EmptyState, IconButton, Selector, Spinner, Text, TextInput, useToast } from "@astryxdesign/core";
import { Plus, Search, Users, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type MemberRole, type ProjectCapabilities, type ProjectMember, type ProjectMemberCandidate } from "../../lib/api/client";
import { formatLocalDateTime } from "../../lib/format/date";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { MemberDirectoryPicker } from "./MemberDirectoryPicker";
import { memberIdentityLabel } from "./members-page-utils";
import { MembersTable } from "./MembersTable";
import { useMemberDirectory } from "./useMemberDirectory";

export function MembersPage({workspaceId,projectId}:{workspaceId:string;projectId:string}){return <ProjectMembersPage key={`${workspaceId}:${projectId}`} workspaceId={workspaceId} projectId={projectId}/>}

function ProjectMembersPage({projectId}:{workspaceId:string;projectId:string}){
  const mutationKeys=useMutationKeys(),showToast=useToast(),mounted=useRef(true),capabilityRequest=useRef(0);
  const fetchMembers=useCallback((query:{q?:string;role?:string;cursor?:string;limit:number})=>apiClient.members(projectId,{...(query.q?{q:query.q}:{}),...(query.role?{role:query.role as MemberRole}:{}),...(query.cursor?{cursor:query.cursor}:{}),limit:query.limit}),[projectId]);
  const directory=useMemberDirectory<ProjectMember>(fetchMembers,projectId);
  const [capabilities,setCapabilities]=useState<ProjectCapabilities>(),[capabilitiesState,setCapabilitiesState]=useState<"loading"|"ready"|"error">("loading");
  const [selected,setSelected]=useState<ProjectMember>(),[inviteOpen,setInviteOpen]=useState(false),[candidate,setCandidate]=useState<ProjectMemberCandidate>();
  const [candidateRevision,setCandidateRevision]=useState(0),[role,setRole]=useState<Exclude<MemberRole,"owner">>("member"),[removing,setRemoving]=useState<ProjectMember>();
  const [busyUserId,setBusyUserId]=useState<string>(),[inviteError,setInviteError]=useState(""),[roleError,setRoleError]=useState<{userId:string;message:string}>(),[removeError,setRemoveError]=useState("");
  const inviteFormId=useId();
  const removeDescriptionId=useId();
  const inviteDialogRef=useRef<HTMLDialogElement>(null);
  const membersRegionRef=useRef<HTMLElement>(null);

  const loadCapabilities=useCallback(async()=>{const request=++capabilityRequest.current;setCapabilitiesState("loading");try{const found=await apiClient.projectCapabilities(projectId);if(!mounted.current||request!==capabilityRequest.current)return;setCapabilities(found);setCapabilitiesState("ready");}catch{if(mounted.current&&request===capabilityRequest.current){setCapabilities(undefined);setCapabilitiesState("error");}}},[projectId]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;}},[]);
  useEffect(()=>{void loadCapabilities()},[loadCapabilities]);
  useEffect(()=>{if(!inviteOpen)mutationKeys.clear("project-member.add")},[inviteOpen]);
  useEffect(()=>{if(!inviteOpen)return;const frame=requestAnimationFrame(()=>inviteDialogRef.current?.querySelector<HTMLElement>("input")?.focus());return()=>cancelAnimationFrame(frame)},[inviteOpen]);

  const canManage=capabilities?.canManageMembers===true,mutationBusy=busyUserId!==undefined;
  async function reload(){setCandidateRevision((value)=>value+1);await Promise.allSettled([directory.reloadFirst(),loadCapabilities()]);}
  async function recover(reason:unknown){
    const stale=reason instanceof ApiError&&(reason.status===404||reason.status===409);
    if(stale){setSelected(undefined);setRemoving(undefined);await reload();requestAnimationFrame(()=>membersRegionRef.current?.focus({preventScroll:true}));}
    if(isReadOnlyMutationError(reason)||reason instanceof ApiError&&reason.status===403){setInviteOpen(false);setSelected(undefined);setRemoving(undefined);await reload();return true;}
    return false;
  }
  async function addMember(event:FormEvent<HTMLFormElement>){event.preventDefault();if(!canManage||mutationBusy||!candidate)return;setBusyUserId("new");setInviteError("");try{await apiClient.addMember(projectId,candidate.userId,role,mutationKeys.requestKey("project-member.add",projectId,{candidateUserId:candidate.userId,role}));mutationKeys.complete("project-member.add",projectId);if(!mounted.current)return;setInviteOpen(false);setCandidate(undefined);setRole("member");showToast({body:"Member added"});await reload();}catch(reason){if(reason instanceof ApiError)mutationKeys.complete("project-member.add",projectId);if(mounted.current&&!await recover(reason))setInviteError(message(reason));}finally{if(mounted.current)setBusyUserId(undefined)}}
  async function changeRole(member:ProjectMember,nextRole:Exclude<MemberRole,"owner">){if(!canManage||mutationBusy)return;setBusyUserId(member.userId);setRoleError(undefined);const identity=`${member.userId}:${nextRole}`;try{await apiClient.changeMember(projectId,member.userId,nextRole,member.updatedAt,mutationKeys.key("project-member.change",identity));mutationKeys.complete("project-member.change",identity);if(!mounted.current)return;setSelected(undefined);showToast({body:"Member role updated"});await reload();}catch(reason){if(reason instanceof ApiError)mutationKeys.complete("project-member.change",identity);if(mounted.current&&!await recover(reason))setRoleError({userId:member.userId,message:message(reason)});}finally{if(mounted.current)setBusyUserId(undefined)}}
  async function removeMember(){if(!removing||!canManage||mutationBusy)return;const member=removing;setBusyUserId(member.userId);setRemoveError("");try{await apiClient.removeMember(projectId,member.userId,member.updatedAt,mutationKeys.key("project-member.remove",member.userId));mutationKeys.complete("project-member.remove",member.userId);if(!mounted.current)return;setRemoving(undefined);showToast({body:"Member removed"});await reload();requestAnimationFrame(()=>membersRegionRef.current?.focus({preventScroll:true}));}catch(reason){if(reason instanceof ApiError)mutationKeys.complete("project-member.remove",member.userId);if(mounted.current&&!await recover(reason))setRemoveError(message(reason));}finally{if(mounted.current)setBusyUserId(undefined)}}

  const initialLoading=directory.state==="loading"||capabilitiesState==="loading";
  return <PageLayout header={<PageHeader title="Members" subtitle="People with access to this project and the role they hold." actions={canManage?<Button label="Add member" variant="primary" size="lg" icon={<Plus size={16}/>} onClick={()=>{setInviteError("");setCandidate(undefined);setInviteOpen(true)}}/>:undefined}/>}>
    {capabilitiesState==="error"?<Banner status="warning" title="Project permissions unavailable" description="Members are read-only until permissions can be refreshed." endContent={<Button label="Retry" variant="ghost" onClick={()=>void loadCapabilities()}/>}/>:null}
    {initialLoading?<div className="flex min-h-48 items-center justify-center"><Spinner label="Loading project members..."/></div>:null}
    {directory.state==="error"?<Banner status="error" title="Members unavailable" description={directory.error} endContent={<Button label="Try again" variant="secondary" onClick={()=>void directory.retry()}/>} />:null}
    {directory.state==="ready"?<section ref={membersRegionRef} tabIndex={-1} className="space-y-4 outline-none" aria-label="Project members" aria-busy={directory.refreshing}>
      {directory.refreshError?<Banner status="error" title="Members could not be refreshed" description={directory.refreshError} endContent={<Button label="Retry" variant="ghost" onClick={()=>void directory.retry()}/>} />:null}
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="relative min-w-[15rem] flex-1 sm:max-w-sm"><TextInput label="Search members" isLabelHidden startIcon={<Search size={16}/>} value={directory.query} onChange={directory.setSearch} placeholder="Search by identity" size="lg"/></div><Selector label="Member role" isLabelHidden options={[{value:"all",label:"All roles"},{value:"owner",label:"Owner"},{value:"admin",label:"Admin"},{value:"member",label:"Member"},{value:"viewer",label:"Viewer"}]} value={directory.role??"all"} onChange={(value)=>directory.setRole(value==="all"?undefined:value)} size="sm" width={144}/>{!canManage?<Text type="supporting" color="secondary">Your project access is read-only.</Text>:null}</div>
      {directory.page.items.length===0?<EmptyState icon={<Users/>} title={directory.query||directory.role?"No members match these filters":"No project members"} actions={directory.query||directory.role?<Button label="Clear filters" variant="ghost" size="lg" onClick={()=>{directory.setSearch("");directory.setRole(undefined)}}/>:undefined}/>:<MembersTable members={directory.page.items} canManage={canManage} busyUserId={busyUserId} roleError={roleError} onDismissRoleError={()=>setRoleError(undefined)} onChangeRole={(member,next)=>void changeRole(member,next)} onRemove={(member)=>{setRemoveError("");setRemoving(member)}} onView={setSelected}/>}
      {directory.page.items.length>0||directory.history.length>0?<div className="flex items-center justify-end gap-2"><Button label="Previous" variant="secondary" size="sm" isDisabled={directory.refreshing||directory.history.length===0} onClick={directory.previous}/><Text type="supporting" color="secondary">Page {directory.history.length+1}</Text><Button label="Next" variant="secondary" size="sm" isDisabled={directory.refreshing||!directory.page.nextCursor} onClick={directory.next}/></div>:null}
    </section>:null}
    <Dialog className="[&_button]:min-h-11 [&_button]:min-w-11" ref={inviteDialogRef} isOpen={inviteOpen} onOpenChange={(open)=>{if(busyUserId==="new"&&!open)return;setInviteOpen(open);if(!open)setInviteError("")}} purpose="form" padding={0} width="min(34rem, calc(100dvw - 1rem))" maxHeight="calc(100dvh - 1rem)" aria-label="Add member">
      <DialogHeader className="p-4 sm:px-6" title="Add member" subtitle="Choose someone who already belongs to this workspace." hasDivider {...(busyUserId!=="new"?{onOpenChange:(open:boolean)=>{setInviteOpen(open);if(!open)setInviteError("")}}:{})}/>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {inviteError?<Banner className="mb-4" status="error" title="Member could not be added" description={inviteError} endContent={<IconButton label="Dismiss member error" variant="ghost" size="lg" icon={<X size={15}/>} onClick={()=>setInviteError("")}/>}/>:null}
        {inviteOpen&&canManage?<form id={inviteFormId} className="grid gap-4" onSubmit={addMember}><MemberDirectoryPicker key={candidateRevision} kind="projectCandidates" scopeId={projectId} label="Workspace member" value={candidate?.userId??""} onChange={setCandidate} disabled={busyUserId==="new"} hasAutoFocus/><Selector label="Project role" options={[{value:"member",label:"Member"},{value:"viewer",label:"Viewer"},{value:"admin",label:"Admin"}]} value={role} onChange={(value)=>setRole(value as Exclude<MemberRole,"owner">)} isDisabled={busyUserId==="new"} size="lg"/></form>:null}
      </div>
      <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal"><Button type="button" label="Cancel" variant="ghost" size="lg" isDisabled={busyUserId==="new"} onClick={()=>{setInviteOpen(false);setInviteError("")}}/><Button type="submit" form={inviteFormId} label={busyUserId==="new"?"Adding...":"Add member"} variant="primary" size="lg" isDisabled={!canManage||!candidate||busyUserId==="new"} isLoading={busyUserId==="new"}/></div>
    </Dialog>
    <Dialog className="[&_button]:min-h-11 [&_button]:min-w-11" isOpen={Boolean(removing)} onOpenChange={(open)=>{if(mutationBusy)return;if(!open){setRemoving(undefined);setRemoveError("")}}} role="alertdialog" purpose={mutationBusy?"required":"form"} padding={0} width="min(32rem, calc(100dvw - 1rem))" maxHeight="calc(100dvh - 1rem)" aria-label="Remove member" aria-describedby={removeDescriptionId}>
      <DialogHeader className="p-4 sm:px-6" title="Remove member" hasDivider/>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6"><Text id={removeDescriptionId} as="p" color="secondary">{removing?`Remove ${memberIdentityLabel(removing)} from this project? They will no longer be able to access its resources.`:"This member is no longer available."}</Text><div className="mt-4">{removeError?<Banner status="error" title="Member could not be removed" description={removeError}/>:null}</div></div>
      <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal"><Button data-autofocus="" type="button" label="Cancel" variant="ghost" size="lg" isDisabled={mutationBusy} onClick={()=>{setRemoving(undefined);setRemoveError("")}}/><Button type="button" label={busyUserId===removing?.userId?"Removing":"Remove member"} variant="destructive" size="lg" isDisabled={!canManage||mutationBusy} isLoading={mutationBusy} onClick={()=>{if(!mutationBusy)void removeMember()}}/></div>
    </Dialog>
    <Dialog className="[&_button]:min-h-11 [&_button]:min-w-11" isOpen={Boolean(selected)} onOpenChange={(open)=>!open&&setSelected(undefined)} purpose="info" padding={0} width="min(34rem, calc(100dvw - 1rem))" maxHeight="calc(100dvh - 1rem)" aria-label="Member details"><DialogHeader className="p-4 sm:px-6" title="Member details" subtitle="Project membership identity." hasDivider onOpenChange={(open)=>!open&&setSelected(undefined)}/><div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">{selected?<dl className="grid gap-4 sm:grid-cols-[8rem_1fr]"><dt><Text color="secondary">Name</Text></dt><dd><Text wordBreak="break-all">{memberIdentityLabel(selected)}</Text></dd><dt><Text color="secondary">Email</Text></dt><dd><Text wordBreak="break-all">{selected.email}</Text></dd><dt><Text color="secondary">Role</Text></dt><dd><Text>{selected.role}</Text></dd><dt><Text color="secondary">Joined</Text></dt><dd><Text>{formatLocalDateTime(selected.createdAt)}</Text></dd><dt><Text color="secondary">Updated</Text></dt><dd><Text>{formatLocalDateTime(selected.updatedAt)}</Text></dd></dl>:null}</div></Dialog>
  </PageLayout>
}

function message(error:unknown){return error instanceof ApiError?error.message:"The member request could not be completed."}
