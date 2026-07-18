"use client";

import { KeyRound, Plus, RefreshCw, Server } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type Endpoint, type EndpointInput, type ProjectCapabilities, type ProjectCredential } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
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
  const [actionProjectId, setActionProjectId] = useState<string>();
  const [formError, setFormError] = useState("");
  const discoveryRevision = useRef(0);
  const endpointsLoadRevision = useRef(0);
  const credentialsLoadRevision = useRef(0);
  const capabilitiesLoadRevision = useRef(0);
  const projectRevision = useRef(0);
  const currentProjectId = useRef(projectId);
  const mutationKeys = useMutationKeys();
  if (currentProjectId.current !== projectId) {
    currentProjectId.current = projectId;
    projectRevision.current += 1;
    mutationKeys.clear("endpoint.create");
    mutationKeys.clear("endpoint.update");
    mutationKeys.clear("endpoint.recheck");
    mutationKeys.clear("endpoint.delete");
  }

  const loadDependencies = useCallback(() => {
    const targetProjectId = projectId;
    const credentialsRevision = ++credentialsLoadRevision.current;
    setCredentialsState("loading");
    setCredentialsError("");
    void apiClient.credentials(projectId).then((listed) => {
      if (targetProjectId !== currentProjectId.current || credentialsRevision !== credentialsLoadRevision.current) return;
      setCredentials(listed);
      setInput((current) => current.credentialId && !listed.some((credential) => credential.id === current.credentialId)
        ? { ...current, credentialId: "", baseUrl: "" }
        : current);
      setCredentialsState("ready");
    }).catch((reason) => {
      if (targetProjectId !== currentProjectId.current || credentialsRevision !== credentialsLoadRevision.current) return;
      setCredentials([]);
      setCredentialsError(message(reason));
      setCredentialsState("error");
    });

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
    setState("loading");
    setError("");
    try {
      const listed = await apiClient.endpoints(projectId);
      if (targetProjectId !== currentProjectId.current || revision !== endpointsLoadRevision.current) return;
      setEndpoints(listed);
      setState("ready");
    } catch (reason) {
      if (targetProjectId !== currentProjectId.current || revision !== endpointsLoadRevision.current) return;
      setError(message(reason));
      setState("error");
    }
  }, [projectId]);

  useEffect(() => {
    invalidateDiscovery();
    setEditing(undefined);
    setDeleting(undefined);
    setCheckingId(undefined);
    setDialogOpen(false);
    setActionProjectId(undefined);
    setInput(emptyEndpointInput());
    setFormError("");
    setSaving(false);
    void load();
    loadDependencies();
  }, [load, loadDependencies]);

  const canManage = capabilitiesState === "ready" && capabilities?.canManageEndpoints === true;
  const canConfigure = canManage && credentialsState === "ready" && credentials.length > 0;
  const mutationBusy = saving || discovering || checkingId !== undefined;
  const nameConflict = endpoints.some((endpoint) => endpoint.id !== editing?.id && normalizeEndpointName(endpoint.name) === normalizeEndpointName(input.name));

  function invalidateDiscovery() {
    discoveryRevision.current += 1;
    setDiscovering(false);
    setModels([]);
  }

  function changeInput(value: EndpointInput) {
    invalidateDiscovery();
    setInput(value);
  }

  function create() {
    if (!canConfigure || mutationBusy) return;
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
    if (editing?.id === endpointId) {
      setDialogOpen(false);
      setActionProjectId(undefined);
      setEditing(undefined);
    }
    if (deleting?.id === endpointId) setDeleting(undefined);
    return true;
  }
  function refreshMissingCredential(reason: unknown) {
    if (!isMissing(reason, "Credential not found")) return false;
    loadDependencies();
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
      const saved = editing ? await apiClient.updateEndpoint(projectId, editing.id, input, mutationKeys.requestKey("endpoint.update", editing.id, input)) : await apiClient.createEndpoint(projectId, input, mutationKeys.requestKey("endpoint.create", projectId, input));
      mutationKeys.complete(editing ? "endpoint.update" : "endpoint.create", editing?.id ?? projectId);
      if (revision !== projectRevision.current) return;
      setEndpoints((items) => applyEndpointSave(items, saved, Boolean(editing)));
      setDialogOpen(false);
      setActionProjectId(undefined);
      toast.success(editing ? "Endpoint updated" : "Endpoint created");
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete(editing ? "endpoint.update" : "endpoint.create", editing?.id ?? projectId);
      if (revision !== projectRevision.current) return;
      if (editing && forgetMissingEndpoint(reason, editing.id)) {
        toast.error("Endpoint was removed elsewhere.");
        return;
      }
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
    try {
      const result = await apiClient.discoverEndpointModels(projectId, { baseUrl: input.baseUrl, credentialId: input.credentialId, requestTimeoutSecs: input.requestTimeoutSecs, ...(editing ? { endpointId: editing.id } : {}) });
      if (projectEpoch !== projectRevision.current || revision !== discoveryRevision.current) return;
      if (result.health.status !== "healthy") {
        setModels([]);
        setFormError(`Model discovery failed: ${result.health.errorCategory ?? "unknown"}`);
        return;
      }
      setModels(result.models);
      if (result.models.length === 0) toast.success("Connection checked. Enter a model name manually.");
      else if (!input.model) setInput((current) => ({ ...current, model: result.models[0]! }));
    } catch (reason) {
      if (projectEpoch !== projectRevision.current || revision !== discoveryRevision.current) return;
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
    setCheckingId(endpoint.id);
    try {
      const checked = await apiClient.recheckEndpoint(projectId, endpoint.id, mutationKeys.key("endpoint.recheck", endpoint.id));
      mutationKeys.complete("endpoint.recheck", endpoint.id);
      if (revision !== projectRevision.current) return;
      setEndpoints((items) => applyEndpointSave(items, checked, true));
      if (checked.health?.status === "healthy") toast.success("Endpoint is healthy");
      else toast.error(`Endpoint unavailable: ${checked.health?.errorCategory ?? "unknown"}`);
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("endpoint.recheck", endpoint.id);
      if (revision !== projectRevision.current) return;
      if (forgetMissingEndpoint(reason, endpoint.id)) {
        toast.error("Endpoint was removed elsewhere.");
        return;
      }
      toast.error(denied(reason));
    } finally {
      if (revision === projectRevision.current) setCheckingId(undefined);
    }
  }
  async function remove() {
    if (!deleting || !canManage || mutationBusy) return;
    const revision = projectRevision.current;
    setSaving(true);
    try {
      await apiClient.deleteEndpoint(projectId, deleting.id, mutationKeys.key("endpoint.delete", deleting.id));
      mutationKeys.complete("endpoint.delete", deleting.id);
      if (revision !== projectRevision.current) return;
      setEndpoints((items) => removeEndpoint(items, deleting.id));
      setDeleting(undefined);
      toast.success("Endpoint deleted");
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
    void load();
    loadDependencies();
  }

  const needsCredential = credentialsState === "ready" && credentials.length === 0;
  return <PageLayout header={<PageHeader title="Endpoints" subtitle="Manage OpenAI-compatible Chat Completions connections for this project." actions={<><Button variant="quiet" size="icon" aria-label="Refresh endpoints" title="Refresh endpoints" disabled={mutationBusy} onClick={refresh}><RefreshCw size={17} /></Button>{canConfigure ? <Button disabled={mutationBusy} onClick={create}><Plus size={16} />Create endpoint</Button> : null}</>} />}>
    {credentialsState === "error" ? <DependencyError message={`${credentialsError} Creating and editing endpoints is disabled until credentials can be loaded.`} /> : null}
    {capabilitiesError ? <DependencyError message={capabilitiesError} /> : null}
    {state === "loading" ? <PageState><span className="text-secondary">Loading endpoints...</span></PageState> : null}
    {state === "error" ? <PageState><div className="space-y-3"><h2 className="type-title">Endpoints unavailable</h2><p className="text-sm text-secondary">{error}</p><Button onClick={() => void load()}>Try again</Button></div></PageState> : null}
    {state === "ready" && endpoints.length === 0 ? <PageState><div className="max-w-sm space-y-3"><span className="mx-auto grid size-10 place-items-center rounded-md bg-surface-high text-icon-default">{needsCredential ? <KeyRound size={20} /> : <Server size={20} />}</span><h2 className="type-title">{needsCredential ? "Create a credential first" : "No endpoints configured"}</h2><p className="text-sm text-secondary">{needsCredential ? canManage ? "Endpoints require a project credential. Add one before configuring an OpenAI-compatible connection." : "Endpoints require a project credential. A project manager must add one before an endpoint can be configured." : canManage ? "Create an OpenAI-compatible endpoint before starting a chat or task." : "An administrator can add an endpoint before chat or task work begins."}</p>{needsCredential ? <CredentialsLink /> : canConfigure ? <Button onClick={create}><Plus size={16} />Create endpoint</Button> : null}</div></PageState> : null}
    {state === "ready" && endpoints.length > 0 ? <section className="space-y-4">{needsCredential ? <div className="flex flex-wrap items-center justify-between gap-3 border border-warning/30 bg-warning/10 px-3 py-3 text-sm text-warning"><span>{canManage ? "Create a project credential before adding or editing endpoints." : "No project credentials are available."}</span><CredentialsLink /></div> : null}<div className="flex flex-wrap items-center justify-between gap-3 border-y border-subtle py-3"><p className="type-caption text-tertiary">{endpointSummary(endpoints)}</p><p className="text-sm text-secondary">{canManage ? "Management enabled." : "Read-only access."}</p></div><EndpointsContent endpoints={endpoints} credentials={credentials} canManage={canManage} canEdit={canConfigure} busy={mutationBusy} checkingId={checkingId} onEdit={edit} onRecheck={recheck} onDelete={setDeleting} /></section> : null}
    <EndpointDialog open={dialogOpen && actionProjectId === projectId} input={input} editing={Boolean(editing)} saving={saving} discovering={discovering} models={models} canSubmit={canConfigure} canSave={(editing === undefined || endpointInputChanged(input, editing)) && !nameConflict} nameConflict={nameConflict} error={formError} credentials={credentials} onDiscoverModels={() => void discoverModels()} onDismissError={() => setFormError("")} onOpenChange={(open) => { setDialogOpen(open); if (!open) { mutationKeys.clear("endpoint.create"); setActionProjectId(undefined); invalidateDiscovery(); setFormError(""); } }} onChange={changeInput} onSubmit={save} />
    <DeleteEndpointDialog endpoint={deleting?.projectId === projectId ? deleting : undefined} deleting={saving} canConfirm={canManage} onOpenChange={(open) => { if (!open) setDeleting(undefined); }} onConfirm={remove} />
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
