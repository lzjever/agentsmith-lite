"use client";

import { LogOut, NotebookTabs, UserRound } from "lucide-react";
import Link from "next/link";
import { Popover } from "@astryxdesign/core";
import { useEffect, useRef, useState } from "react";
import { apiClient, type CurrentUser } from "../../lib/api/client";
import { isCurrentAppPage } from "../../lib/navigation/return-path";
import { toast } from "../ui/toast";
import { userMenuIdentity } from "./user-menu-identity";

export function UserMenu({ user, workspaceId, returnTo }: { user: CurrentUser; workspaceId?: string; returnTo?: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const signingOutRef = useRef(false);
  useEffect(() => setImageFailed(false), [user.pictureUrl]);

  async function signOut() {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    setSigningOut(true);
    try {
      const result = await apiClient.logout();
      window.location.assign(result.redirectUrl);
    } catch {
      signingOutRef.current = false;
      setSigningOut(false);
      toast.error("Sign out failed. Check your connection and try again.");
    }
  }

  const profileHref = returnTo && !isCurrentAppPage(returnTo, "/profile") ? `/profile?returnTo=${encodeURIComponent(returnTo)}` : "/profile";
  const identity = userMenuIdentity(user);
  return <Popover isOpen={open} onOpenChange={setOpen} label="Account menu" placement="below" alignment="end" width="13rem" className="p-0" content={<><div className="px-2 py-2"><p className="truncate text-sm text-foreground">{identity.primary}</p>{identity.primary !== user.email ? <p className="mt-0.5 truncate text-xs text-secondary">{user.email}</p> : null}</div><div className="my-1 h-px bg-subtle" /><Link href={profileHref} onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-foreground hover:bg-hover"><UserRound size={15} />Profile</Link>{workspaceId ? <Link href={`/workspaces/${workspaceId}/context?scope=workspace_personal`} onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-foreground hover:bg-hover"><NotebookTabs size={15} />My workspace context</Link> : null}<div className="my-1 h-px bg-subtle" /><button type="button" className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-error hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60" disabled={signingOut} onClick={() => void signOut()}><LogOut size={15} />{signingOut ? "Signing out..." : "Sign out"}</button></>}>{({ ref, onClick, ...triggerProps }) => <button ref={ref} type="button" className="flex items-center gap-2 rounded-sm px-1.5 py-1 text-left text-secondary transition-colors hover:bg-surface-low hover:text-foreground" aria-label="Open account menu" onClick={onClick} {...triggerProps}>{user.pictureUrl&&!imageFailed ? <img src={user.pictureUrl} alt="" className="size-8 rounded-full border border-border object-cover" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} /> : <span className="grid size-8 place-items-center rounded-full border border-border text-xs text-foreground">{identity.initials}</span>}<span className="hidden max-w-36 min-w-0 md:grid"><strong className="truncate text-xs font-normal text-foreground">{identity.primary}</strong><small className="truncate text-xs text-secondary">{identity.secondary}</small></span></button>}</Popover>;
}
