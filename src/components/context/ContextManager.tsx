"use client";

import { FilePlus2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type ContextContentType, type ContextList, type ContextScope } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Textarea } from "../ui/textarea";
import { toast } from "../ui/toast";
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
      setSelectedKey(saved.contextKey); setContextKey(saved.contextKey); setContent(saved.content); setContentType(saved.contentType); setConflict(false); setError(""); toast.success("Context saved");
    } catch (reason) { if(reason instanceof ApiError)mutationKeys.complete("context.save",identity);if(!mounted.current)return;const accessRevoked = await revokeWriteAccess(reason); const nextConflict = !accessRevoked && reason instanceof ApiError && reason.code === "context_version_conflict"; if (!accessRevoked) { setConflict(nextConflict); setError(message(reason, "Context could not be saved.")); } toast.error(nextConflict ? "Context changed elsewhere" : message(reason, "Context could not be saved")); } finally { if(mounted.current)setSaving(false); }
  }
  async function remove() {
    if (!result?.canWrite || !selected || deleting || saving) return;
    setDeleting(true);
    const input = { workspaceId, scope, contextKey: selected.contextKey, expectedVersion: selected.version, ...(projectScope && projectId ? { projectId } : {}) };
    const identity = JSON.stringify(input);
    try {
      await apiClient.deleteContext(input, mutationKeys.key("context.delete", identity));
      mutationKeys.complete("context.delete", identity);
      if (!mounted.current) return;
      const remaining = result.items.filter((entry) => entry.id !== selected.id);
      const first = remaining[0];
      setResult({ ...result, items: remaining }); setSelectedKey(first?.contextKey); setContextKey(first?.contextKey ?? ""); setContent(first?.content ?? ""); setContentType(first?.contentType ?? "text"); setDeleteOpen(false); setError(""); toast.success("Context deleted");
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("context.delete", identity);
      if (!mounted.current) return;
      if (await revokeWriteAccess(reason)) { toast.error("Context could not be deleted"); return; }
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
        toast.error(detail);
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
      throw new Error(detail);
    } finally { if(mounted.current)setDeleting(false); }
  }

  return <PageLayout contentWidth="full" header={<PageHeader title="Context" subtitle={projectId ? "Saved instructions and reference data for this workspace and project." : "Saved instructions and reference data for this workspace."} />}>
    <Tabs value={scope} onValueChange={(value) => navigate({ kind: "scope", scope: value as ContextScope })}><TabsList aria-label="Context scope" className="mb-5 flex h-auto flex-wrap justify-start">{tabs.map((tab) => <TabsTrigger key={tab.scope} value={tab.scope} disabled={saving || deleting} onClick={() => navigate({ kind: "scope", scope: tab.scope })}>{tab.label}</TabsTrigger>)}</TabsList>{tabs.map((tab) => <TabsContent key={tab.scope} value={tab.scope}><p className="mb-5 text-sm text-secondary">{tab.description}</p>{state === "loading" ? <PageState>Loading context...</PageState> : null}{state === "error" ? <PageState><div className="space-y-3"><p role="alert" className="text-error">{error}</p><Button onClick={() => void load()}>Try again</Button></div></PageState> : null}{state === "ready" && result ? <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]"><section className="border-y border-border py-3 lg:border-y-0 lg:border-r lg:pr-5"><div className="mb-3 flex items-center justify-between"><h2 className="type-title">Entries</h2>{result.canWrite ? <Button size="icon" variant="quiet" aria-label="New context entry" title="New context entry" disabled={saving || deleting} onClick={() => navigate({ kind: "new" })}><FilePlus2 size={17} /></Button> : null}</div>{result.items.length === 0 ? <p className="py-4 text-sm text-secondary">No context entries yet.</p> : <div className="space-y-1">{result.items.map((entry) => <button key={entry.id} type="button" disabled={saving || deleting} onClick={() => navigate({ kind: "entry", contextKey: entry.contextKey })} className={`w-full px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60 ${selected?.id === entry.id ? "bg-surface text-foreground" : "text-secondary hover:bg-hover hover:text-foreground"}`}><span className="block truncate">{entry.contextKey}</span><span className="mt-1 block font-mono text-[10px] uppercase text-tertiary">{entry.contentType}</span></button>)}</div>}</section><section className="min-w-0"><div className="mb-4"><h2 className="type-title">{selected ? "Edit entry" : "New entry"}</h2>{!result.canWrite ? <p className="mt-1 text-sm text-secondary">Your access to this context is read-only.</p> : null}</div><div className="grid gap-4"><label className="grid gap-1.5 text-sm text-secondary">Key<Input value={contextKey} disabled={!result.canWrite || saving || deleting} onChange={(event) => setContextKey(event.target.value)} placeholder="for example, project.conventions" /></label><div className="grid gap-1.5 text-sm text-secondary"><span>Content type</span><Select value={contentType} onValueChange={(value) => setContentType(value as ContextContentType)} disabled={!result.canWrite || saving || deleting}><SelectTrigger aria-label="Content type"><SelectValue /></SelectTrigger><SelectContent>{contentTypes.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent></Select></div><label className="grid gap-1.5 text-sm text-secondary">Content<Textarea value={content} disabled={!result.canWrite || saving || deleting} onChange={(event) => setContent(event.target.value)} className="min-h-64 font-mono" /></label>{error ? <div className="flex flex-wrap items-center gap-3 text-sm text-error" role="alert"><span>{error}</span>{conflict ? <Button size="sm" variant="outline" onClick={() => void load(false, selected?.id)}>Reload latest</Button> : null}</div> : null}<div className="flex flex-wrap gap-2">{result.canWrite ? <Button onClick={() => void save()} disabled={!dirty || saving || deleting}>{saving ? "Saving..." : "Save"}</Button> : null}{result.canWrite && selected ? <Button variant="danger" onClick={() => setDeleteOpen(true)} disabled={saving || deleting}><Trash2 size={16} />Delete</Button> : null}</div></div></section></div> : null}</TabsContent>)}</Tabs>
    <ConfirmationDialog open={pendingNavigation !== undefined} onOpenChange={(open) => !open && setPendingNavigation(undefined)} title="Discard unsaved context changes?" description="Your edits have not been saved. Discard them and continue?" confirmText="Discard changes" onConfirm={() => { if (pendingNavigation) applyNavigation(pendingNavigation); setPendingNavigation(undefined); }} errorContext="Context navigation failed" />
    <ConfirmationDialog open={deleteOpen} onOpenChange={setDeleteOpen} title="Delete context entry" description={selected ? `Delete ${selected.contextKey}? This cannot be undone.` : ""} confirmText={deleting ? "Deleting" : "Delete entry"} confirmDisabled={!selected || deleting} onConfirm={remove} errorContext="Context entry could not be deleted" />
  </PageLayout>;
}

function replaceContextScope(scope: ContextScope, defaultScope: ContextScope) {
  const url = new URL(window.location.href);
  if (scope === defaultScope) url.searchParams.delete("scope");
  else url.searchParams.set("scope", scope);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function message(error: unknown, fallback: string): string { return error instanceof ApiError ? error.message : fallback; }
