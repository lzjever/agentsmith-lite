"use client";

import { FilePlus2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiClient, type ContextContentType, type ContextEntry, type ContextList, type ContextScope } from "../../lib/api/client";
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

const contentTypes: ContextContentType[] = ["text", "json", "markdown", "yaml"];

type ScopeTab = { scope: ContextScope; label: string; description: string };

export function ContextManager({ workspaceId, projectId }: { workspaceId: string; projectId?: string }) {
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
  const loadVersion = useRef(0);
  const projectScope = scope === "project_shared" || scope === "project_personal";

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setState("loading");
    try {
      const next = await apiClient.contexts({ workspaceId, scope, ...(projectScope && projectId ? { projectId } : {}) });
      if (version !== loadVersion.current) return;
      setResult(next); setSelectedKey(next.items[0]?.contextKey); setError(""); setState("ready");
    } catch (reason) { if (version === loadVersion.current) { setError(message(reason)); setState("error"); } }
  }, [projectId, projectScope, scope, workspaceId]);

  useEffect(() => { setSelectedKey(undefined); setContextKey(""); setContent(""); setContentType("text"); void load(); }, [load]);
  const selected = useMemo(() => result?.items.find((entry) => entry.contextKey === selectedKey), [result, selectedKey]);
  useEffect(() => {
    if (selected) { setContextKey(selected.contextKey); setContent(selected.content); setContentType(selected.contentType); }
    else if (state === "ready") { setContextKey(""); setContent(""); setContentType("text"); }
  }, [selected, state]);

  function select(entry: ContextEntry) { setConflict(false); setError(""); setSelectedKey(entry.contextKey); setContextKey(entry.contextKey); setContent(entry.content); setContentType(entry.contentType); }
  function create() { setConflict(false); setError(""); setSelectedKey(undefined); setContextKey(""); setContent(""); setContentType("text"); }
  function revokeWriteAccess(reason: unknown) {
    if (!(reason instanceof ApiError) || reason.status !== 403) return false;
    setResult((current) => current ? { ...current, canWrite: false } : current);
    setDeleteOpen(false);
    setConflict(false);
    setError("Context write permission changed. This scope is now read-only.");
    return true;
  }
  async function save() {
    if (!result?.canWrite || !contextKey.trim() || saving) return;
    setSaving(true);
    try {
      const saved = await apiClient.saveContext({ workspaceId, scope, contextKey, content, contentType, ...(selected ? { previousContextKey: selected.contextKey, expectedVersion: selected.version } : {}), ...(projectScope && projectId ? { projectId } : {}) });
      setResult((current) => {
        if (!current) return current;
        const index = current.items.findIndex((entry) => entry.id === saved.id || entry.contextKey === selected?.contextKey);
        const items = [...current.items];
        if (index >= 0) items[index] = saved;
        else items.push(saved);
        return { ...current, items };
      });
      setSelectedKey(saved.contextKey); setConflict(false); setError(""); toast.success("Context saved");
    } catch (reason) { const accessRevoked = revokeWriteAccess(reason); const nextConflict = !accessRevoked && reason instanceof ApiError && reason.status === 409; if (!accessRevoked) { setConflict(nextConflict); setError(message(reason)); } toast.error(nextConflict ? "Context changed elsewhere" : "Context could not be saved"); } finally { setSaving(false); }
  }
  async function remove() {
    if (!result?.canWrite || !selected || deleting) return;
    setDeleting(true);
    try {
      await apiClient.deleteContext({ workspaceId, scope, contextKey: selected.contextKey, ...(projectScope && projectId ? { projectId } : {}) });
      const remaining = result.items.filter((entry) => entry.id !== selected.id);
      setResult({ ...result, items: remaining }); setSelectedKey(remaining[0]?.contextKey); setDeleteOpen(false); setError(""); toast.success("Context deleted");
    } catch (reason) { if (!revokeWriteAccess(reason)) setError(message(reason)); toast.error("Context could not be deleted"); } finally { setDeleting(false); }
  }

  return <PageLayout contentWidth="full" header={<PageHeader title="Context" subtitle="Saved instructions and reference data for this workspace and project." />}>
    <Tabs value={scope} onValueChange={(value) => setScope(value as ContextScope)}><TabsList aria-label="Context scope" className="mb-5 flex h-auto flex-wrap justify-start">{tabs.map((tab) => <TabsTrigger key={tab.scope} value={tab.scope} disabled={saving || deleting} onClick={() => setScope(tab.scope)}>{tab.label}</TabsTrigger>)}</TabsList>{tabs.map((tab) => <TabsContent key={tab.scope} value={tab.scope}><p className="mb-5 text-sm text-secondary">{tab.description}</p>{state === "loading" ? <PageState>Loading context...</PageState> : null}{state === "error" ? <PageState><div className="space-y-3"><p role="alert" className="text-error">{error}</p><Button onClick={() => void load()}>Try again</Button></div></PageState> : null}{state === "ready" && result ? <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]"><section className="border-y border-border py-3 lg:border-y-0 lg:border-r lg:pr-5"><div className="mb-3 flex items-center justify-between"><h2 className="type-title">Entries</h2>{result.canWrite ? <Button size="icon" variant="quiet" aria-label="New context entry" title="New context entry" onClick={create}><FilePlus2 size={17} /></Button> : null}</div>{result.items.length === 0 ? <p className="py-4 text-sm text-secondary">No context entries yet.</p> : <div className="space-y-1">{result.items.map((entry) => <button key={entry.id} type="button" onClick={() => select(entry)} className={`w-full px-3 py-2 text-left text-sm ${selected?.id === entry.id ? "bg-surface text-foreground" : "text-secondary hover:bg-hover hover:text-foreground"}`}><span className="block truncate">{entry.contextKey}</span><span className="mt-1 block font-mono text-[10px] uppercase text-tertiary">{entry.contentType}</span></button>)}</div>}</section><section className="min-w-0"><div className="mb-4"><h2 className="type-title">{selected ? "Edit entry" : "New entry"}</h2>{!result.canWrite ? <p className="mt-1 text-sm text-secondary">Your access to this context is read-only.</p> : null}</div><div className="grid gap-4"><label className="grid gap-1.5 text-sm text-secondary">Key<Input value={contextKey} disabled={!result.canWrite} onChange={(event) => setContextKey(event.target.value)} placeholder="for example, project.conventions" /></label><div className="grid gap-1.5 text-sm text-secondary"><span>Content type</span><Select value={contentType} onValueChange={(value) => setContentType(value as ContextContentType)} disabled={!result.canWrite}><SelectTrigger aria-label="Content type"><SelectValue /></SelectTrigger><SelectContent>{contentTypes.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent></Select></div><label className="grid gap-1.5 text-sm text-secondary">Content<Textarea value={content} disabled={!result.canWrite} onChange={(event) => setContent(event.target.value)} className="min-h-64 font-mono" /></label>{error ? <div className="flex flex-wrap items-center gap-3 text-sm text-error" role="alert"><span>{error}</span>{conflict ? <Button size="sm" variant="outline" onClick={() => void load()}>Reload latest</Button> : null}</div> : null}<div className="flex flex-wrap gap-2">{result.canWrite ? <Button onClick={() => void save()} disabled={!contextKey.trim() || saving}>{saving ? "Saving..." : "Save"}</Button> : null}{result.canWrite && selected ? <Button variant="danger" onClick={() => setDeleteOpen(true)} disabled={deleting}><Trash2 size={16} />Delete</Button> : null}</div></div></section></div> : null}</TabsContent>)}</Tabs>
    <ConfirmationDialog open={deleteOpen} onOpenChange={setDeleteOpen} title="Delete context entry" description={selected ? `Delete ${selected.contextKey}? This cannot be undone.` : ""} confirmText={deleting ? "Deleting" : "Delete entry"} confirmDisabled={!selected || deleting} onConfirm={remove} errorContext="Context entry could not be deleted" />
  </PageLayout>;
}

function message(error: unknown): string { return error instanceof ApiError ? error.message : "Context could not be loaded."; }
