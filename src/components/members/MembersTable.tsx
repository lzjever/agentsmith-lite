"use client";

import { Badge, Banner, Button, IconButton, Selector, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text } from "@astryxdesign/core";
import { Trash2, X } from "lucide-react";
import type { MemberRole, ProjectMember } from "../../lib/api/client";
import { formatLocalDate } from "../../lib/format/date";
import { memberIdentityLabel, memberRoleLabel } from "./members-page-utils";

const editableRoles: Exclude<MemberRole, "owner">[] = ["admin", "member", "viewer"];

export function MembersTable({ members, canManage, busyUserId, roleError, onDismissRoleError, onChangeRole, onRemove, onView }: { members: ProjectMember[]; canManage: boolean; busyUserId: string | undefined; roleError: { userId: string; message: string } | undefined; onDismissRoleError: () => void; onChangeRole: (member: ProjectMember, role: Exclude<MemberRole, "owner">) => void; onRemove: (member: ProjectMember) => void; onView: (member: ProjectMember) => void }) {
  const mutationBusy = busyUserId !== undefined;

  return <section aria-label="Project members" className="space-y-3">
    <div className="hidden md:block">
      <Table aria-label="Project members" density="balanced" dividers="rows" verticalAlign="top">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Member</TableHeaderCell>
            <TableHeaderCell>Access</TableHeaderCell>
            <TableHeaderCell>Joined</TableHeaderCell>
            <TableHeaderCell>Actions</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => <TableRow key={member.userId}>
            <TableCell><MemberIdentity member={member} /></TableCell>
            <TableCell><MemberRoleCell member={member} canManage={canManage} busy={mutationBusy} roleError={roleError} onDismissRoleError={onDismissRoleError} onChangeRole={onChangeRole} /></TableCell>
            <TableCell><Text type="supporting" color="secondary">{formatLocalDate(member.createdAt)}</Text></TableCell>
            <TableCell><MemberActions member={member} canManage={canManage} busy={mutationBusy} onRemove={onRemove} onView={onView} /></TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
    </div>
    <div className="divide-y divide-border rounded-md border border-border md:hidden">
      {members.map((member) => <article className="space-y-4 p-4" key={member.userId}>
        <MemberIdentity member={member} />
        <div className="grid grid-cols-2 gap-4">
          <div><Text as="p" type="supporting" color="secondary" display="block">Access</Text><div className="mt-1"><MemberRoleControl member={member} canManage={canManage} busy={mutationBusy} onChangeRole={onChangeRole} /></div></div>
          <div><Text as="p" type="supporting" color="secondary" display="block">Joined</Text><Text as="p" type="supporting" color="secondary" display="block" className="mt-1">{formatLocalDate(member.createdAt)}</Text></div>
        </div>
        {roleError?.userId === member.userId ? <InlineError message={roleError.message} onDismiss={onDismissRoleError} /> : null}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3"><MemberActions member={member} canManage={canManage} busy={mutationBusy} onRemove={onRemove} onView={onView} /></div>
      </article>)}
    </div>
  </section>;
}

function MemberIdentity({ member }: { member: ProjectMember }) { return <div className="grid gap-1"><Text weight="medium" wordBreak="break-all">{memberIdentityLabel(member)}</Text>{member.displayName ? <Text type="supporting" color="secondary">{member.email}</Text> : null}</div>; }

function MemberRoleCell({ member, canManage, busy, roleError, onDismissRoleError, onChangeRole }: { member: ProjectMember; canManage: boolean; busy: boolean; roleError: { userId: string; message: string } | undefined; onDismissRoleError: () => void; onChangeRole: (member: ProjectMember, role: Exclude<MemberRole, "owner">) => void }) {
  return <><MemberRoleControl member={member} canManage={canManage} busy={busy} onChangeRole={onChangeRole} />{roleError?.userId === member.userId ? <InlineError message={roleError.message} onDismiss={onDismissRoleError} /> : null}</>;
}

function MemberRoleControl({ member, canManage, busy, onChangeRole }: { member: ProjectMember; canManage: boolean; busy: boolean; onChangeRole: (member: ProjectMember, role: Exclude<MemberRole, "owner">) => void }) {
  return canManage && member.role !== "owner" ? <Selector label={`Role for ${memberIdentityLabel(member)}`} isLabelHidden size="lg" width={128} options={editableRoles.map((role) => ({ value: role, label: memberRoleLabel(role) }))} value={member.role} isDisabled={busy} onChange={(value) => onChangeRole(member, value as Exclude<MemberRole, "owner">)} /> : <Badge variant="neutral" label={memberRoleLabel(member.role)} />;
}

function MemberActions({ member, canManage, busy, onRemove, onView }: { member: ProjectMember; canManage: boolean; busy: boolean; onRemove: (member: ProjectMember) => void; onView: (member: ProjectMember) => void }) {
  return <div className="flex flex-wrap items-center justify-end gap-2"><Button label="View details" variant="ghost" size="md" onClick={() => onView(member)} />{canManage && member.role !== "owner" ? <IconButton label={`Remove ${memberIdentityLabel(member)}`} variant="ghost" size="lg" className="text-error" isDisabled={busy} onClick={() => onRemove(member)} icon={<Trash2 size={15} />} /> : null}</div>;
}

function InlineError({ message, onDismiss }: { message: string; onDismiss: () => void }) { return <Banner className="mt-2" status="error" title="Role update failed" description={message} endContent={<IconButton label="Dismiss role error" variant="ghost" size="lg" onClick={onDismiss} icon={<X size={15} />} />} />; }
