"use client";

import { FilePlus2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertDialog, Banner, Button, Dialog, DialogHeader, Heading, IconButton, Selector, Spinner, Tab, TabList, Text, TextArea, TextInput, useToast } from "@astryxdesign/core";
import { ApiError, apiClient, isReadOnlyMutationError, type ContextContentType, type ContextList, type ContextScope } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";

const contentTypes: ContextContentType[] = ["text", "json", "markdown", "yaml"];

type ScopeTab = { scope: ContextScope; label: string; description: string };
type PendingNavigation =
  | { kind: "scope"; scope: ContextScope }
  | { kind: "entry"; contextKey: string }
  | { kind: "new" };

export function ContextManager({ workspaceId, projectId }: { workspaceId: string; projectId?: string }) {
  return <ContextRouteManager key={`${workspaceId}:${projectId ?? "workspace"}`} workspaceId={workspaceId} {...(projectId ? { projectId } : {})} />;
}

function ContextRouteManager({ workspaceId, projectId }: { workspaceId: string; projectId?: string }) {
  const mutationKeys = useMutationKeys();
  const showToast = useToast();
  const mounted = useRef(true);
  const tabs: ScopeTab[] = projectId ? [
    { scope: "workspace_shared", label: "Workspace shared", description: "Available to members of this workspace." },
    { scope: "workspace_personal", label: "My workspace", description: "Only visible to you in this workspace." },
    { scope: "project_shared", label: "Project shared", description: "Available to members of this project." },
    { scope: "project_personal", label: "My project", description: "Only visible to you in this project." }
  ] : [
    { scope: "workspace_shared", label: "Workspace shared", description: "Available to members of this workspace." },
    { scope: "workspace_personal", label: "My workspace", description: "Only visible to you in this workspace." }
  ];
  const [scope, setScope] = useState<ContextScope>(tabs[0]!.scope);
  const [scopeReady, setScopeReady] = useState(false);
  const [result, setResult] = useState<ContextList>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [contextKey, setContextKey] = useState("");
  const [content, setContent] = useState("");
  const [contentType, setContentType] = useState<ContextContentType>("text");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation>();
  const loadVersion = useRef(0);
  const projectScope = scope === "project_shared" || scope === "project_personal";

  const load = useCallback(async (preserveDraft = false, preferredEntryId?: string): Promise<ContextList | null> => {
    const version = ++loadVersion.current;
    setState("loading");
    try {
      const next = await apiClient.contexts({ workspaceId, scope, ...(projectScope && projectId ? { projectId } : {}) });
      if (!mounted.current || version !== loadVersion.current) return null;
      const first = next.items.find((entry) => entry.id === preferredEntryId) ?? next.items[0];
      setResult(next);
      if (!preserveDraft) {
        setSelectedKey(first?.contextKey);
        setContextKey(first?.contextKey ?? "");
        setContent(first?.content ?? "");
        setContentType(first?.contentType ?? "text");
      }
      setError("");
      setState("ready");
      return next;
    } catch (reason) {
      if (!mounted.current || version !== loadVersion.current) return null;
      setError(message(reason, "Context could not be loaded."));
      setState("error");
      return null;
    }
  }, [projectId, projectScope, scope, workspaceId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("scope");
    const valid = tabs.some((tab) => tab.scope === requested);
    setScope(valid ? requested as ContextScope : tabs[0]!.scope);
    if (requested && !valid) replaceContextScope(tabs[0]!.scope, tabs[0]!.scope);
    setScopeReady(true);
  }, []);
  useEffect(() => { if (scopeReady) { setSelectedKey(undefined); setContextKey(""); setContent(""); setContentType("text"); void load(); } }, [load, scopeReady]);
  const selected = useMemo(() => result?.items.find((entry) => entry.contextKey === selectedKey), [result, selectedKey]);
  const activeTab = tabs.find((tab) => tab.scope === scope) ?? tabs[0]!;
  const normalizedContextKey = contextKey.trim();
  const dirty = result !== undefined && (selected
    ? normalizedContextKey !== selected.contextKey || content !== selected.content || contentType !== selected.contentType
    : normalizedContextKey.length > 0 || content.length > 0 || contentType !== "text");
  function applyNavigation(navigation: PendingNavigation) {
    setConflict(false);
    setError("");
    if (navigation.kind === "scope") {
      setResult(undefined);
      setSelectedKey(undefined);
      setContextKey("");
      setContent("");
      setContentType("text");
      setState("loading");
      replaceContextScope(navigation.scope, tabs[0]!.scope);
      setScope(navigation.scope);
      return;
    }
    if (navigation.kind === "new") {
      setSelectedKey(undefined);
      setContextKey("");
      setContent("");
      setContentType("text");
      return;
    }
    const entry = result?.items.find((item) => item.contextKey === navigation.contextKey);
    if (!entry) return;
    setSelectedKey(entry.contextKey);
    setContextKey(entry.contextKey);
    setContent(entry.content);
    setContentType(entry.contentType);
  }
  function navigate(navigation: PendingNavigation) {
    if (
      (navigation.kind === "scope" && navigation.scope === scope) ||
      (navigation.kind === "entry" && navigation.contextKey === selected?.contextKey) ||
      (navigation.kind === "new" && !selected)
    ) return;
    if (dirty) {
      setPendingNavigation(navigation);
      return;
    }
    applyNavigation(navigation);
  }
  async function revokeWriteAccess(reason: unknown) {
    if (!isReadOnlyMutationError(reason)) return false;
    setDeleteOpen(false);
    setConflict(false);
    mutationKeys.clear("context.save");
    mutationKeys.clear("context.delete");
    if (reason.status === 403) {
      setResult(undefined);
      const readable = await load(true);
      if (!mounted.current) return true;
      if (!readable) {
        setSelectedKey(undefined);
        setContextKey("");
        setContent("");
        setContentType("text");
        return true;
      }
    } else {
      setResult((current) => current ? { ...current, canWrite: false } : current);
    }
    setError("Context write access changed. This scope is now read-only.");
    return true;
  }
  async function save() {
    if (!result?.canWrite || !normalizedContextKey || saving || deleting) return;
    setSaving(true);
    const input = { workspaceId, scope, contextKey: normalizedContextKey, content, contentType, ...(selected ? { previousContextKey: selected.contextKey, expectedVersion: selected.version } : {}), ...(projectScope && projectId ? { projectId } : {}) };
    const identity = JSON.stringify(input);
    try {
      const saved = await apiClient.saveContext(input, mutationKeys.key("context.save", identity));
      mutationKeys.complete("context.save", identity);
      if (!mounted.current) return;
      setResult((current) => {
        if (!current) return current;
        const index = current.items.findIndex((entry) => entry.id === saved.id || entry.contextKey === selected?.contextKey);
        const items = [...current.items];
        if (index >= 0) items[index] = saved;
        else items.push(saved);
        return { ...current, items };
      });
      setSelectedKey(saved.contextKey); setContextKey(saved.contextKey); setContent(saved.content); setContentType(saved.contentType); setConflict(false); setError(""); showToast({ body: "Context saved" });
    } catch (reason) { if(reason instanceof ApiError)mutationKeys.complete("context.save",identity);if(!mounted.current)return;const accessRevoked = await revokeWriteAccess(reason); const nextConflict = !accessRevoked && reason instanceof ApiError && reason.code === "context_version_conflict"; if (!accessRevoked) { setConflict(nextConflict); setError(nextConflict ? "Context changed elsewhere. Reload the latest version before saving again." : message(reason, "Context could not be saved.")); } } finally { if(mounted.current)setSaving(false); }
  }
  async function remove() {
    if (!result?.canWrite || !selected || deleting || saving) return;
    setDeleting(true);
    setDeleteError("");
    const input = { workspaceId, scope, contextKey: selected.contextKey, expectedVersion: selected.version, ...(projectScope && projectId ? { projectId } : {}) };
    const identity = JSON.stringify(input);
    try {
      await apiClient.deleteContext(input, mutationKeys.key("context.delete", identity));
      mutationKeys.complete("context.delete", identity);
      if (!mounted.current) return;
      const remaining = result.items.filter((entry) => entry.id !== selected.id);
      const first = remaining[0];
      setResult({ ...result, items: remaining }); setSelectedKey(first?.contextKey); setContextKey(first?.contextKey ?? ""); setContent(first?.content ?? ""); setContentType(first?.contentType ?? "text"); setDeleteOpen(false); setDeleteError(""); setError(""); showToast({ body: "Context deleted" });
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("context.delete", identity);
      if (!mounted.current) return;
      if (await revokeWriteAccess(reason)) return;
      if (reason instanceof ApiError && reason.code === "context_version_conflict") {
        const latest = await load(false, selected.id);
        if (!mounted.current) return;
        setDeleteOpen(false);
        if (!latest?.items.some((entry) => entry.id === selected.id)) {
          setError("");
          return;
        }
        const detail = "Context changed elsewhere. Latest version loaded; review before deleting.";
        setError(detail);
        return;
      }
      if (reason instanceof ApiError && reason.status === 404 && reason.message === "Context entry not found") {
        const latest = await load();
        if (!mounted.current) return;
        if (latest && !latest.items.some((entry) => entry.id === selected.id || entry.contextKey === selected.contextKey)) {
          setDeleteOpen(false);
          setError("");
          return;
        }
      }
      const detail = message(reason, "Context could not be deleted.");
      setError(detail);
      setDeleteError(detail);
    } finally { if(mounted.current)setDeleting(false); }
  }

  return <PageLayout contentWidth="full" header={<PageHeader title="Context" subtitle={projectId ? "Saved instructions and reference data for this workspace and project." : "Saved instructions and reference data for this workspace."} />}>
    <TabList value={scope} onChange={(value) => { if (!saving && !deleting) navigate({ kind: "scope", scope: value as ContextScope }); }} aria-label="Context scope" className="mb-5 flex h-auto flex-wrap justify-start">{tabs.map((tab) => <Tab key={tab.scope} value={tab.scope} label={tab.label} aria-disabled={saving || deleting} />)}</TabList>
    <Text as="p" color="secondary" display="block" className="mb-5">{activeTab.description}</Text>
    {state === "loading" ? <div className="flex min-h-48 items-center justify-center"><Spinner label="Loading context..." /></div> : null}
    {state === "error" ? <Banner status="error" title="Context unavailable" description={error} endContent={<Button label="Try again" size="lg" onClick={() => void load()} />} /> : null}
    {state === "ready" && result ? <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]"><section className="border-y border-border py-3 lg:border-y-0 lg:border-r lg:pr-5"><div className="mb-3 flex items-center justify-between"><Heading level={3}>Entries</Heading>{result.canWrite ? <IconButton label="New context entry" size="lg" variant="ghost" icon={<FilePlus2 size={17} />} isDisabled={saving || deleting} onClick={() => navigate({ kind: "new" })} /> : null}</div>{result.items.length === 0 ? <Text as="p" type="supporting" color="secondary" display="block" className="py-4">No context entries yet.</Text> : <div className="space-y-1">{result.items.map((entry) => <button key={entry.id} type="button" disabled={saving || deleting} onClick={() => navigate({ kind: "entry", contextKey: entry.contextKey })} className={`w-full px-3 py-2 text-left disabled:cursor-not-allowed ${selected?.id === entry.id ? "bg-muted text-primary" : "text-secondary hover:bg-overlay-hover hover:text-primary"}`}><Text as="span" display="block" maxLines={1} color="inherit">{entry.contextKey}</Text><Text as="span" type="code" color="inherit" display="block" className="mt-1 capitalize">{entry.contentType}</Text></button>)}</div>}</section><section className="min-w-0"><div className="mb-4"><Heading level={3}>{selected ? "Edit entry" : "New entry"}</Heading>{!result.canWrite ? <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">Your access to this context is read-only.</Text> : null}</div><div className="grid gap-4"><TextInput label="Key" value={contextKey} isDisabled={!result.canWrite || saving || deleting} onChange={setContextKey} placeholder="for example, project.conventions" /><Selector label="Content type" options={contentTypes.map((type) => ({ value: type, label: type }))} value={contentType} onChange={(value) => setContentType(value as ContextContentType)} isDisabled={!result.canWrite || saving || deleting} size="lg" /><TextArea label="Content" value={content} isDisabled={!result.canWrite || saving || deleting} onChange={setContent} rows={14} className="min-h-64" width="100%" />{error ? <Banner status="error" title="Context update failed" description={error} endContent={conflict ? <Button label="Reload latest" size="md" variant="secondary" onClick={() => void load(false, selected?.id)} /> : undefined} /> : null}<div className="flex flex-wrap gap-2">{result.canWrite ? <Button label={saving ? "Saving..." : "Save"} size="lg" variant="primary" isDisabled={!dirty || saving || deleting} isLoading={saving} onClick={() => void save()} /> : null}{result.canWrite && selected ? <Button label="Delete" size="lg" variant="destructive" icon={<Trash2 size={16} />} isDisabled={saving || deleting} onClick={() => { setDeleteError(""); setDeleteOpen(true); }} /> : null}</div></div></section></div> : null}
    <AlertDialog isOpen={pendingNavigation !== undefined} onOpenChange={(open) => !open && setPendingNavigation(undefined)} title="Discard unsaved context changes?" description="Your edits have not been saved. Discard them and continue?" actionLabel="Discard changes" onAction={() => { if (pendingNavigation) applyNavigation(pendingNavigation); setPendingNavigation(undefined); }} />
    <Dialog isOpen={deleteOpen} onOpenChange={(open) => { if (deleting) return; setDeleteOpen(open); if (!open) setDeleteError(""); }} purpose="form" role="alertdialog" width="min(32rem, calc(100vw - 2rem))" padding={0} aria-label="Delete context entry"><DialogHeader title="Delete context entry" subtitle={selected ? `Delete ${selected.contextKey}? This cannot be undone.` : "This entry is no longer available."} onOpenChange={(open) => { if (!open && !deleting) setDeleteOpen(false); }} hasDivider />{deleteError ? <Banner className="mx-5 mt-4" status="error" title="Context entry could not be deleted" description={deleteError} /> : null}<footer className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end md:px-6"><Button label="Cancel" variant="ghost" size="lg" isDisabled={deleting} onClick={() => setDeleteOpen(false)} /><Button label={deleting ? "Deleting" : "Delete entry"} variant="destructive" size="lg" isDisabled={!selected || deleting} isLoading={deleting} onClick={() => void remove()} /></footer></Dialog>
  </PageLayout>;
}

function replaceContextScope(scope: ContextScope, defaultScope: ContextScope) {
  const url = new URL(window.location.href);
  if (scope === defaultScope) url.searchParams.delete("scope");
  else url.searchParams.set("scope", scope);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function message(error: unknown, fallback: string): string { return error instanceof ApiError ? error.message : fallback; }
