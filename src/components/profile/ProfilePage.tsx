"use client";

import { ArrowLeft, Save, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, notifyIdentityChanged, type Profile, type ProfileGreetingPreference } from "../../lib/api/client";
import { workspaceReturnPath } from "../../lib/navigation/return-path";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toast } from "../ui/toast";

const unsetGreeting = "unset" as const;
const greetings = ["formal", "casual", "friendly", "professional"] as const satisfies readonly ProfileGreetingPreference[];
type ProfileDraft = { displayName: string; timezone: string; bio: string; jobTitle: string; company: string; interests: string };

export function ProfilePage() {
  const router = useRouter();
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const [profile, setProfile] = useState<Profile>(); const [draft, setDraft] = useState<ProfileDraft>({ displayName: "", timezone: "", bio: "", jobTitle: "", company: "", interests: "" }); const [state, setState] = useState<"loading" | "ready" | "error">("loading"); const [saving, setSaving] = useState(false); const [greeting, setGreeting] = useState<ProfileGreetingPreference | typeof unsetGreeting>(unsetGreeting);
  const [returnTo, setReturnTo] = useState("/");
  const [leaveOpen, setLeaveOpen] = useState(false);
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setState("loading");
    try {
      const next = await apiClient.profile();
      if (!mounted.current || request !== loadRequest.current) return;
      setProfile(next);
      setDraft(profileDraft(next));
      setGreeting(profileGreeting(next));
      setState("ready");
    } catch {
      if (mounted.current && request === loadRequest.current) setState("error");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setReturnTo(profileReturnPath()); }, []);
  function updateDraft(field: keyof ProfileDraft, value: string) { setDraft((current) => ({ ...current, [field]: value })); }
  const interests = parseInterests(draft.interests);
  const interestsError = validateInterests(interests);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || interestsError) return;
    setSaving(true);
    try {
      const saved = await apiClient.updateProfile({ displayName: optionalText(draft.displayName), timezone: optionalText(draft.timezone), bio: optionalText(draft.bio), jobTitle: optionalText(draft.jobTitle), company: optionalText(draft.company), greetingPreference: greeting === unsetGreeting ? null : greeting, interests, expectedUpdatedAt: profile!.preferences.updatedAt });
      if (!mounted.current) return;
      setProfile(saved);
      setDraft(profileDraft(saved));
      setGreeting(profileGreeting(saved));
      notifyIdentityChanged();
      toast.success("Profile saved.");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409 && reason.message === "Profile changed elsewhere. Reload and try again.") {
        await load();
        if (mounted.current) toast.error("Profile changed elsewhere. Latest values loaded.");
      } else if (mounted.current) toast.error("Profile could not be saved.");
    } finally {
      if (mounted.current) setSaving(false);
    }
  }
  const dirty = profile ? !sameDraft(draft, profileDraft(profile)) || greeting !== profileGreeting(profile) : false;
  function leave(event: MouseEvent<HTMLAnchorElement>) {
    if (!dirty) return;
    event.preventDefault();
    setLeaveOpen(true);
  }
  return <PageLayout contentWidth="narrow" header={<PageHeader title="Profile" subtitle="Your local product preferences. Identity is managed by your provider." actions={<Link href={returnTo} onClick={leave} className="inline-flex items-center gap-2 text-sm text-secondary hover:text-foreground"><ArrowLeft size={16} />{returnLabel(returnTo)}</Link>} />}>
    {state === "loading" ? <PageState state="loading">Loading profile...</PageState> : null}{state === "error" ? <PageState state="error"><div><p>Profile unavailable.</p><Button className="mt-3" onClick={() => void load()}>Try again</Button></div></PageState> : null}
      {state === "ready" && profile ? <form onSubmit={submit} className="space-y-8"><section className="border-y border-subtle py-5"><div className="flex items-center gap-4"><IdentityAvatar user={profile.user} displayName={profile.preferences.displayName} /><SectionHeading icon={UserRound} title="Identity" description="Managed by Keycloak." /></div><dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2"><IdentityMetadata label="Email" value={profile.user.email} /><IdentityMetadata label="Email status" value={profile.user.emailVerified ? "Verified" : "Not verified"} /></dl></section><section className="border-b border-subtle pb-6"><SectionHeading title="Basic information" /><div className="mt-5 grid gap-4"><Field label="Display name"><Input name="displayName" value={draft.displayName} onChange={(event) => updateDraft("displayName", event.target.value)} disabled={saving} maxLength={120} /></Field><Field label="Bio"><Textarea name="bio" value={draft.bio} onChange={(event) => updateDraft("bio", event.target.value)} disabled={saving} rows={4} maxLength={1000} /></Field></div></section><section className="border-b border-subtle pb-6"><SectionHeading title="Work information" /><div className="mt-5 grid gap-4 sm:grid-cols-2"><Field label="Job title"><Input name="jobTitle" value={draft.jobTitle} onChange={(event) => updateDraft("jobTitle", event.target.value)} disabled={saving} maxLength={120} /></Field><Field label="Company"><Input name="company" value={draft.company} onChange={(event) => updateDraft("company", event.target.value)} disabled={saving} maxLength={120} /></Field></div></section><section className="border-b border-subtle pb-6"><SectionHeading title="Preferences" /><div className="mt-5 grid gap-4"><Field label="Timezone"><Input name="timezone" value={draft.timezone} onChange={(event) => updateDraft("timezone", event.target.value)} disabled={saving} placeholder="UTC" maxLength={120} /></Field><label className="grid gap-2 text-sm text-foreground"><span>Greeting style</span><Select value={greeting} onValueChange={(value) => setGreeting(value as ProfileGreetingPreference | typeof unsetGreeting)} disabled={saving}><SelectTrigger aria-label="Greeting style"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={unsetGreeting}>Not set</SelectItem>{greetings.map((value) => <SelectItem key={value} value={value}>{value[0]!.toUpperCase() + value.slice(1)}</SelectItem>)}</SelectContent></Select></label><Field label="Interests"><Input name="interests" value={draft.interests} onChange={(event) => updateDraft("interests", event.target.value)} disabled={saving} placeholder="Design, engineering" aria-invalid={Boolean(interestsError)} aria-describedby={interestsError ? "profile-interests-error" : undefined} />{interestsError ? <span id="profile-interests-error" role="alert" className="text-xs text-error">{interestsError}</span> : null}</Field></div></section><div className="flex justify-end"><Button type="submit" disabled={saving || !dirty || Boolean(interestsError)}><Save size={16} />{saving ? "Saving..." : "Save profile"}</Button></div></form> : null}
    <ConfirmationDialog open={leaveOpen} onOpenChange={setLeaveOpen} title="Discard unsaved profile changes?" description="Your profile edits have not been saved." confirmText="Discard changes" onConfirm={() => router.push(returnTo)} />
  </PageLayout>;
}
function SectionHeading({ title, description, icon: Icon }: { title: string; description?: string; icon?: typeof UserRound }) { return <div className="flex items-start gap-2"><>{Icon ? <Icon className="mt-0.5 size-4 text-icon-default" /> : null}</><div><h2 className="type-title">{title}</h2>{description ? <p className="mt-1 text-sm text-secondary">{description}</p> : null}</div></div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid gap-2 text-sm text-foreground"><span>{label}</span>{children}</label>; }
function IdentityMetadata({ label, value }: { label: string; value: string }) { return <div><dt className="type-caption text-tertiary">{label}</dt><dd className="mt-1 break-all text-foreground">{value}</dd></div>; }
function IdentityAvatar({ user, displayName }: { user: Profile["user"]; displayName: string | null }) { const [imageFailed,setImageFailed]=useState(false); useEffect(()=>setImageFailed(false),[user.pictureUrl]); const initials=(displayName||user.email).split(/\s+|@/).filter(Boolean).slice(0,2).map((part)=>part[0]!.toUpperCase()).join(""); return user.pictureUrl&&!imageFailed ? <img src={user.pictureUrl} alt="Profile avatar" className="size-12 rounded-full object-cover" referrerPolicy="no-referrer" onError={()=>setImageFailed(true)} /> : <span className="grid size-12 place-items-center rounded-full bg-surface-high text-sm font-medium text-foreground" aria-label="Profile initials">{initials}</span>; }
function optionalText(value: string) { return value.trim() || null; }
function parseInterests(value: string): string[] { return value.split(",").map((interest) => interest.trim()).filter(Boolean); }
function validateInterests(interests: string[]): string | null { if (interests.length > 20) return "Use no more than 20 interests."; if (interests.some((interest) => interest.length > 60)) return "Each interest must be 60 characters or less."; return null; }
function profileDraft(profile: Profile): ProfileDraft { return { displayName: profile.preferences.displayName ?? "", timezone: profile.preferences.timezone ?? "", bio: profile.preferences.bio ?? "", jobTitle: profile.preferences.jobTitle ?? "", company: profile.preferences.company ?? "", interests: profile.preferences.interests.join(", ") }; }
function sameDraft(left: ProfileDraft, right: ProfileDraft): boolean { return Object.keys(left).every((key) => left[key as keyof ProfileDraft] === right[key as keyof ProfileDraft]); }
function profileGreeting(profile: Profile): ProfileGreetingPreference | typeof unsetGreeting { return greetings.includes(profile.preferences.greetingPreference as ProfileGreetingPreference) ? profile.preferences.greetingPreference as ProfileGreetingPreference : unsetGreeting; }
function profileReturnPath(): string {
  const value = new URLSearchParams(window.location.search).get("returnTo");
  return workspaceReturnPath(value, window.location.pathname, "/profile");
}
function returnLabel(path: string): string { return path.includes("/projects/") ? "Back to project" : path.startsWith("/workspaces/") ? "Back to workspace" : "Back to workspaces"; }
