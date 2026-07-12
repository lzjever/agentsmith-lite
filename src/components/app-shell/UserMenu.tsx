"use client";

import { LogOut, NotebookTabs, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiClient, type CurrentUser } from "../../lib/api/client";
import { DropdownContent, DropdownItem, DropdownMenu } from "../ui/dropdown-menu";

export function UserMenu({ user, workspaceId }: { user: CurrentUser; workspaceId?: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [user.pictureUrl]);
  async function signOut() { await apiClient.logout(); window.location.assign("/"); }
  return <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="flex items-center gap-2 rounded-sm px-1.5 py-1 text-left text-secondary transition-colors hover:bg-surface-low hover:text-foreground" aria-label="Open account menu">{user.pictureUrl&&!imageFailed ? <img src={user.pictureUrl} alt="" className="size-8 rounded-full border border-border object-cover" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} /> : <span className="grid size-8 place-items-center rounded-full border border-border text-xs text-foreground">{initials(user)}</span>}<span className="hidden max-w-36 min-w-0 md:grid"><strong className="text-xs font-normal text-foreground">Signed in</strong><small className="truncate text-xs text-secondary">{user.email}</small></span></button></DropdownMenu.Trigger><DropdownContent align="end" className="min-w-52"><div className="px-2 py-2"><p className="truncate text-sm text-foreground">{user.email}</p></div><DropdownMenu.Separator className="my-1 h-px bg-subtle" /><DropdownItem asChild><Link href="/profile"><UserRound size={15} />Profile</Link></DropdownItem>{workspaceId ? <DropdownItem asChild><Link href={`/workspaces/${workspaceId}/context`}><NotebookTabs size={15} />My workspace context</Link></DropdownItem> : null}<DropdownMenu.Separator className="my-1 h-px bg-subtle" /><DropdownItem className="gap-2 text-error" onSelect={() => void signOut()}><LogOut size={15} />Sign out</DropdownItem></DropdownContent></DropdownMenu.Root>;
}
function initials(user: CurrentUser): string { return (user.displayName || user.email).split(/\s+|@/).filter(Boolean).slice(0,2).map((part)=>part[0]!.toUpperCase()).join(""); }
