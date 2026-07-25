"use client";

import { FilePlus2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertDialog, Banner, Button, Dialog, DialogHeader, Heading, IconButton, Selector, Spinner, Tab, TabList, Text, TextArea, TextInput, useToast } from "@astryxdesign/core";
import { ApiError, apiClient, isReadOnlyMutationError, type ContextContentType, type ContextEntry, type ContextEntryMetadata, type ContextPage, type ContextScope } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";

const contentTypes: ContextContentType[] = ["text", "json", "markdown", "yaml"];

type ScopeTab = { scope: ContextScope; label: string; description: string };
type PendingNavigation =
  | { kind: "scope"; scope: ContextScope }
  | { kind: "entry"; entryId: string }
  | { kind: "new" };

export function ContextManager({ workspaceId, projectId }: { workspaceId: string; projectId?: string }) {
  return <ContextRouteManager key={`${workspaceId}:${projectId ?? "workspace"}`} workspaceId={workspaceId} {...(projectId ? { projectId } : {})} />;
}

function ContextRouteManager({ workspaceId, projectId }: { workspaceId: string; projectId?: string }) {
  const mutationKeys = useMutationKeys();
  const showToast = useToast();
  const mounted = useRef(true);
  const listVersion = useRef(0);
  const appendVersion = useRef(0);
  const detailVersion = useRef(0);
  const entriesHeadingRef = useRef<HTMLDivElement>(null);
  const deleteDescriptionId = useId();
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
  const [page, setPage] = useState<ContextPage>();
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [listError, setListError] = useState("");
  const [listRetry, setListRetry] = useState<"first" | "more">("first");
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [pinnedMetadata, setPinnedMetadata] = useState<ContextEntryMetadata>();
  const [detail, setDetail] = useState<ContextEntry>();
  const [detailState, setDetailState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [detailError, setDetailError] = useState("");
  const [contextKey, setContextKey] = useState("");
  const [content, setContent] = useState("");
  const [contentType, setContentType] = useState<ContextContentType>("text");
  const [mutationError, setMutationError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation>();
  const projectScope = scope === "project_shared" || scope === "project_personal";
  const target = useMemo(() => ({
    workspaceId,
    scope,
    ...(projectScope && projectId ? { projectId } : {})
  }), [projectId, projectScope, scope, workspaceId]);

  const resetDraft = useCallback(() => {
    setContextKey("");
    setContent("");
    setContentType("text");
  }, []);

  const loadDetail = useCallback(async (entryId: string, preserveDraft = false): Promise<ContextEntry | null> => {
    const version = ++detailVersion.current;
    setDetailState("loading");
    setDetailError("");
    try {
      const next = await apiClient.context(entryId, target);
      if (!mounted.current || version !== detailVersion.current) return null;
      setDetail(next);
      setSelectedId(next.id);
      setPinnedMetadata((current) => current?.id === next.id ? toMetadata(next) : current);
      if (!preserveDraft) {
        setContextKey(next.contextKey);
        setContent(next.content);
        setContentType(next.contentType);
      }
      setDetailState("ready");
      return next;
    } catch (reason) {
      if (!mounted.current || version !== detailVersion.current) return null;
      setDetailError(message(reason, "Context detail could not be loaded."));
      setDetailState("error");
      return null;
    }
  }, [target]);

  const loadFirstPage = useCallback(async (preserveDraft = false, preferredEntryId?: string): Promise<ContextPage | null> => {
    const version = ++listVersion.current;
    appendVersion.current += 1;
    setLoadingMore(false);
    setListState("loading");
    setListError("");
    setListRetry("first");
    try {
      const next = await apiClient.contexts(target);
      if (!mounted.current || version !== listVersion.current) return null;
      setPage(next);
      setListState("ready");
      if (!preserveDraft) {
        setPinnedMetadata(undefined);
        const first = next.items.find((entry) => entry.id === preferredEntryId) ?? next.items[0];
        if (first) {
          setSelectedId(first.id);
          setDetail(undefined);
          resetDraft();
          void loadDetail(first.id);
        } else {
          setSelectedId(undefined);
          setDetail(undefined);
          setDetailState("idle");
          setDetailError("");
          resetDraft();
        }
      }
      return next;
    } catch (reason) {
      if (!mounted.current || version !== listVersion.current) return null;
      setListError(message(reason, "Context could not be loaded."));
      setListState("error");
      return null;
    }
  }, [loadDetail, resetDraft, target]);

  const loadMore = useCallback(async () => {
    if (!page?.nextCursor || loadingMore || listState === "loading") return;
    const listGeneration = listVersion.current;
    const appendToken = ++appendVersion.current;
    setLoadingMore(true);
    setListError("");
    setListRetry("more");
    const cursor = page.nextCursor;
    try {
      const next = await apiClient.contexts({ ...target, cursor });
      if (!mounted.current || listGeneration !== listVersion.current || appendToken !== appendVersion.current) return;
      setPage((current) => {
        if (!current || current.nextCursor !== cursor) return current;
        const known = new Set(current.items.map((entry) => entry.id));
        return { ...next, items: [...current.items, ...next.items.filter((entry) => !known.has(entry.id))] };
      });
      setListState("ready");
    } catch (reason) {
      if (!mounted.current || listGeneration !== listVersion.current || appendToken !== appendVersion.current) return;
      setListError(message(reason, "More context entries could not be loaded."));
    } finally {
      if (mounted.current && listGeneration === listVersion.current && appendToken === appendVersion.current) setLoadingMore(false);
    }
  }, [listState, loadingMore, page, target]);

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

  useEffect(() => {
    if (!scopeReady) return;
    setPage(undefined);
    setListState("loading");
    setListError("");
    appendVersion.current += 1;
    setLoadingMore(false);
    setSelectedId(undefined);
    setPinnedMetadata(undefined);
    setDetail(undefined);
    setDetailState("idle");
    setDetailError("");
    resetDraft();
    void loadFirstPage();
  }, [loadFirstPage, resetDraft, scopeReady]);

  const selected = detail?.id === selectedId ? detail : undefined;
  const presentationItems = page
    ? pinnedMetadata
      ? [pinnedMetadata, ...page.items.filter((entry) => entry.id !== pinnedMetadata.id)]
      : page.items
    : [];
  const selectedMetadata = presentationItems.find((entry) => entry.id === selectedId);
  const activeTab = tabs.find((tab) => tab.scope === scope) ?? tabs[0]!;
  const normalizedContextKey = contextKey.trim();
  const detailLoading = detailState === "loading";
  const dirty = page !== undefined && (selected
    ? normalizedContextKey !== selected.contextKey || content !== selected.content || contentType !== selected.contentType
    : detailState !== "loading" && (normalizedContextKey.length > 0 || content.length > 0 || contentType !== "text"));

  function applyNavigation(navigation: PendingNavigation) {
    setConflict(false);
    setMutationError("");
    if (navigation.kind === "scope") {
      listVersion.current += 1;
      appendVersion.current += 1;
      detailVersion.current += 1;
      setLoadingMore(false);
      setPinnedMetadata(undefined);
      replaceContextScope(navigation.scope, tabs[0]!.scope);
      setScope(navigation.scope);
      return;
    }
    if (navigation.kind === "new") {
      detailVersion.current += 1;
      setSelectedId(undefined);
      setPinnedMetadata(undefined);
      setDetail(undefined);
      setDetailState("idle");
      setDetailError("");
      resetDraft();
      return;
    }
    detailVersion.current += 1;
    setSelectedId(navigation.entryId);
    setPinnedMetadata((current) => current?.id === navigation.entryId ? current : undefined);
    setDetail((current) => current?.id === navigation.entryId ? current : undefined);
    setDetailError("");
    resetDraft();
    void loadDetail(navigation.entryId);
  }

  function navigate(navigation: PendingNavigation) {
    if (
      (navigation.kind === "scope" && navigation.scope === scope) ||
      (navigation.kind === "entry" && navigation.entryId === selectedId) ||
      (navigation.kind === "new" && !selectedId)
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
    setPage((current) => current ? { ...current, canWrite: false } : current);
    if (reason.status === 403) {
      const refreshVersion = listVersion.current + 1;
      const readable = await loadFirstPage(true);
      if (!mounted.current || refreshVersion !== listVersion.current) return true;
      if (!readable) {
        appendVersion.current += 1;
        detailVersion.current += 1;
        setLoadingMore(false);
        setPage(undefined);
        setSelectedId(undefined);
        setPinnedMetadata(undefined);
        setDetail(undefined);
        setDetailState("idle");
        setDetailError("");
        setPendingNavigation(undefined);
        resetDraft();
        setMutationError("");
        return true;
      }
      setPage({ ...readable, canWrite: false });
    }
    if (!mounted.current) return true;
    setMutationError("Context write access changed. This scope is now read-only.");
    return true;
  }

  async function save() {
    if (!page?.canWrite || !normalizedContextKey || saving || deleting || detailLoading) return;
    setSaving(true);
    const input = {
      ...target,
      contextKey: normalizedContextKey,
      content,
      contentType,
      ...(selected ? { previousContextKey: selected.contextKey, expectedVersion: selected.version } : {})
    };
    const identity = JSON.stringify(input);
    try {
      const saved = await apiClient.saveContext(input, mutationKeys.key("context.save", identity));
      mutationKeys.complete("context.save", identity);
      if (!mounted.current) return;
      setDetail(saved);
      setSelectedId(saved.id);
      setDetailState("ready");
      setDetailError("");
      setContextKey(saved.contextKey);
      setContent(saved.content);
      setContentType(saved.contentType);
      setPinnedMetadata(toMetadata(saved));
      setConflict(false);
      setMutationError("");
      showToast({ body: "Context saved" });
      await loadFirstPage(true, saved.id);
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("context.save", identity);
      if (!mounted.current) return;
      const accessRevoked = await revokeWriteAccess(reason);
      const nextConflict = !accessRevoked && reason instanceof ApiError && reason.code === "context_version_conflict";
      if (!accessRevoked) {
        setConflict(nextConflict);
        setMutationError(nextConflict ? "Context changed elsewhere. Reload the latest version before saving again." : message(reason, "Context could not be saved."));
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  async function reloadAfterConflict() {
    if (!selectedId) return;
    const latest = await loadDetail(selectedId);
    if (!latest || !mounted.current) return;
    setConflict(false);
    setMutationError("");
  }

  async function remove() {
    if (!page?.canWrite || !selected || deleting || saving) return;
    setDeleting(true);
    setDeleteError("");
    const input = { ...target, contextKey: selected.contextKey, expectedVersion: selected.version };
    const identity = JSON.stringify(input);
    try {
      await apiClient.deleteContext(input, mutationKeys.key("context.delete", identity));
      mutationKeys.complete("context.delete", identity);
      if (!mounted.current) return;
      setDeleteOpen(false);
      setDeleteError("");
      setMutationError("");
      setSelectedId(undefined);
      setPinnedMetadata(undefined);
      setDetail(undefined);
      setDetailState("idle");
      resetDraft();
      showToast({ body: "Context deleted" });
      await loadFirstPage();
      requestAnimationFrame(() => entriesHeadingRef.current?.focus({ preventScroll: true }));
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("context.delete", identity);
      if (!mounted.current) return;
      if (await revokeWriteAccess(reason)) return;
      if (reason instanceof ApiError && reason.code === "context_version_conflict") {
        setDeleteOpen(false);
        const latest = await loadDetail(selected.id);
        if (!mounted.current) return;
        if (!latest) await loadFirstPage();
        setMutationError(latest ? "Context changed elsewhere. Latest version loaded; review before deleting." : "");
        return;
      }
      if (reason instanceof ApiError && reason.status === 404 && reason.message === "Context entry not found") {
        setDeleteOpen(false);
        setSelectedId(undefined);
        setPinnedMetadata(undefined);
        setDetail(undefined);
        resetDraft();
        await loadFirstPage();
        requestAnimationFrame(() => entriesHeadingRef.current?.focus({ preventScroll: true }));
        return;
      }
      const detailMessage = message(reason, "Context could not be deleted.");
      setMutationError(detailMessage);
      setDeleteError(detailMessage);
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }

  return <PageLayout contentWidth="full" header={<PageHeader title="Context" subtitle={projectId ? "Saved instructions and reference data for this workspace and project." : "Saved instructions and reference data for this workspace."} />}>
    <TabList value={scope} onChange={(value) => { if (!saving && !deleting) navigate({ kind: "scope", scope: value as ContextScope }); }} aria-label="Context scope" className="mb-5 flex h-auto flex-wrap justify-start">{tabs.map((tab) => <Tab key={tab.scope} value={tab.scope} label={tab.label} aria-disabled={saving || deleting} />)}</TabList>
    <Text as="p" color="secondary" display="block" className="mb-5">{activeTab.description}</Text>
    {listState === "loading" && !page ? <div className="flex min-h-48 items-center justify-center"><Spinner label="Loading context..." /></div> : null}
    {listState === "error" && !page ? <Banner status="error" title="Context unavailable" description={listError} endContent={<Button label="Try again" size="lg" onClick={() => void loadFirstPage()} />} /> : null}
    {page ? <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <section className="border-y border-border py-3 lg:border-y-0 lg:border-r lg:pr-5">
        <div ref={entriesHeadingRef} tabIndex={-1} className="mb-3 flex items-center justify-between outline-none"><Heading level={3} accessibilityLevel={2}>Entries</Heading>{page.canWrite ? <IconButton label="New context entry" size="lg" variant="ghost" icon={<FilePlus2 size={17} />} isDisabled={saving || deleting} onClick={() => navigate({ kind: "new" })} /> : null}</div>
        {listError ? <Banner status="error" title="Entries could not be refreshed" description={listError} endContent={<Button label="Try again" size="md" variant="secondary" onClick={() => void (listRetry === "more" ? loadMore() : loadFirstPage(true))} />} /> : null}
        {presentationItems.length === 0 ? <Text as="p" type="supporting" color="secondary" display="block" className="py-4">No context entries yet.</Text> : <div className="space-y-1">{presentationItems.map((entry) => <button key={entry.id} type="button" disabled={saving || deleting} onClick={() => navigate({ kind: "entry", entryId: entry.id })} className={`w-full px-3 py-2 text-left disabled:cursor-not-allowed ${selectedMetadata?.id === entry.id ? "bg-muted text-primary" : "text-secondary hover:bg-overlay-hover hover:text-primary"}`}><Text as="span" display="block" maxLines={1} color="inherit">{entry.contextKey}</Text><Text as="span" type="code" color="inherit" display="block" className="mt-1 capitalize">{entry.contentType}</Text></button>)}</div>}
        {page.nextCursor ? <Button label={loadingMore ? "Loading..." : "Load more"} size="md" variant="secondary" isDisabled={loadingMore || listState === "loading"} isLoading={loadingMore} onClick={() => void loadMore()} /> : null}
      </section>
      <section className="min-w-0">
        <div className="mb-4"><Heading level={3} accessibilityLevel={2}>{selectedId ? "Edit entry" : "New entry"}</Heading>{!page.canWrite ? <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">Your access to this context is read-only.</Text> : null}</div>
        {detailState === "loading" && !selected ? <div className="flex min-h-48 items-center justify-center"><Spinner label="Loading context detail..." /></div> : null}
        {detailError ? <Banner status="error" title="Context detail unavailable" description={detailError} endContent={selectedId ? <Button label="Try again" size="md" variant="secondary" onClick={() => void loadDetail(selectedId)} /> : undefined} /> : null}
        {selected || (!selectedId && detailState !== "loading") ? <div className="grid gap-4">
          <TextInput label="Key" value={contextKey} isDisabled={!page.canWrite || saving || deleting || detailLoading} onChange={setContextKey} placeholder="for example, project.conventions" />
          <Selector label="Content type" options={contentTypes.map((type) => ({ value: type, label: type }))} value={contentType} onChange={(value) => setContentType(value as ContextContentType)} isDisabled={!page.canWrite || saving || deleting || detailLoading} size="lg" />
          <TextArea label="Content" value={content} isDisabled={!page.canWrite || saving || deleting || detailLoading} onChange={setContent} rows={14} className="min-h-64" width="100%" />
          {mutationError ? <Banner status="error" title="Context update failed" description={mutationError} endContent={conflict && selectedId ? <Button label="Reload latest" size="md" variant="secondary" onClick={() => void reloadAfterConflict()} /> : undefined} /> : null}
          <div className="flex flex-wrap gap-2">{page.canWrite ? <Button label={saving ? "Saving..." : "Save"} size="lg" variant="primary" isDisabled={!dirty || saving || deleting || detailLoading} isLoading={saving} onClick={() => void save()} /> : null}{page.canWrite && selected ? <Button label="Delete" size="lg" variant="destructive" icon={<Trash2 size={16} />} isDisabled={saving || deleting || detailLoading} onClick={() => { setDeleteError(""); setDeleteOpen(true); }} /> : null}</div>
        </div> : null}
      </section>
    </div> : null}
    <AlertDialog className="[&_button]:min-h-11 [&_button]:min-w-11" isOpen={pendingNavigation !== undefined} onOpenChange={(open) => !open && setPendingNavigation(undefined)} title="Discard unsaved context changes?" description="Your edits have not been saved. Discard them and continue?" actionLabel="Discard changes" onAction={() => { if (pendingNavigation) applyNavigation(pendingNavigation); setPendingNavigation(undefined); }} width="min(32rem, calc(100dvw - 1rem))" />
    <Dialog
      className="[&_button]:min-h-11 [&_button]:min-w-11"
      isOpen={deleteOpen}
      onOpenChange={(open) => {
        if (deleting) return;
          setDeleteOpen(open);
          if (!open) setDeleteError("");
      }}
      role="alertdialog"
      purpose={deleting ? "required" : "form"}
      padding={0}
      width="min(32rem, calc(100dvw - 1rem))"
      maxHeight="calc(100dvh - 1rem)"
      aria-label="Delete context entry"
      aria-describedby={deleteDescriptionId}
    >
      <DialogHeader title="Delete context entry" hasDivider />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <Text id={deleteDescriptionId} as="p" display="block" color="secondary">{selected ? `Permanently delete ${selected.contextKey}? This cannot be undone.` : "This entry is no longer available."}</Text>
        <div className="mt-4">{deleteError ? <Banner status="error" title="Context entry could not be deleted" description={deleteError} /> : null}</div>
      </div>
      <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
        <Button data-autofocus="" label="Cancel" type="button" variant="ghost" size="lg" isDisabled={deleting} onClick={() => setDeleteOpen(false)} />
        <Button label={deleting ? "Deleting" : "Delete entry"} type="button" variant="destructive" size="lg" isDisabled={!selected || deleting} isLoading={deleting} onClick={() => { if (!deleting) void remove(); }} />
      </div>
    </Dialog>
  </PageLayout>;
}

function toMetadata(entry: ContextEntry): ContextEntryMetadata {
  const { content: _content, ...metadata } = entry;
  return metadata;
}

function replaceContextScope(scope: ContextScope, defaultScope: ContextScope) {
  const url = new URL(window.location.href);
  if (scope === defaultScope) url.searchParams.delete("scope");
  else url.searchParams.set("scope", scope);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function message(error: unknown, fallback: string): string { return error instanceof ApiError ? error.message : fallback; }
