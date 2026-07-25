"use client";

import { ArrowLeft, Save, UserRound } from "lucide-react";
import { Banner, Button, Heading, Selector, Spinner, Text, TextArea, TextInput, useToast } from "@astryxdesign/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, notifyIdentityChanged, type Profile } from "../../lib/api/client";
import { workspaceReturnPath } from "../../lib/navigation/return-path";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { ConfirmationDialog } from "../ui/Dialog";
import {
  decodeProfileDraft,
  emptyProfileDraft,
  encodeProfileDraft,
  isProfileDraftDirty,
  parseProfileInterests,
  profileDraftFromProfile,
  profileDraftPatch,
  profileDraftStorageKey,
  profileGreetings,
  rebaseProfileDraft,
  unsetProfileGreeting,
  type ProfileDraft
} from "./profile-draft-state";

export function ProfilePage() {
  const router = useRouter();
  const showToast = useToast();
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const baselineRef = useRef<ProfileDraft>(emptyProfileDraft());
  const draftRef = useRef<ProfileDraft>(emptyProfileDraft());
  const loadedRef = useRef(false);
  const [profile, setProfile] = useState<Profile>();
  const [baseline, setBaseline] = useState<ProfileDraft>(() => emptyProfileDraft());
  const [draft, setDraft] = useState<ProfileDraft>(() => emptyProfileDraft());
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [returnTo, setReturnTo] = useState("/");
  const [leaveOpen, setLeaveOpen] = useState(false);
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setState("loading");
    try {
      const next = await apiClient.profile();
      if (!mounted.current || request !== loadRequest.current) return;
      const remote = profileDraftFromProfile(next);
      const stored = decodeProfileDraft(
        sessionStorage.getItem(profileDraftStorageKey(next.user.id)),
        { actorId: next.user.id, resourceId: "profile" }
      );
      const restored = stored ? rebaseProfileDraft(stored.baseline, stored.draft, remote) : null;
      const nextDraft = restored?.draft ?? remote;
      baselineRef.current = remote;
      draftRef.current = nextDraft;
      loadedRef.current = true;
      setProfile(next);
      setBaseline(remote);
      setDraft(nextDraft);
      if (restored?.conflicts.length) {
        setSaveError(`Your saved draft overlaps newer profile values. Conflicting fields: ${restored.conflicts.join(", ")}.`);
      }
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
  useEffect(() => {
    if (!profile || !loadedRef.current) return;
    const key = profileDraftStorageKey(profile.user.id);
    if (isProfileDraftDirty(baseline, draft)) {
      sessionStorage.setItem(key, encodeProfileDraft({ actorId: profile.user.id, resourceId: "profile", baseline, draft }));
    } else {
      sessionStorage.removeItem(key);
    }
  }, [baseline, draft, profile]);
  function replaceDraft(next: ProfileDraft) {
    draftRef.current = next;
    setDraft(next);
  }
  function updateDraft(field: keyof ProfileDraft, value: string) {
    replaceDraft({ ...draftRef.current, [field]: value });
  }
  const interests = parseProfileInterests(draft.interests);
  const interestsError = validateInterests(interests);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !dirty || interestsError) return;
    setSaveError("");
    setSaving(true);
    try {
      const saved = await apiClient.updateProfile(profileDraftPatch(baselineRef.current, draftRef.current, profile!.preferences.updatedAt));
      if (!mounted.current) return;
      const savedDraft = profileDraftFromProfile(saved);
      baselineRef.current = savedDraft;
      draftRef.current = savedDraft;
      setProfile(saved);
      setBaseline(savedDraft);
      setDraft(savedDraft);
      sessionStorage.removeItem(profileDraftStorageKey(saved.user.id));
      notifyIdentityChanged();
      showToast({ body: "Profile saved." });
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409 && reason.message === "Profile changed elsewhere. Reload and try again.") {
        const baselineBeforeRefresh = baselineRef.current;
        const draftBeforeRefresh = draftRef.current;
        try {
          const latest = await apiClient.profile();
          if (!mounted.current) return;
          const remote = profileDraftFromProfile(latest);
          const rebased = rebaseProfileDraft(baselineBeforeRefresh, draftBeforeRefresh, remote);
          baselineRef.current = remote;
          draftRef.current = rebased.draft;
          setProfile(latest);
          setBaseline(remote);
          setDraft(rebased.draft);
          setSaveError(rebased.conflicts.length > 0
            ? `Profile changed elsewhere. Your edits were kept. Conflicting fields: ${rebased.conflicts.join(", ")}.`
            : "Profile changed elsewhere. Your edits were rebased onto the latest profile.");
        } catch {
          if (mounted.current) setSaveError("Profile changed elsewhere, but the latest profile could not be loaded. Your edits were kept.");
        }
      } else if (mounted.current) setSaveError(reason instanceof Error ? reason.message : "Profile could not be saved.");
    } finally {
      if (mounted.current) setSaving(false);
    }
  }
  const dirty = profile ? isProfileDraftDirty(baseline, draft) : false;
  function discard() {
    replaceDraft(baselineRef.current);
    setSaveError("");
    if (profile) sessionStorage.removeItem(profileDraftStorageKey(profile.user.id));
  }
  function leave(event: MouseEvent<HTMLAnchorElement>) {
    if (!dirty) return;
    event.preventDefault();
    setLeaveOpen(true);
  }
  return <PageLayout contentWidth="narrow" header={<PageHeader title="Profile" subtitle="Your local product preferences. Identity is managed by your provider." actions={<Link href={returnTo} onClick={leave} className="inline-flex items-center gap-2 hover:text-primary"><ArrowLeft size={16} /><Text type="supporting" color="secondary">{returnLabel(returnTo)}</Text></Link>} />}>
    {state === "loading" ? <div className="flex min-h-48 items-center justify-center"><Spinner label="Loading profile..." /></div> : null}
    {state === "error" ? <Banner status="error" title="Profile unavailable" description="Your profile could not be loaded." endContent={<Button label="Try again" variant="secondary" onClick={() => void load()} />} /> : null}
    {state === "ready" && saveError ? <Banner className="mb-5" status="error" title="Profile could not be saved" description={saveError} /> : null}
      {state === "ready" && profile ? <form onSubmit={submit} className="space-y-8"><section className="border-y border-border py-5"><div className="flex items-center gap-4"><IdentityAvatar user={profile.user} displayName={profile.preferences.displayName} /><SectionHeading icon={UserRound} title="Identity" description="Managed by Keycloak." /></div><dl className="mt-5 grid gap-4 sm:grid-cols-2"><IdentityMetadata label="Email" value={profile.user.email} /><IdentityMetadata label="Email status" value={profile.user.emailVerified ? "Verified" : "Not verified"} /></dl></section><section className="border-b border-border pb-6"><SectionHeading title="Basic information" /><div className="mt-5 grid gap-4"><TextInput label="Display name" htmlName="displayName" value={draft.displayName} onChange={(value) => updateDraft("displayName", value.slice(0, 120))} isDisabled={saving} width="100%" /><TextArea label="Bio" htmlName="bio" value={draft.bio} onChange={(value) => updateDraft("bio", value.slice(0, 1000))} isDisabled={saving} rows={4} maxLength={1000} width="100%" /></div></section><section className="border-b border-border pb-6"><SectionHeading title="Work information" /><div className="mt-5 grid gap-4 sm:grid-cols-2"><TextInput label="Job title" htmlName="jobTitle" value={draft.jobTitle} onChange={(value) => updateDraft("jobTitle", value.slice(0, 120))} isDisabled={saving} width="100%" /><TextInput label="Company" htmlName="company" value={draft.company} onChange={(value) => updateDraft("company", value.slice(0, 120))} isDisabled={saving} width="100%" /></div></section><section className="border-b border-border pb-6"><SectionHeading title="Preferences" /><div className="mt-5 grid gap-4"><TextInput label="Timezone" htmlName="timezone" value={draft.timezone} onChange={(value) => updateDraft("timezone", value.slice(0, 120))} isDisabled={saving} placeholder="UTC" width="100%" /><Selector label="Greeting style" options={[{ value: unsetProfileGreeting, label: "Not set" }, ...profileGreetings.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))]} value={draft.greeting} onChange={(value) => updateDraft("greeting", value)} isDisabled={saving} size="lg" /><TextInput label="Interests" htmlName="interests" value={draft.interests} onChange={(value) => updateDraft("interests", value)} isDisabled={saving} placeholder="Design, engineering" {...(interestsError && { status: { type: "error", message: interestsError } as const })} width="100%" /></div></section><div className="flex justify-end gap-2">{dirty ? <Button label="Discard" variant="secondary" isDisabled={saving} onClick={discard} /> : null}<Button type="submit" label="Save profile" variant="primary" icon={<Save size={16} />} isDisabled={!dirty || Boolean(interestsError)} isLoading={saving} /></div></form> : null}
    <ConfirmationDialog isOpen={leaveOpen} onOpenChange={setLeaveOpen} title="Discard unsaved profile changes?" description={<Text as="p" display="block" color="secondary">Your profile edits have not been saved.</Text>} actionLabel="Discard changes" onAction={() => { discard(); router.push(returnTo); }} />
  </PageLayout>;
}
function SectionHeading({ title, description, icon: Icon }: { title: string; description?: string; icon?: typeof UserRound }) { return <div className="flex items-start gap-2">{Icon ? <Icon className="mt-0.5 size-4 text-icon-secondary" /> : null}<div><Heading level={3} accessibilityLevel={2}>{title}</Heading>{description ? <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">{description}</Text> : null}</div></div>; }
function IdentityMetadata({ label, value }: { label: string; value: string }) { return <div><dt><Text type="supporting" color="secondary">{label}</Text></dt><dd className="mt-1"><Text wordBreak="break-all">{value}</Text></dd></div>; }
function IdentityAvatar({ user, displayName }: { user: Profile["user"]; displayName: string | null }) { const [imageFailed,setImageFailed]=useState(false); useEffect(()=>setImageFailed(false),[user.pictureUrl]); const initials=(displayName||user.email).split(/\s+|@/).filter(Boolean).slice(0,2).map((part)=>part[0]!.toUpperCase()).join(""); return user.pictureUrl&&!imageFailed ? <img src={user.pictureUrl} alt="Profile avatar" className="size-12 rounded-full object-cover" referrerPolicy="no-referrer" onError={()=>setImageFailed(true)} /> : <span className="grid size-12 place-items-center rounded-full bg-muted text-primary" aria-label="Profile initials"><Text type="large" weight="medium">{initials}</Text></span>; }
function validateInterests(interests: string[]): string | null { if (interests.length > 20) return "Use no more than 20 interests."; if (interests.some((interest) => interest.length > 60)) return "Each interest must be 60 characters or less."; return null; }
function profileReturnPath(): string {
  const value = new URLSearchParams(window.location.search).get("returnTo");
  return workspaceReturnPath(value, window.location.pathname, "/profile");
}
function returnLabel(path: string): string { return path.includes("/projects/") ? "Back to project" : path.startsWith("/workspaces/") ? "Back to workspace" : "Back to workspaces"; }
