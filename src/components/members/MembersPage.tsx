"use client";

import Link from "next/link";
import { Dialog, DialogHeader, EmptyState, Selector, Spinner, TextInput } from "@astryxdesign/core";
import { Button } from "@astryxdesign/core/Button";
import { Plus, RefreshCw, Users, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type MemberRole, type ProjectCapabilities, type ProjectMember, type WorkspaceMember } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { ErrorState } from "../ui/error-state";
import { toast } from "../ui/toast";
import { memberIdentityLabel, memberMatchesQuery, removeMemberById } from "./members-page-utils";
import { MembersTable } from "./MembersTable";

export function MembersPage({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  return <ProjectMembersPage key={`${workspaceId}:${projectId}`} workspaceId={workspaceId} projectId={projectId} />;
}

function ProjectMembersPage({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const mutationKeys = useMutationKeys();
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const memberRequest = useRef(0);
  const candidateRequest = useRef(0);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [capabilities, setCapabilities] = useState<ProjectCapabilities>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [candidateState, setCandidateState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [capabilitiesError, setCapabilitiesError] = useState("");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | MemberRole>("all");
  const [selected, setSelected] = useState<ProjectMember>();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [candidateUserId, setCandidateUserId] = useState("");
  const [role, setRole] = useState<Exclude<MemberRole, "owner">>("member");
  const [removing, setRemoving] = useState<ProjectMember>();
  const [busyUserId, setBusyUserId] = useState<string>();
  const [inviteError, setInviteError] = useState("");
  const [roleError, setRoleError] = useState<{ userId: string; message: string }>();

  const loadCandidates = useCallback(async () => {
    const request = ++candidateRequest.current;
    setCandidateState("loading");
    try {
      const listed = await apiClient.workspaceMembers(workspaceId);
      if (!mounted.current || request !== candidateRequest.current) return;
      setWorkspaceMembers(listed);
      setCandidateState("ready");
    } catch {
      if (!mounted.current || request !== candidateRequest.current) return;
      setCandidateState("error");
    }
  }, [workspaceId]);

  const refreshMembers = useCallback(async () => {
    const request = ++memberRequest.current;
    const listed = await apiClient.members(projectId);
    if (!mounted.current || request !== memberRequest.current) return undefined;
    setMembers(listed);
    return listed;
  }, [projectId]);

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setState("loading");
    setError("");
    setCapabilities(undefined);
    setCapabilitiesError("");
    setWorkspaceMembers([]);
    setCandidateState("loading");
    const [membersResult, capabilitiesResult] = await Promise.allSettled([
      refreshMembers(),
      apiClient.projectCapabilities(projectId),
    ]);
    if (!mounted.current || request !== loadRequest.current) return;
    if (membersResult.status === "rejected") {
      setError(message(membersResult.reason));
      setState("error");
      return;
    }
    if (capabilitiesResult.status === "fulfilled") {
      setCapabilities(capabilitiesResult.value);
      if (capabilitiesResult.value.canManageMembers) void loadCandidates();
      else setCandidateState("ready");
    } else {
      setCapabilitiesError("Project permissions could not be loaded. Members are read-only until refreshed.");
      setCandidateState("ready");
    }
    setState("ready");
  }, [loadCandidates, projectId, refreshMembers]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!inviteOpen) mutationKeys.clear("project-member.add"); }, [inviteOpen]);

  const canManage = capabilities?.canManageMembers === true;
  const memberIds = useMemo(() => new Set(members.map((member) => member.userId)), [members]);
  const eligible = useMemo(() => workspaceMembers.filter((member) => !memberIds.has(member.userId)), [memberIds, workspaceMembers]);
  const canAdd = canManage && busyUserId === undefined && candidateState === "ready" && eligible.length > 0;
  const filtered = useMemo(() => members.filter((member) => memberMatchesQuery(member, query) && (roleFilter === "all" || member.role === roleFilter)), [members, query, roleFilter]);

  async function recoverMutationAccess(reason: unknown): Promise<boolean> {
    const projectMissing = reason instanceof ApiError && reason.status === 404 && reason.message === "Project not found";
    if (!projectMissing && !isReadOnlyMutationError(reason)) return false;
    setInviteOpen(false);
    setRemoving(undefined);
    if (projectMissing) {
      setMembers([]);
      setWorkspaceMembers([]);
      setCapabilities(undefined);
      setSelected(undefined);
      setRoleError(undefined);
      setError(reason.message);
      setState("error");
      return true;
    }
    if (reason.status === 403) {
      setMembers([]);
      setWorkspaceMembers([]);
      setCapabilities(undefined);
      setSelected(undefined);
      setRoleError(undefined);
      setState("loading");
      await load();
      return true;
    }
    setCapabilities((current) => current ? { ...current, canManageMembers: false } : current);
    setCapabilitiesError("Member management access changed. Members are now read-only.");
    return false;
  }

  function openInvite() {
    mutationKeys.clear("project-member.add");
    setInviteError("");
    setCandidateUserId(eligible[0]?.userId ?? "");
    setInviteOpen(true);
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAdd || !candidateUserId) return;
    const candidate = eligible.find((member) => member.userId === candidateUserId);
    if (!candidate) return;
    setBusyUserId("new");
    setInviteError("");
    try {
      const added = await apiClient.addMember(projectId, candidateUserId, role, mutationKeys.requestKey("project-member.add", projectId, { candidateUserId, role }));
      mutationKeys.complete("project-member.add", projectId);
      if (!mounted.current) return;
      setMembers((current) => [...current.filter((member) => member.userId !== added.userId), added]);
      setInviteOpen(false);
      setCandidateUserId("");
      setRole("member");
      toast.success("Member added");
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ApiError) mutationKeys.complete("project-member.add", projectId);
      const detail = message(reason);
      if (await recoverMutationAccess(reason)) return;
      setInviteError(detail);
      const [membersResult] = await Promise.allSettled([refreshMembers(), loadCandidates()]);
      if (membersResult.status === "rejected") await recoverMutationAccess(membersResult.reason);
    } finally {
      if (mounted.current) setBusyUserId(undefined);
    }
  }

  async function changeRole(member: ProjectMember, nextRole: Exclude<MemberRole, "owner">) {
    if (!canManage || busyUserId !== undefined) return;
    setBusyUserId(member.userId);
    setRoleError(undefined);
    try {
      const requestIdentity = `${member.userId}:${nextRole}`;
      const updated = await apiClient.changeMember(projectId, member.userId, nextRole, member.updatedAt, mutationKeys.key("project-member.change", requestIdentity));
      mutationKeys.complete("project-member.change", requestIdentity);
      if (!mounted.current) return;
      setMembers((current) => current.map((item) => item.userId === updated.userId ? updated : item));
      toast.success("Member role updated");
    } catch (reason) {
      if (!mounted.current) return;
      const requestIdentity = `${member.userId}:${nextRole}`;
      if (reason instanceof ApiError) mutationKeys.complete("project-member.change", requestIdentity);
      const detail = message(reason);
      if (await recoverMutationAccess(reason)) return;
      let refreshed: ProjectMember[] | undefined;
      try { refreshed = await refreshMembers(); } catch (refreshReason) {
        if (await recoverMutationAccess(refreshReason)) return;
      }
      if (!mounted.current) return;
      if (refreshed?.some((item) => item.userId === member.userId && item.role === nextRole)) {
        toast.success("Member role updated");
        return;
      }
      setRoleError({ userId: member.userId, message: detail });
    } finally {
      if (mounted.current) setBusyUserId(undefined);
    }
  }

  async function removeMember() {
    if (!removing || !canManage || busyUserId !== undefined) return;
    const member = removing;
    setBusyUserId(member.userId);
    try {
      await apiClient.removeMember(projectId, member.userId, member.updatedAt, mutationKeys.key("project-member.remove", member.userId));
      mutationKeys.complete("project-member.remove", member.userId);
      if (!mounted.current) return;
      setMembers((items) => removeMemberById(items, member.userId));
      setRemoving(undefined);
      toast.success("Member removed");
      void loadCandidates();
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ApiError) mutationKeys.complete("project-member.remove", member.userId);
      const detail = message(reason);
      if (await recoverMutationAccess(reason)) return;
      let refreshed: ProjectMember[] | undefined;
      try { refreshed = await refreshMembers(); } catch (refreshReason) {
        if (await recoverMutationAccess(refreshReason)) return;
      }
      if (!mounted.current) return;
      if (refreshed && !refreshed.some((item) => item.userId === member.userId)) {
        mutationKeys.complete("project-member.remove", member.userId);
        setRemoving(undefined);
        toast.success("Member removed");
        void loadCandidates();
        return;
      }
      throw new Error(detail);
    } finally {
      if (mounted.current) setBusyUserId(undefined);
    }
  }

  const workspaceMembersHref = `/workspaces/${workspaceId}/members`;
  return <PageLayout header={<PageHeader title="Members" subtitle="People with access to this project and the role they hold." actions={canAdd ? <Button label="Add member" variant="primary" size="lg" icon={<Plus size={16} />} onClick={openInvite} /> : undefined} />}>
    {state === "ready" && capabilitiesError ? <div className="border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning" role="alert">{capabilitiesError}</div> : null}
    {state === "loading" ? <PageState state="loading"><Spinner label="Loading project members..." /></PageState> : null}
    {state === "error" ? <PageState state="error"><ErrorState title="Members unavailable" message={error} onRetry={() => void load()} /></PageState> : null}
    {state === "ready" && members.length === 0 ? <PageState state="empty"><EmptyState icon={<Users />} title="No project members" description="Project access begins with a workspace member." {...(canAdd ? { actions: <Button label="Add member" variant="primary" size="lg" onClick={openInvite} /> } : {})} /></PageState> : null}
    {state === "ready" && members.length > 0 ? <section className="space-y-4">
      {canManage && candidateState === "error" ? <div className="flex flex-wrap items-center justify-between gap-3 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert"><span>Workspace members could not be loaded. Existing project access is still available.</span><span className="flex items-center gap-2"><Button label="Retry" variant="ghost" size="md" icon={<RefreshCw size={14} />} onClick={() => void loadCandidates()} /><Link className="text-sm underline underline-offset-4" href={workspaceMembersHref}>Manage workspace members</Link></span></div> : null}
      {canManage && candidateState === "ready" && eligible.length === 0 ? <p className="flex flex-wrap items-center justify-between gap-3 border-y border-border py-3 text-sm text-secondary"><span>All workspace members already have project access.</span><Link className="text-foreground underline underline-offset-4" href={workspaceMembersHref}>Manage workspace members</Link></p> : null}
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="relative min-w-[15rem] flex-1 sm:max-w-sm"><TextInput label="Search members" isLabelHidden value={query} onChange={setQuery} placeholder="Search by identity" size="lg" /></div><Selector label="Member role" isLabelHidden options={[{ value: "all", label: "All roles" }, { value: "owner", label: "Owner" }, { value: "admin", label: "Admin" }, { value: "member", label: "Member" }, { value: "viewer", label: "Viewer" }]} value={roleFilter} onChange={(value) => setRoleFilter(value as typeof roleFilter)} size="sm" width={144} />{!canManage ? <p className="text-sm text-secondary">Your project access is read-only.</p> : null}</div>
      {filtered.length === 0 ? <PageState state="empty"><div className="space-y-2"><h2 className="type-title">No members match these filters</h2><Button label="Clear filters" variant="ghost" size="lg" onClick={() => { setQuery(""); setRoleFilter("all"); }} /></div></PageState> : <MembersTable members={filtered} canManage={canManage} busyUserId={busyUserId} roleError={roleError} onDismissRoleError={() => setRoleError(undefined)} onChangeRole={(member, nextRole) => void changeRole(member, nextRole)} onRemove={setRemoving} onView={setSelected} />}
    </section> : null}
    <Dialog isOpen={inviteOpen} onOpenChange={(open) => { if (busyUserId !== "new") setInviteOpen(open); if (!open) setInviteError(""); }} purpose="info" width="min(34rem, calc(100vw - 2rem))" padding={0} aria-label="Add member"><form onSubmit={addMember}><DialogHeader title="Add member" subtitle="Choose someone who already belongs to this workspace." onOpenChange={(open) => { if (busyUserId !== "new") setInviteOpen(open); if (!open) setInviteError(""); }} hasDivider />{inviteError ? <div className="mx-5 mt-4 flex items-start justify-between gap-3 rounded-sm border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert"><span>{inviteError}</span><Button label="Dismiss member error" variant="ghost" size="lg" icon={<X size={15} />} isIconOnly onClick={() => setInviteError("")} /></div> : null}<div className="grid gap-4 px-5 py-5"><Selector label="Workspace member" options={eligible.map((member) => ({ value: member.userId, label: workspaceMemberLabel(member) }))} value={candidateUserId} onChange={setCandidateUserId} placeholder="Select a workspace member" isDisabled={busyUserId === "new"} size="lg" /><Selector label="Role" options={[{ value: "member", label: "Member" }, { value: "viewer", label: "Viewer" }, { value: "admin", label: "Admin" }]} value={role} onChange={(value) => setRole(value as Exclude<MemberRole, "owner">)} isDisabled={busyUserId === "new"} size="lg" /></div><footer className="flex flex-col-reverse gap-2 border-t border-subtle px-5 py-4 sm:flex-row sm:justify-end md:px-6"><Button type="button" label="Cancel" variant="ghost" size="lg" onClick={() => setInviteOpen(false)} isDisabled={busyUserId === "new"} /><Button type="submit" label={busyUserId === "new" ? "Adding..." : "Add member"} variant="primary" size="lg" isDisabled={!canAdd || !candidateUserId || busyUserId === "new"} /></footer></form></Dialog>
    <ConfirmationDialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(undefined)} title="Remove member" description={removing ? `Remove ${memberIdentityLabel(removing)} from this project? They will no longer be able to access its resources.` : ""} confirmText={busyUserId === removing?.userId ? "Removing" : "Remove member"} confirmDisabled={!canManage || busyUserId !== undefined} onConfirm={removeMember} errorContext="Member could not be removed" />
    <Dialog isOpen={Boolean(selected)} onOpenChange={(open) => !open && setSelected(undefined)} purpose="info" width="min(34rem, calc(100vw - 2rem))" padding={0} aria-label="Member details">{selected ? <><DialogHeader title="Member details" subtitle="Project membership identity." onOpenChange={(open) => !open && setSelected(undefined)} hasDivider /><dl className="grid gap-4 px-5 py-5 text-sm sm:grid-cols-[8rem_1fr]"><dt className="text-secondary">Name</dt><dd className="break-all text-foreground">{memberIdentityLabel(selected)}</dd><dt className="text-secondary">Email</dt><dd className="break-all text-foreground">{selected.email}</dd><dt className="text-secondary">Role</dt><dd className="text-foreground">{selected.role}</dd><dt className="text-secondary">Joined</dt><dd className="text-foreground">{new Date(selected.createdAt).toLocaleString("en-US")}</dd><dt className="text-secondary">Updated</dt><dd className="text-foreground">{new Date(selected.updatedAt).toLocaleString("en-US")}</dd></dl></> : null}</Dialog>
  </PageLayout>;
}

function workspaceMemberLabel(member: WorkspaceMember) { return member.displayName || member.email || member.userId; }
function message(error: unknown) { return error instanceof ApiError ? error.message : "The member request could not be completed."; }
