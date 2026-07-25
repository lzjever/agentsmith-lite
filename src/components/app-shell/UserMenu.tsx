"use client";

import { LogOut, NotebookTabs, UserRound } from "lucide-react";
import { Banner, Button, NavHeadingMenu, NavHeadingMenuItem, Popover, Text } from "@astryxdesign/core";
import { useEffect, useRef, useState } from "react";
import { apiClient, type CurrentUser } from "../../lib/api/client";
import { isCurrentAppPage } from "../../lib/navigation/return-path";
import { userMenuIdentity } from "./user-menu-identity";
import { clearTaskDraftsForUser, taskDraftStorage } from "../tasks/task-draft-snapshot";

export function UserMenu({ user, workspaceId, returnTo }: { user: CurrentUser; workspaceId?: string; returnTo?: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const signingOutRef = useRef(false);
  useEffect(() => setImageFailed(false), [user.pictureUrl]);

  async function signOut() {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    setSigningOut(true);
    setSignOutError("");
    try {
      const result = await apiClient.logout();
      clearTaskDraftsForUser(taskDraftStorage(), user.id);
      window.location.assign(result.redirectUrl);
    } catch {
      signingOutRef.current = false;
      setSigningOut(false);
      setSignOutError("Check your connection and try again.");
      setOpen(true);
    }
  }

  const profileHref = returnTo && !isCurrentAppPage(returnTo, "/profile") ? `/profile?returnTo=${encodeURIComponent(returnTo)}` : "/profile";
  const identity = userMenuIdentity(user);
  const menu = <div><div className="px-2 py-2"><Text display="block" maxLines={1}>{identity.primary}</Text>{identity.primary !== user.email ? <Text type="supporting" display="block" maxLines={1} className="mt-0.5">{user.email}</Text> : null}</div>{signOutError ? <div className="px-2 pb-2"><Banner status="error" title="Sign out failed" description={signOutError} endContent={<Button label="Try again" variant="ghost" size="sm" onClick={() => void signOut()} />} /></div> : null}<NavHeadingMenu size="sm" minWidth="100%"><div className="my-1 h-px bg-border" role="separator" /><NavHeadingMenuItem href={profileHref} onClick={() => setOpen(false)} icon={<UserRound size={15} />} label="Profile" />{workspaceId ? <NavHeadingMenuItem href={`/workspaces/${workspaceId}/context?scope=workspace_personal`} onClick={() => setOpen(false)} icon={<NotebookTabs size={15} />} label="My workspace context" /> : null}<div className="my-1 h-px bg-border" role="separator" /><NavHeadingMenuItem onClick={() => void signOut()} icon={<LogOut size={15} />} label={signingOut ? "Signing out..." : "Sign out"} isDisabled={signingOut} /></NavHeadingMenu></div>;
  return <Popover isOpen={open} onOpenChange={setOpen} label="Account menu" placement="below" alignment="end" width="min(20rem, calc(100vw - 1rem))" className="p-0" content={menu}>{({ ref, onClick, ...triggerProps }) => <Button ref={ref} type="button" label="Open account menu" variant="ghost" size="lg" onClick={onClick} {...triggerProps}><span className="flex min-w-0 items-center gap-2">{user.pictureUrl&&!imageFailed ? <img src={user.pictureUrl} alt="" className="size-8 rounded-full border border-border object-cover" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} /> : <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border"><Text type="supporting">{identity.initials}</Text></span>}<span className="hidden max-w-36 min-w-0 text-left md:grid"><Text type="supporting" display="block" maxLines={1}>{identity.primary}</Text><Text type="supporting" display="block" color="secondary" maxLines={1}>{identity.secondary}</Text></span></span></Button>}</Popover>;
}
