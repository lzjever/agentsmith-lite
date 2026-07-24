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
import { KeyRound, Plus, RefreshCw, Server } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type Endpoint, type EndpointInput, type ProjectCapabilities, type ProjectCredential } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { DeleteEndpointDialog } from "./DeleteEndpointDialog";
import { EndpointDialog } from "./EndpointDialog";
import { applyEndpointSave, emptyEndpointInput, endpointInputForEdit, endpointSummary, removeEndpoint } from "./endpoints-page-utils";
import { EndpointsContent } from "./endpoints-page/EndpointsContent";

type LoadState = "loading" | "ready" | "error";

export function EndpointsPage({ workspaceId, projectId }: { workspaceId?: string; projectId: string }) {
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
  const [discoveryGuidance, setDiscoveryGuidance] = useState("");
  const [actionError, setActionError] = useState("");
  const discoveryRevision = useRef(0);
  const endpointsLoadRevision = useRef(0);
  const credentialsLoadRevision = useRef(0);
  const capabilitiesLoadRevision = useRef(0);
  const projectRevision = useRef(0);
  const currentProjectId = useRef(projectId);
  const mutationKeys = useMutationKeys();
  const showToast = useToast();
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
    setActionError("");
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
  async function refreshStaleEndpoint(reason: unknown, endpointId: string) {
    if (!(reason instanceof ApiError && reason.status === 409 && reason.message === "Endpoint changed elsewhere. Reload and try again.")) return false;
    try {
      const listed = await apiClient.endpoints(projectId);
      if (currentProjectId.current !== projectId) return true;
      setEndpoints(listed);
      const latest = listed.find((endpoint) => endpoint.id === endpointId);
      if (!latest) {
        setDialogOpen(false);
        setActionProjectId(undefined);
        setEditing(undefined);
        setActionError("Endpoint was removed elsewhere. The endpoint list has been refreshed.");
        return true;
      }
      invalidateDiscovery();
      setEditing(latest);
      setInput(endpointInputForEdit(latest));
      setFormError("Endpoint changed elsewhere. Latest configuration loaded; review and apply your change again.");
    } catch {
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
      setDeleting(undefined);
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

  const needsCredential = credentialsState === "ready" && credentials.length === 0;
  const emptyDescription = needsCredential
    ? canManage
      ? "Endpoints require a project credential. Add one before configuring an OpenAI-compatible connection."
      : "Endpoints require a project credential. A project manager must add one before an endpoint can be configured."
    : canManage
      ? "Create an OpenAI-compatible endpoint before creating a task."
      : "An administrator can add an endpoint before task work begins.";

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
      {credentialsState === "error" ? (
        <Banner
          status="warning"
          title="Credentials unavailable"
          description={`${credentialsError} Creating and editing endpoints is disabled until credentials can be loaded.`}
        />
      ) : null}
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
      {state === "ready" && endpoints.length === 0 ? (
        <EmptyState
          data-testid="page-state__empty"
          data-page-state="empty"
          icon={needsCredential ? <KeyRound size={20} /> : <Server size={20} />}
          title={needsCredential ? "Create a credential first" : "No endpoints configured"}
          description={emptyDescription}
          actions={needsCredential ? (
            <CredentialsLink workspaceId={workspaceId} projectId={projectId} />
          ) : canConfigure ? (
            <Button
              label="Create endpoint"
              icon={<Plus size={16} />}
              onClick={create}
            />
          ) : undefined}
        />
      ) : null}
      {state === "ready" && endpoints.length > 0 ? (
        <section className="space-y-4">
          {needsCredential ? (
            <Banner
              status="warning"
              title="Project credentials required"
              description={canManage
                ? "Create a project credential before adding or editing endpoints."
                : "No project credentials are available."}
              endContent={<CredentialsLink workspaceId={workspaceId} projectId={projectId} />}
            />
          ) : null}
          <div>
            <Divider />
            <div className="flex flex-wrap items-center justify-between gap-3 py-3">
              <Text type="supporting">{endpointSummary(endpoints)}</Text>
              <Text color="secondary">
                {canManage ? "Management enabled." : "Read-only access."}
              </Text>
            </div>
            <Divider />
          </div>
          <EndpointsContent
            endpoints={endpoints}
            credentials={credentials}
            canManage={canManage}
            canEdit={canConfigure}
            busy={mutationBusy}
            checkingId={checkingId}
            onEdit={edit}
            onRecheck={recheck}
            onDelete={setDeleting}
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
        credentials={credentials}
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

function CredentialsLink({ workspaceId, projectId }: { workspaceId: string | undefined; projectId: string }) {
  const href = workspaceId ? `/workspaces/${workspaceId}/projects/${projectId}/credentials` : "../credentials";
  return (
    <Button
      label="Project credentials"
      href={href}
      variant="secondary"
      icon={<KeyRound size={15} />}
    />
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
