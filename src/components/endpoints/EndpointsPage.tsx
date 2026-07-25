"use client";

import {
  Banner,
  Button,
  Divider,
  EmptyState,
  IconButton,
  Spinner,
  Text,
  useToast,
} from "@astryxdesign/core";
import { Plus, RefreshCw, Server } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type Endpoint, type EndpointInput, type ProjectCapabilities } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { DeleteEndpointDialog } from "./DeleteEndpointDialog";
import { EndpointDialog } from "./EndpointDialog";
import { applyEndpointSave, emptyEndpointInput, endpointInputForEdit, removeEndpoint } from "./endpoints-page-utils";
import { EndpointsContent } from "./endpoints-page/EndpointsContent";
import { endpointLocationWithoutFocus } from "./endpoints-page/endpointFocus";

type LoadState = "loading" | "ready" | "error";

export function EndpointsPage({ projectId }: { workspaceId?: string; projectId: string }) {
  const router=useRouter();
  const pathname=usePathname();
  const routeSearchParams = useSearchParams();
  const focusedEndpointId =
    routeSearchParams?.get("endpointId") ??
    (typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("endpointId"));
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [focusedEndpoint,setFocusedEndpoint]=useState<Endpoint>();
  const [query,setQuery]=useState(""),[committedQuery,setCommittedQuery]=useState("");
  const [cursor,setCursor]=useState<string|undefined>(),[cursorHistory,setCursorHistory]=useState<Array<string|undefined>>([]);
  const [loadedCursor,setLoadedCursor]=useState<string|undefined>(),[loadedCursorHistory,setLoadedCursorHistory]=useState<Array<string|undefined>>([]);
  const [nextCursor,setNextCursor]=useState<string|null>(null),[total,setTotal]=useState(0),[refreshing,setRefreshing]=useState(false);
  const [capabilities, setCapabilities] = useState<ProjectCapabilities>();
  const [state, setState] = useState<LoadState>("loading");
  const [capabilitiesState, setCapabilitiesState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [capabilitiesError, setCapabilitiesError] = useState("");
  const [input, setInput] = useState<EndpointInput>(emptyEndpointInput());
  const [editing, setEditing] = useState<Endpoint>();
  const [deleting, setDeleting] = useState<Endpoint>();
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [checkingId, setCheckingId] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [actionProjectId, setActionProjectId] = useState<string>();
  const [formError, setFormError] = useState("");
  const [discoveryGuidance, setDiscoveryGuidance] = useState("");
  const [actionError, setActionError] = useState("");
  const discoveryRevision = useRef(0);
  const endpointsLoadRevision = useRef(0);
  const focusedLoadRevision=useRef(0);
  const capabilitiesLoadRevision = useRef(0);
  const projectRevision = useRef(0);
  const currentProjectId = useRef(projectId);
  const mutationKeys = useMutationKeys();
  const showToast = useToast();
  const hasEndpointContent=useRef(false);
  if (currentProjectId.current !== projectId) {
    currentProjectId.current = projectId;
    projectRevision.current += 1;
    mutationKeys.clear("endpoint.create");
    mutationKeys.clear("endpoint.update");
    mutationKeys.clear("endpoint.models");
    mutationKeys.clear("endpoint.recheck");
    mutationKeys.clear("endpoint.delete");
  }

  const loadDependencies = useCallback(() => {
    const targetProjectId = projectId;
    const capabilitiesRevision = ++capabilitiesLoadRevision.current;
    setCapabilitiesState("loading");
    setCapabilitiesError("");
    void apiClient.projectCapabilities(projectId).then((projected) => {
      if (targetProjectId !== currentProjectId.current || capabilitiesRevision !== capabilitiesLoadRevision.current) return;
      setCapabilities(projected);
      setCapabilitiesState("ready");
    }).catch((reason) => {
      if (targetProjectId !== currentProjectId.current || capabilitiesRevision !== capabilitiesLoadRevision.current) return;
      setCapabilities(undefined);
      setCapabilitiesError(`${message(reason)} Endpoint management is disabled until project permissions can be loaded.`);
      setCapabilitiesState("error");
    });
  }, [projectId]);

  const load = useCallback(async () => {
    const targetProjectId = projectId;
    const revision = ++endpointsLoadRevision.current;
    hasEndpointContent.current?setRefreshing(true):setState("loading");
    setError("");
    try {
      const listed = await apiClient.endpoints(projectId,{q:committedQuery,...(cursor!==undefined?{cursor}:{}),limit:20});
      if (targetProjectId !== currentProjectId.current || revision !== endpointsLoadRevision.current) return;
      setEndpoints(listed.items);setNextCursor(listed.nextCursor);setTotal(listed.total);
      setLoadedCursor(cursor);setLoadedCursorHistory(cursorHistory);
      hasEndpointContent.current=true;
      setState("ready");
    } catch (reason) {
      if (targetProjectId !== currentProjectId.current || revision !== endpointsLoadRevision.current) return;
      setError(message(reason));
      if(!hasEndpointContent.current)setState("error");
    }finally{
      if(targetProjectId===currentProjectId.current&&revision===endpointsLoadRevision.current)setRefreshing(false);
    }
  }, [committedQuery,cursor,cursorHistory,projectId]);

  useEffect(()=>{const timer=window.setTimeout(()=>{setCommittedQuery(query.trim());setCursorHistory([]);setCursor(undefined)},250);return()=>window.clearTimeout(timer)},[query]);
  useEffect(()=>{
    const revision=++focusedLoadRevision.current;
    if(!focusedEndpointId){setFocusedEndpoint(undefined);return}
    void apiClient.endpoint(projectId,focusedEndpointId).then((endpoint)=>{if(revision===focusedLoadRevision.current)setFocusedEndpoint(endpoint)}).catch(()=>{if(revision===focusedLoadRevision.current)setFocusedEndpoint(undefined)});
    return()=>{focusedLoadRevision.current+=1};
  },[focusedEndpointId,projectId]);

  useEffect(() => {
    invalidateDiscovery();
    setEditing(undefined);
    setDeleting(undefined);
    setCheckingId(undefined);
    setDialogOpen(false);
    setActionProjectId(undefined);
    setInput(emptyEndpointInput());
    setFormError("");
    setActionError("");
    setSaving(false);
    hasEndpointContent.current=false;
    setQuery("");setCommittedQuery("");setCursor(undefined);setCursorHistory([]);setLoadedCursor(undefined);setLoadedCursorHistory([]);setFocusedEndpoint(undefined);
    loadDependencies();
  }, [loadDependencies,projectId]);
  useEffect(()=>{void load()},[load]);

  const canManage = capabilitiesState === "ready" && capabilities?.canManageEndpoints === true;
  const canConfigure = canManage;
  const mutationBusy = saving || discovering || checkingId !== undefined;
  const nameConflict = endpoints.some((endpoint) => endpoint.id !== editing?.id && normalizeEndpointName(endpoint.name) === normalizeEndpointName(input.name));

  function invalidateDiscovery() {
    discoveryRevision.current += 1;
    setDiscovering(false);
    setModels([]);
    setDiscoveryGuidance("");
  }

  function changeInput(value: EndpointInput) {
    invalidateDiscovery();
    setInput(value);
  }

  function create() {
    if (!canConfigure || mutationBusy) return;
    setActionError("");
    invalidateDiscovery();
    setEditing(undefined);
    setInput(emptyEndpointInput());
    setFormError("");
    mutationKeys.clear("endpoint.create");
    setActionProjectId(projectId);
    setDialogOpen(true);
  }
  function edit(endpoint: Endpoint) {
    if (!canConfigure || mutationBusy) return;
    setActionError("");
    invalidateDiscovery();
    setEditing(endpoint);
    setInput(endpointInputForEdit(endpoint));
    setFormError("");
    mutationKeys.clear("endpoint.update");
    setActionProjectId(projectId);
    setDialogOpen(true);
  }
  function denied(reason: unknown) {
    if (isReadOnlyMutationError(reason)) {
      setDialogOpen(false);
      setActionProjectId(undefined);
      setEditing(undefined);
      setDeleting(undefined);
      if (reason.status === 403) {
        setEndpoints([]);
        setCapabilities(undefined);
        void load();
        loadDependencies();
      } else {
        setCapabilities((current) => current ? { ...current, canManageEndpoints: false } : current);
        setCapabilitiesError("Endpoint management access changed. Endpoints are now read-only. Refresh after access or lifecycle status changes.");
      }
    }
    return message(reason);
  }
  function forgetMissingEndpoint(reason: unknown, endpointId: string) {
    if (!isMissing(reason, "Endpoint not found")) return false;
    setEndpoints((items) => removeEndpoint(items, endpointId));
    clearEndpointFocus(endpointId);
    if (editing?.id === endpointId) {
      setDialogOpen(false);
      setActionProjectId(undefined);
      setEditing(undefined);
    }
    if (deleting?.id === endpointId) setDeleting(undefined);
    return true;
  }
  function refreshMissingCredential(reason: unknown) {
    return isMissing(reason, "Credential not found");
  }
  async function refreshStaleEndpoint(reason: unknown, endpointId: string) {
    if (!(reason instanceof ApiError && reason.status === 409 && reason.message === "Endpoint changed elsewhere. Reload and try again.")) return false;
    try {
      const latest = await apiClient.endpoint(projectId,endpointId);
      if (currentProjectId.current !== projectId) return true;
      setEndpoints((items)=>applyEndpointSave(items,latest,true));
      invalidateDiscovery();
      setEditing(latest);
      setInput(endpointInputForEdit(latest));
      setFormError("Endpoint changed elsewhere. Latest configuration loaded; review and apply your change again.");
    } catch(reason) {
      if(isMissing(reason,"Endpoint not found")){setDialogOpen(false);setActionProjectId(undefined);setEditing(undefined);setActionError("Endpoint was removed elsewhere. The endpoint list has been refreshed.");void resetPage();return true}
      setFormError("Endpoint changed elsewhere, and the latest configuration could not be loaded. Close this dialog and refresh endpoints.");
    }
    return true;
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canConfigure || mutationBusy || actionProjectId !== projectId || input.capabilities.length === 0 || nameConflict || (editing !== undefined && !endpointInputChanged(input, editing))) return;
    const revision = projectRevision.current;
    invalidateDiscovery();
    setSaving(true);
    setFormError("");
    try {
      const updateInput = editing ? { ...input, expectedUpdatedAt: editing.updatedAt } : undefined;
      const saved = editing && updateInput
        ? await apiClient.updateEndpoint(projectId, editing.id, updateInput, mutationKeys.requestKey("endpoint.update", editing.id, updateInput))
        : await apiClient.createEndpoint(projectId, input, mutationKeys.requestKey("endpoint.create", projectId, input));
      mutationKeys.complete(editing ? "endpoint.update" : "endpoint.create", editing?.id ?? projectId);
      if (revision !== projectRevision.current) return;
      setEndpoints((items) => applyEndpointSave(items, saved, Boolean(editing)));
      setDialogOpen(false);
      setActionProjectId(undefined);
      void resetPage();
      showToast({ body: editing ? "Endpoint updated" : "Endpoint created" });
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete(editing ? "endpoint.update" : "endpoint.create", editing?.id ?? projectId);
      if (revision !== projectRevision.current) return;
      if (editing && forgetMissingEndpoint(reason, editing.id)) {
        setActionError("Endpoint was removed elsewhere. Review the refreshed endpoint list.");
        return;
      }
      if (editing && await refreshStaleEndpoint(reason, editing.id)) return;
      refreshMissingCredential(reason);
      setFormError(denied(reason));
    } finally {
      if (revision === projectRevision.current) setSaving(false);
    }
  }
  async function discoverModels() {
    if (!canConfigure || mutationBusy) return;
    const projectEpoch = projectRevision.current;
    const revision = ++discoveryRevision.current;
    setDiscovering(true);
    setFormError("");
    setDiscoveryGuidance("");
    try {
      const request = { baseUrl: input.baseUrl, credentialId: input.credentialId, requestTimeoutSecs: input.requestTimeoutSecs, ...(editing ? { endpointId: editing.id } : {}) };
      const requestSlot = editing?.id ?? projectId;
      const result = await apiClient.discoverEndpointModels(projectId, request, mutationKeys.requestKey("endpoint.models", requestSlot, request));
      mutationKeys.complete("endpoint.models", requestSlot);
      if (projectEpoch !== projectRevision.current || revision !== discoveryRevision.current) return;
      if (result.health.status !== "healthy") {
        setModels([]);
        setFormError(`Model discovery failed: ${result.health.errorCategory ?? "unknown"}`);
        return;
      }
      setModels(result.models);
      if (result.models.length === 0) {
        setDiscoveryGuidance("Connection succeeded, but no models were returned. Enter a model name manually.");
      } else if (!input.model) {
        setInput((current) => ({ ...current, model: result.models[0]! }));
      }
    } catch (reason) {
      if (projectEpoch !== projectRevision.current || revision !== discoveryRevision.current) return;
      if (reason instanceof ApiError) mutationKeys.complete("endpoint.models", editing?.id ?? projectId);
      setModels([]);
      refreshMissingCredential(reason);
      setFormError(denied(reason));
    } finally {
      if (projectEpoch === projectRevision.current && revision === discoveryRevision.current) setDiscovering(false);
    }
  }
  async function recheck(endpoint: Endpoint) {
    if (!canManage || mutationBusy) return;
    const revision = projectRevision.current;
    setActionError("");
    setCheckingId(endpoint.id);
    try {
      const checked = await apiClient.recheckEndpoint(projectId, endpoint.id, mutationKeys.key("endpoint.recheck", endpoint.id));
      mutationKeys.complete("endpoint.recheck", endpoint.id);
      if (revision !== projectRevision.current) return;
      setEndpoints((items) => applyEndpointSave(items, checked, true));
      if (checked.health?.status === "healthy") {
        showToast({ body: "Endpoint is healthy" });
      } else {
        setActionError(`${endpoint.name} is unavailable: ${checked.health?.errorCategory ?? "unknown"}. Update its configuration or check it again.`);
      }
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("endpoint.recheck", endpoint.id);
      if (revision !== projectRevision.current) return;
      if (forgetMissingEndpoint(reason, endpoint.id)) {
        setActionError(`${endpoint.name} was removed elsewhere. The endpoint list has been updated.`);
        return;
      }
      setActionError(`${endpoint.name} could not be checked: ${denied(reason)}`);
    } finally {
      if (revision === projectRevision.current) setCheckingId(undefined);
    }
  }
  async function remove() {
    if (!deleting || !canManage || mutationBusy) return;
    const revision = projectRevision.current;
    setActionError("");
    setSaving(true);
    try {
      await apiClient.deleteEndpoint(projectId, deleting.id, mutationKeys.key("endpoint.delete", deleting.id));
      mutationKeys.complete("endpoint.delete", deleting.id);
      if (revision !== projectRevision.current) return;
      setEndpoints((items) => removeEndpoint(items, deleting.id));
      clearEndpointFocus(deleting.id);
      setDeleting(undefined);
      void resetPage();
      showToast({ body: "Endpoint deleted" });
    } catch (reason) {
      if (reason instanceof ApiError && deleting) mutationKeys.complete("endpoint.delete", deleting.id);
      if (revision !== projectRevision.current) return;
      if (forgetMissingEndpoint(reason, deleting.id)) return;
      throw new Error(denied(reason));
    } finally {
      if (revision === projectRevision.current) setSaving(false);
    }
  }

  function refresh() {
    if (mutationBusy) return;
    setActionError("");
    void load();
    loadDependencies();
  }
  function clearEndpointFocus(endpointId:string){
    if(focusedEndpointId!==endpointId)return;
    focusedLoadRevision.current+=1;
    setFocusedEndpoint(undefined);
    const search=routeSearchParams?.toString()??(typeof window==="undefined"?"":window.location.search.slice(1));
    router.replace(endpointLocationWithoutFocus(pathname,search,endpointId),{scroll:false});
  }
  async function resetPage(){setCursorHistory([]);setCursor(undefined);if(cursor===undefined)await load()}
  const visibleEndpoints=focusedEndpoint&&!endpoints.some((endpoint)=>endpoint.id===focusedEndpoint.id)?[focusedEndpoint,...endpoints]:endpoints;
  const emptyDescription=canManage?"Create an OpenAI-compatible endpoint before creating a task.":"An administrator can add an endpoint before task work begins.";

  return (
    <PageLayout
      header={
        <PageHeader
          title="Endpoints"
          subtitle="Manage OpenAI-compatible model connections for this project."
          actions={
            <>
              <IconButton
                label="Refresh endpoints"
                tooltip="Refresh endpoints"
                variant="ghost"
                icon={<RefreshCw size={17} />}
                isDisabled={mutationBusy}
                onClick={refresh}
              />
              {canConfigure ? (
                <Button
                  label="Create endpoint"
                  icon={<Plus size={16} />}
                  isDisabled={mutationBusy}
                  onClick={create}
                />
              ) : null}
            </>
          }
        />
      }
    >
      {capabilitiesError ? (
        <Banner
          status="warning"
          title="Endpoint permissions unavailable"
          description={capabilitiesError}
        />
      ) : null}
      {actionError ? (
        <Banner
          className="mb-4"
          status="error"
          title="Endpoint action could not be completed"
          description={actionError}
        />
      ) : null}
      {state === "loading" ? (
        <div
          className="flex min-h-48 items-center justify-center"
          data-testid="page-state__loading"
          data-page-state="loading"
        >
          <Spinner size="lg" label="Loading endpoints..." />
        </div>
      ) : null}
      {state === "error" ? (
        <EmptyState
          data-testid="page-state__error"
          data-page-state="error"
          title="Endpoints unavailable"
          description={error}
          actions={<Button label="Try again" onClick={() => void load()} />}
        />
      ) : null}
      {state === "ready" && total===0&&!query ? (
        <EmptyState
          data-testid="page-state__empty"
          data-page-state="empty"
          icon={<Server size={20} />}
          title="No endpoints configured"
          description={emptyDescription}
          actions={canConfigure ? (
            <Button
              label="Create endpoint"
              icon={<Plus size={16} />}
              onClick={create}
            />
          ) : undefined}
        />
      ) : null}
      {state === "ready" && (total>0||Boolean(query)) ? (
        <section className="space-y-4">
          {error ? (
            <Banner
              status="error"
              title="Endpoints could not be refreshed"
              description={error}
              endContent={<Button label="Retry" variant="ghost" onClick={() => void load()} />}
            />
          ) : null}
          <div>
            <Divider />
            <div className="flex flex-wrap items-center justify-between gap-3 py-3">
              <Text type="supporting">{total} {total===1?"endpoint":"endpoints"}</Text>
              <Text color="secondary">
                {canManage ? "Management enabled." : "Read-only access."}
              </Text>
            </div>
            <Divider />
          </div>
          <EndpointsContent
            endpoints={visibleEndpoints}
            query={query}
            refreshing={refreshing||Boolean(error)||query.trim()!==committedQuery}
            pageNumber={loadedCursorHistory.length+1}
            hasPrevious={loadedCursorHistory.length>0}
            hasNext={nextCursor!==null}
            focusedEndpointId={focusedEndpointId}
            canManage={canManage}
            canEdit={canConfigure}
            busy={mutationBusy}
            checkingId={checkingId}
            onEdit={edit}
            onRecheck={recheck}
            onDelete={setDeleting}
            onQueryChange={(value)=>{endpointsLoadRevision.current+=1;setQuery(value)}}
            onPrevious={()=>{setCursor(loadedCursorHistory.at(-1));setCursorHistory(loadedCursorHistory.slice(0,-1))}}
            onNext={()=>{if(nextCursor){setCursorHistory([...loadedCursorHistory,loadedCursor]);setCursor(nextCursor)}}}
          />
        </section>
      ) : null}
      <EndpointDialog
        open={dialogOpen && actionProjectId === projectId}
        input={input}
        editing={Boolean(editing)}
        saving={saving}
        discovering={discovering}
        models={models}
        discoveryGuidance={discoveryGuidance}
        canSubmit={canConfigure}
        canSave={(editing === undefined || endpointInputChanged(input, editing)) && !nameConflict}
        nameConflict={nameConflict}
        error={formError}
        projectId={projectId}
        onDiscoverModels={() => void discoverModels()}
        onDismissError={() => setFormError("")}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            mutationKeys.clear("endpoint.create");
            setActionProjectId(undefined);
            invalidateDiscovery();
            setFormError("");
          }
        }}
        onChange={changeInput}
        onSubmit={save}
      />
      <DeleteEndpointDialog
        endpoint={deleting?.projectId === projectId ? deleting : undefined}
        deleting={saving}
        canConfirm={canManage}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        onConfirm={remove}
      />
    </PageLayout>
  );
}

function message(error: unknown) {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : "The endpoint request could not be completed.";
}

function isMissing(error: unknown, detail: string) {
  return error instanceof ApiError && error.status === 404 && error.message === detail;
}

function endpointInputChanged(input: EndpointInput, endpoint: Endpoint): boolean {
  const original = endpointInputForEdit(endpoint);
  return input.name !== original.name ||
    input.baseUrl !== original.baseUrl ||
    input.model !== original.model ||
    input.credentialId !== original.credentialId ||
    input.requestTimeoutSecs !== original.requestTimeoutSecs ||
    [...input.capabilities].sort().join("\0") !== [...original.capabilities].sort().join("\0");
}

function normalizeEndpointName(name: string): string {
  return name.trim().toLocaleLowerCase("en-US");
}
