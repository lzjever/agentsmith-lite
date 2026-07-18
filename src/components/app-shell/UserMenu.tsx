"use client";

import { LogOut, NotebookTabs, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiClient, type CurrentUser } from "../../lib/api/client";
import { isCurrentAppPage } from "../../lib/navigation/return-path";
import { DropdownContent, DropdownItem, DropdownMenu } from "../ui/dropdown-menu";
import { toast } from "../ui/toast";

export function UserMenu({ user, workspaceId, returnTo }: { user: CurrentUser; workspaceId?: string; returnTo?: string }) {
  const [imageFailed, setImageFailed] = useState(false);
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
  return <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="flex items-center gap-2 rounded-sm px-1.5 py-1 text-left text-secondary transition-colors hover:bg-surface-low hover:text-foreground" aria-label="Open account menu">{user.pictureUrl&&!imageFailed ? <img src={user.pictureUrl} alt="" className="size-8 rounded-full border border-border object-cover" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} /> : <span className="grid size-8 place-items-center rounded-full border border-border text-xs text-foreground">{initials(user)}</span>}<span className="hidden max-w-36 min-w-0 md:grid"><strong className="text-xs font-normal text-foreground">Signed in</strong><small className="truncate text-xs text-secondary">{user.email}</small></span></button></DropdownMenu.Trigger><DropdownContent align="end" className="min-w-52"><div className="px-2 py-2"><p className="truncate text-sm text-foreground">{user.email}</p></div><DropdownMenu.Separator className="my-1 h-px bg-subtle" /><DropdownItem asChild><Link href={profileHref}><UserRound size={15} />Profile</Link></DropdownItem>{workspaceId ? <DropdownItem asChild><Link href={`/workspaces/${workspaceId}/context?scope=workspace_personal`}><NotebookTabs size={15} />My workspace context</Link></DropdownItem> : null}<DropdownMenu.Separator className="my-1 h-px bg-subtle" /><DropdownItem className="gap-2 text-error data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60" disabled={signingOut} onSelect={() => void signOut()}><LogOut size={15} />{signingOut ? "Signing out..." : "Sign out"}</DropdownItem></DropdownContent></DropdownMenu.Root>;
}
function initials(user: CurrentUser): string { return (user.displayName || user.email).split(/\s+|@/).filter(Boolean).slice(0,2).map((part)=>part[0]!.toUpperCase()).join(""); }
