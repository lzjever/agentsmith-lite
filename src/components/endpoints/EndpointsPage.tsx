"use client";

import { KeyRound, Plus, RefreshCw, Server } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, apiClient, type Endpoint, type EndpointInput, type ProjectCapabilities, type ProjectCredential } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";
import { DeleteEndpointDialog } from "./DeleteEndpointDialog";
import { EndpointDialog } from "./EndpointDialog";
import { applyEndpointSave, emptyEndpointInput, endpointInputForEdit, endpointSummary, removeEndpoint } from "./endpoints-page-utils";
import { EndpointsContent } from "./endpoints-page/EndpointsContent";

type LoadState = "loading" | "ready" | "error";

export function EndpointsPage({ projectId }: { projectId: string }) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [credentials, setCredentials] = useState<ProjectCredential[]>([]);
  const [capabilities, setCapabilities] = useState<ProjectCapabilities>();
  const [state, setState] = useState<LoadState>("loading");
  const [credentialsState, setCredentialsState] = useState<LoadState>("loading");
  const [capabilitiesState, setCapabilitiesState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [credentialsError, setCredentialsError] = useState("");
  const [capabilitiesError, setCapabilitiesError] = useState("");
  const [input, setInput] = useState<EndpointInput>(emptyEndpointInput());
  const [editing, setEditing] = useState<Endpoint>();
  const [deleting, setDeleting] = useState<Endpoint>();
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [checkingId, setCheckingId] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formError, setFormError] = useState("");

  const loadDependencies = useCallback(() => {
    setCredentialsState("loading");
    setCredentialsError("");
    void apiClient.credentials(projectId).then((listed) => {
      setCredentials(listed);
      setCredentialsState("ready");
    }).catch((reason) => {
      setCredentials([]);
      setCredentialsError(message(reason));
      setCredentialsState("error");
    });

    setCapabilitiesState("loading");
    setCapabilitiesError("");
    void apiClient.projectCapabilities(projectId).then((projected) => {
      setCapabilities(projected);
      setCapabilitiesState("ready");
    }).catch((reason) => {
      setCapabilities(undefined);
      setCapabilitiesError(message(reason));
      setCapabilitiesState("error");
    });
  }, [projectId]);

  const load = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      setEndpoints(await apiClient.endpoints(projectId));
      setState("ready");
    } catch (reason) {
      setError(message(reason));
      setState("error");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    loadDependencies();
  }, [load, loadDependencies]);

  const canManage = capabilitiesState === "ready" && capabilities?.canManageEndpoints === true;
  const canConfigure = canManage && credentialsState === "ready" && credentials.length > 0;

  function create() {
    if (!canConfigure) return;
    setEditing(undefined);
    setInput(emptyEndpointInput());
    setModels([]);
    setFormError("");
    setDialogOpen(true);
  }
  function edit(endpoint: Endpoint) {
    if (!canConfigure) return;
    setEditing(endpoint);
    setInput(endpointInputForEdit(endpoint));
    setModels([]);
    setFormError("");
    setDialogOpen(true);
  }
  function denied(reason: unknown) {
    if (reason instanceof ApiError && reason.status === 403) {
      setCapabilities((current) => current ? { ...current, canManageEndpoints: false } : current);
    }
    return message(reason);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canConfigure || input.capabilities.length === 0) return;
    setSaving(true);
    setFormError("");
    try {
      const saved = editing ? await apiClient.updateEndpoint(projectId, editing.id, input) : await apiClient.createEndpoint(projectId, input);
      setEndpoints((items) => applyEndpointSave(items, saved, Boolean(editing)));
      setDialogOpen(false);
      toast.success(editing ? "Endpoint updated" : "Endpoint created");
    } catch (reason) {
      setFormError(denied(reason));
    } finally {
      setSaving(false);
    }
  }
  async function discoverModels() {
    if (!canConfigure) return;
    setDiscovering(true);
    setFormError("");
    try {
      const result = await apiClient.discoverEndpointModels(projectId, { baseUrl: input.baseUrl, credentialId: input.credentialId, requestTimeoutSecs: input.requestTimeoutSecs, ...(editing ? { endpointId: editing.id } : {}) });
      if (result.health.status !== "healthy") {
        setModels([]);
        setFormError(`Model discovery failed: ${result.health.errorCategory ?? "unknown"}`);
        return;
      }
      setModels(result.models);
      if (result.models.length === 0) toast.success("Connection checked. Enter a model name manually.");
      else if (!input.model) setInput((current) => ({ ...current, model: result.models[0]! }));
    } catch (reason) {
      setModels([]);
      setFormError(denied(reason));
    } finally {
      setDiscovering(false);
    }
  }
  async function recheck(endpoint: Endpoint) {
    if (!canManage) return;
    setCheckingId(endpoint.id);
    try {
      const checked = await apiClient.recheckEndpoint(projectId, endpoint.id);
      setEndpoints((items) => applyEndpointSave(items, checked, true));
      if (checked.health?.status === "healthy") toast.success("Endpoint is healthy");
      else toast.error(`Endpoint unavailable: ${checked.health?.errorCategory ?? "unknown"}`);
    } catch (reason) {
      toast.error(denied(reason));
    } finally {
      setCheckingId(undefined);
    }
  }
  async function remove() {
    if (!deleting || !canManage) return;
    setSaving(true);
    try {
      await apiClient.deleteEndpoint(projectId, deleting.id);
      setEndpoints((items) => removeEndpoint(items, deleting.id));
      setDeleting(undefined);
      toast.success("Endpoint deleted");
    } catch (reason) {
      throw new Error(denied(reason));
    } finally {
      setSaving(false);
    }
  }

  function refresh() {
    void load();
    loadDependencies();
  }

  const needsCredential = credentialsState === "ready" && credentials.length === 0;
  return <PageLayout header={<PageHeader title="Endpoints" subtitle="Manage OpenAI-compatible Chat Completions connections for this project." actions={<><Button variant="quiet" size="icon" aria-label="Refresh endpoints" title="Refresh endpoints" onClick={refresh}><RefreshCw size={17} /></Button>{canConfigure ? <Button onClick={create}><Plus size={16} />Create endpoint</Button> : null}</>} />}>
    {credentialsState === "error" ? <DependencyError message={`${credentialsError} Creating and editing endpoints is disabled until credentials can be loaded.`} /> : null}
    {capabilitiesState === "error" ? <DependencyError message={`${capabilitiesError} Endpoint management is disabled until project permissions can be loaded.`} /> : null}
    {state === "loading" ? <PageState><span className="text-secondary">Loading endpoints...</span></PageState> : null}
    {state === "error" ? <PageState><div className="space-y-3"><h2 className="type-title">Endpoints unavailable</h2><p className="text-sm text-secondary">{error}</p><Button onClick={() => void load()}>Try again</Button></div></PageState> : null}
    {state === "ready" && endpoints.length === 0 ? <PageState><div className="max-w-sm space-y-3"><span className="mx-auto grid size-10 place-items-center rounded-md bg-surface-high text-icon-default">{needsCredential ? <KeyRound size={20} /> : <Server size={20} />}</span><h2 className="type-title">{needsCredential ? "Create a credential first" : "No endpoints configured"}</h2><p className="text-sm text-secondary">{needsCredential ? canManage ? "Endpoints require a project credential. Add one before configuring an OpenAI-compatible connection." : "Endpoints require a project credential. A project manager must add one before an endpoint can be configured." : canManage ? "Create an OpenAI-compatible endpoint before starting a chat or task." : "An administrator can add an endpoint before chat or task work begins."}</p>{needsCredential ? <CredentialsLink /> : canConfigure ? <Button onClick={create}><Plus size={16} />Create endpoint</Button> : null}</div></PageState> : null}
    {state === "ready" && endpoints.length > 0 ? <section className="space-y-4">{needsCredential ? <div className="flex flex-wrap items-center justify-between gap-3 border border-warning/30 bg-warning/10 px-3 py-3 text-sm text-warning"><span>{canManage ? "Create a project credential before adding or editing endpoints." : "No project credentials are available."}</span><CredentialsLink /></div> : null}<div className="flex flex-wrap items-center justify-between gap-3 border-y border-subtle py-3"><p className="type-caption text-tertiary">{endpointSummary(endpoints)} · {endpoints.filter((endpoint) => endpoint.hasCredentialRef).length} configured</p><p className="text-sm text-secondary">{canManage ? "Management enabled." : "Read-only access."}</p></div><EndpointsContent endpoints={endpoints} canManage={canManage} canEdit={canConfigure} checkingId={checkingId} onEdit={edit} onRecheck={recheck} onDelete={setDeleting} /></section> : null}
    <EndpointDialog open={dialogOpen} input={input} editing={Boolean(editing)} saving={saving} discovering={discovering} models={models} canSubmit={canConfigure} error={formError} credentials={credentials} onDiscoverModels={() => void discoverModels()} onDismissError={() => setFormError("")} onOpenChange={(open) => { setDialogOpen(open); if (!open) setFormError(""); }} onChange={setInput} onSubmit={save} />
    <DeleteEndpointDialog endpoint={deleting} deleting={saving} canConfirm={canManage} onOpenChange={(open) => { if (!open) setDeleting(undefined); }} onConfirm={remove} />
  </PageLayout>;
}

function CredentialsLink() {
  return <Link href="credentials" className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border-input bg-surface px-3.5 text-[13px] text-primary hover:bg-hover hover:text-foreground"><KeyRound size={15} />Project credentials</Link>;
}

function DependencyError({ message: detail }: { message: string }) {
  return <div className="border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning" role="alert">{detail}</div>;
}

function message(error: unknown) {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : "The endpoint request could not be completed.";
}
