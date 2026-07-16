"use client";

import { ArrowLeft, Save, UserRound } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiClient, type Profile } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toast } from "../ui/toast";

const greetings = ["friendly", "concise", "formal"] as const;

export function ProfilePage() {
  const [profile, setProfile] = useState<Profile>(); const [state, setState] = useState<"loading" | "ready" | "error">("loading"); const [saving, setSaving] = useState(false); const [greeting, setGreeting] = useState("friendly");
  const [returnTo, setReturnTo] = useState("/");
  const load = useCallback(async () => { setState("loading"); try { const next = await apiClient.profile(); setProfile(next); setGreeting(greetings.includes(next.preferences.greetingPreference as typeof greetings[number]) ? next.preferences.greetingPreference! : "friendly"); setState("ready"); } catch { setState("error"); } }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setReturnTo(profileReturnPath()); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); setSaving(true); try { setProfile(await apiClient.updateProfile({ displayName: text(form, "displayName"), timezone: text(form, "timezone"), bio: text(form, "bio"), jobTitle: text(form, "jobTitle"), company: text(form, "company"), greetingPreference: greeting, interests: String(form.get("interests") || "").split(",").map((value) => value.trim()).filter(Boolean) })); toast.success("Profile saved."); } catch { toast.error("Profile could not be saved."); } finally { setSaving(false); } }
  return <PageLayout contentWidth="narrow" header={<PageHeader title="Profile" subtitle="Your local product preferences. Identity is managed by your provider." actions={<Link href={returnTo} className="inline-flex items-center gap-2 text-sm text-secondary hover:text-foreground"><ArrowLeft size={16} />{returnLabel(returnTo)}</Link>} />}>
    {state === "loading" ? <PageState state="loading">Loading profile...</PageState> : null}{state === "error" ? <PageState state="error"><div><p>Profile unavailable.</p><Button className="mt-3" onClick={() => void load()}>Try again</Button></div></PageState> : null}
    {state === "ready" && profile ? <form onSubmit={submit} className="space-y-8"><section className="border-y border-subtle py-5"><div className="flex items-center gap-4"><IdentityAvatar user={profile.user} displayName={profile.preferences.displayName} /><SectionHeading icon={UserRound} title="Identity" description="Managed by Keycloak." /></div><dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2"><IdentityMetadata label="Email" value={profile.user.email} /><IdentityMetadata label="Email status" value={profile.user.emailVerified ? "Verified" : "Not verified"} /></dl></section><section className="border-b border-subtle pb-6"><SectionHeading title="Basic information" /><div className="mt-5 grid gap-4"><Field label="Display name"><Input name="displayName" defaultValue={profile.preferences.displayName ?? ""} /></Field><Field label="Bio"><Textarea name="bio" defaultValue={profile.preferences.bio ?? ""} rows={4} /></Field></div></section><section className="border-b border-subtle pb-6"><SectionHeading title="Work information" /><div className="mt-5 grid gap-4 sm:grid-cols-2"><Field label="Job title"><Input name="jobTitle" defaultValue={profile.preferences.jobTitle ?? ""} /></Field><Field label="Company"><Input name="company" defaultValue={profile.preferences.company ?? ""} /></Field></div></section><section className="border-b border-subtle pb-6"><SectionHeading title="Preferences" /><div className="mt-5 grid gap-4"><Field label="Timezone"><Input name="timezone" defaultValue={profile.preferences.timezone ?? ""} placeholder="UTC" /></Field><label className="grid gap-2 text-sm text-foreground"><span>Greeting style</span><Select value={greeting} onValueChange={setGreeting}><SelectTrigger aria-label="Greeting style"><SelectValue /></SelectTrigger><SelectContent>{greetings.map((value) => <SelectItem key={value} value={value}>{value[0]!.toUpperCase() + value.slice(1)}</SelectItem>)}</SelectContent></Select></label><Field label="Interests"><Input name="interests" defaultValue={profile.preferences.interests.join(", ")} placeholder="Design, engineering" /></Field></div></section><div className="flex justify-end"><Button type="submit" disabled={saving}><Save size={16} />{saving ? "Saving..." : "Save profile"}</Button></div></form> : null}
  </PageLayout>;
}
function SectionHeading({ title, description, icon: Icon }: { title: string; description?: string; icon?: typeof UserRound }) { return <div className="flex items-start gap-2"><>{Icon ? <Icon className="mt-0.5 size-4 text-icon-default" /> : null}</><div><h2 className="type-title">{title}</h2>{description ? <p className="mt-1 text-sm text-secondary">{description}</p> : null}</div></div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid gap-2 text-sm text-foreground"><span>{label}</span>{children}</label>; }
function IdentityMetadata({ label, value }: { label: string; value: string }) { return <div><dt className="type-caption text-tertiary">{label}</dt><dd className="mt-1 break-all text-foreground">{value}</dd></div>; }
function IdentityAvatar({ user, displayName }: { user: Profile["user"]; displayName: string | null }) { const [imageFailed,setImageFailed]=useState(false); useEffect(()=>setImageFailed(false),[user.pictureUrl]); const initials=(displayName||user.email).split(/\s+|@/).filter(Boolean).slice(0,2).map((part)=>part[0]!.toUpperCase()).join(""); return user.pictureUrl&&!imageFailed ? <img src={user.pictureUrl} alt="Profile avatar" className="size-12 rounded-full object-cover" referrerPolicy="no-referrer" onError={()=>setImageFailed(true)} /> : <span className="grid size-12 place-items-center rounded-full bg-surface-high text-sm font-medium text-foreground" aria-label="Profile initials">{initials}</span>; }
function text(form: FormData, name: string) { return String(form.get(name) || "").trim() || null; }
function profileReturnPath(): string { const value = new URLSearchParams(window.location.search).get("returnTo"); return value && !value.includes("\\") && value.startsWith("/workspaces/") ? value : "/"; }
function returnLabel(path: string): string { return path.includes("/projects/") ? "Back to project" : path.startsWith("/workspaces/") ? "Back to workspace" : "Back to workspaces"; }
