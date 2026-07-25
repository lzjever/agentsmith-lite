"use client";
import { RefreshCw, Save, SlidersHorizontal } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  apiClient,
  isReadOnlyMutationError,
  type Endpoint,
  type ProjectCapabilities,
  type ProjectPolicyInput,
  type ProjectResourcePolicy,
} from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { Banner, Button, EmptyState, Heading, IconButton, NumberInput, Selector, Spinner, Text, useToast } from "@astryxdesign/core";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { EndpointPicker } from "../providers/ProviderDirectoryPicker";

type EndpointWindow = NonNullable<ProjectPolicyInput["endpointWindows"]>[number];
type PolicyDraft = Omit<Required<ProjectPolicyInput>, "activeTasksLimit"> & { activeTasksLimit: number | null };

const MEBIBYTE = 1024 * 1024;
const limits = [
  { key: "activeTasksLimit", label: "Active tasks", step: 1, units: "tasks", isIntegerOnly: true, required: true },
  { key: "providerRequestsLimit", label: "Provider requests", step: 1, units: "requests", isIntegerOnly: true, required: false },
  { key: "providerTokensLimit", label: "Provider tokens", step: 1, units: "tokens", isIntegerOnly: true, required: false },
  { key: "providerCostLimit", label: "Provider cost", step: 0.000001, units: "USD", isIntegerOnly: false, required: false },
  { key: "projectFileBytesLimit", label: "Project file storage", step: 0.000001, units: "MiB", isIntegerOnly: false, required: false },
] as const;
const endpointMetrics = [
  { value: "providerRequests", label: "Requests", step: 1, units: "requests", isIntegerOnly: true },
  { value: "providerTokens", label: "Tokens", step: 1, units: "tokens", isIntegerOnly: true },
  { value: "providerCost", label: "Cost", step: 0.000001, units: "USD", isIntegerOnly: false },
] as const;
const endpointWindowOptions = [
  { value: 3600, label: "1 hour" },
  { value: 86400, label: "24 hours" },
  { value: 604800, label: "7 days" },
] as const;
export function ResourcePolicyPage({ projectId }: { projectId: string }) {
  return <ProjectResourcePolicyPage key={projectId} projectId={projectId} />;
}

function ProjectResourcePolicyPage({ projectId }: { projectId: string }) {
  const mutationKeys = useMutationKeys();
  const showToast = useToast();
  const active = useRef(true);
  const loadRequest = useRef(0);
  const [policy, setPolicy] = useState<ProjectResourcePolicy>();
  const [selectedEndpoint,setSelectedEndpoint]=useState<Endpoint>();
  const [caps, setCaps] = useState<ProjectCapabilities>();
  const [draft, setDraft] = useState<PolicyDraft>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [capabilitiesError, setCapabilitiesError] = useState("");
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setState("loading");
    setError("");
    setCaps(undefined);
    setCapabilitiesError("");
    const [policyResult, capabilitiesResult] = await Promise.allSettled([
      apiClient.policy(projectId),
      apiClient.projectCapabilities(projectId),
    ]);
    if (!active.current || request !== loadRequest.current) return;
    if (policyResult.status === "rejected") {
      setError(
        policyResult.reason instanceof Error ? policyResult.reason.message : "Policy could not be loaded.",
      );
      setState("error");
      return;
    }
    setPolicy(policyResult.value);
    setDraft(policyDraft(policyResult.value));
    setSelectedEndpoint(undefined);
    if (capabilitiesResult.status === "fulfilled") {
      setCaps(capabilitiesResult.value);
    } else {
      setCapabilitiesError("Policy permissions could not be loaded. The policy is read-only until refreshed.");
    }
    setState("ready");
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  const canManage = caps?.canManagePolicy === true;
  const dirty = Boolean(policy && draft && !samePolicyDraft(draft, policyDraft(policy)));
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!policy || !draft || draft.activeTasksLimit === null || !dirty) return;
    const input = { ...policyPatch(draft, policyDraft(policy)), expectedUpdatedAt: policy.updatedAt };
    loadRequest.current += 1;
    setSaving(true);
    setError("");
    try {
      const saved = await apiClient.updatePolicy(projectId, input, mutationKeys.requestKey("project.policy.update", projectId, input));
      mutationKeys.complete("project.policy.update", projectId);
      if (!active.current) return;
      setPolicy(saved);
      setDraft(policyDraft(saved));
      showToast({ body: "Resource policy updated.", type: "info" });
    } catch (cause) {
      if (!active.current) return;
      if (cause instanceof ApiError) mutationKeys.complete("project.policy.update", projectId);
      if (cause instanceof ApiError && cause.status === 409 && cause.message === "Project policy changed elsewhere. Reload and try again.") {
        await load();
        if (active.current) setError("Resource policy changed elsewhere. Latest values loaded; review your changes before saving again.");
        return;
      }
      if (cause instanceof ApiError && cause.status === 403) {
        setPolicy(undefined);
        setDraft(undefined);
        setCaps(undefined);
        setState("loading");
        await load();
        return;
      }
      if (isReadOnlyMutationError(cause)) {
        setCaps((current) =>
          current ? { ...current, canManagePolicy: false } : current,
        );
      }
      setError(
        cause instanceof Error ? cause.message : "Policy could not be saved.",
      );
    } finally {
      if (active.current) setSaving(false);
    }
  }
  const configuredEndpointIds=[...new Set(draft?.endpointWindows.map((window)=>window.endpointId)??[])];
  if(selectedEndpoint&&!configuredEndpointIds.includes(selectedEndpoint.id))configuredEndpointIds.push(selectedEndpoint.id);
  const endpointLabels=new Map(policy?.endpointWindows.map((window)=>[window.endpointId,window.endpointName] as const)??[]);
  const policyEndpoints=configuredEndpointIds.map((id)=>selectedEndpoint?.id===id?selectedEndpoint:{id,name:endpointLabels.get(id)??`Endpoint ${id}`} as Pick<Endpoint,"id"|"name">);
  return (
    <PageLayout
      contentWidth="narrow"
      header={
        <PageHeader
          title="Resource policy"
          subtitle="Project-wide gauges and lifetime provider budgets, with per-user endpoint rolling windows."
          actions={
            <IconButton
              label="Refresh policy"
              tooltip="Refresh policy"
              variant="ghost"
              size="lg"
              icon={<RefreshCw size={16} />}
              isDisabled={saving}
              onClick={() => void load()}
            />
          }
        />
      }
    >
      {state === "loading" ? (
        <div className="grid min-h-64 place-items-center" role="status">
          <Spinner label="Loading policy..." />
        </div>
      ) : null}
      {state === "error" ? (
        <Banner
          status="error"
          title="Resource policy unavailable"
          description={error}
          endContent={<Button label="Try again" variant="ghost" onClick={() => void load()} />}
        />
      ) : null}
      {state === "ready" && policy && draft ? (
        <form onSubmit={save} className="space-y-6">
          {capabilitiesError ? (
            <Banner
              status="warning"
              title="Policy permissions unavailable"
              description={capabilitiesError}
            />
          ) : null}
          {!canManage ? (
            <div className="flex items-center gap-2">
              <SlidersHorizontal size={16} />
              <Text type="supporting" color="secondary">Read-only policy</Text>
            </div>
          ) : null}
          {error ? (
            <Banner
              status="error"
              title="Policy could not be saved"
              description={error}
            />
          ) : null}
          <section>
            <Heading level={2}>Project limits</Heading>
            <div className="mt-3 divide-y divide-border border-y border-border">
              {limits.map((limit) => (
                <div
                  className={canManage ? "py-2.5" : "grid gap-2 py-2.5 sm:grid-cols-[1fr_12rem] sm:items-center"}
                  key={limit.key}
                >
                  {canManage ? (
                    limit.required ? (
                      <NumberInput
                        label={limit.label}
                        value={policyInputValue(limit.key, draft[limit.key])}
                        onChange={(value) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  [limit.key]: policyInputNumber(limit.key, value),
                                }
                              : current,
                          )
                        }
                        min={0}
                        step={limit.step}
                        units={limit.units}
                        isIntegerOnly={limit.isIntegerOnly}
                        isRequired
                        isDisabled={saving}
                        htmlName={limit.key}
                        size="lg"
                        width="100%"
                      />
                    ) : (
                      <NumberInput
                        label={limit.label}
                        value={policyInputValue(limit.key, draft[limit.key])}
                        onChange={(value) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  [limit.key]: policyInputNumber(limit.key, value),
                                }
                              : current,
                          )
                        }
                        min={0}
                        step={limit.step}
                        units={limit.units}
                        isIntegerOnly={limit.isIntegerOnly}
                        isOptional
                        isDisabled={saving}
                        htmlName={limit.key}
                        placeholder="Unlimited"
                        hasClear
                        size="lg"
                        width="100%"
                      />
                    )
                  ) : (
                    <>
                      <Text>{limit.label}</Text>
                      <strong>{policyLimitValue(limit.key, policy[limit.key], limit.required)}</strong>
                    </>
                  )}
                </div>
              ))}
            </div>
          </section>
          <section>
            <Heading level={2}>Endpoint windows</Heading>
            <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">
              Each limit applies independently to every user over the selected rolling window.
            </Text>
            {canManage?<div className="mt-3"><EndpointPicker projectId={projectId} value={selectedEndpoint?.id??""} {...(selectedEndpoint?{selected:selectedEndpoint}:{})} disabled={saving} label="Add endpoint window" onChange={setSelectedEndpoint} onUnavailable={(id)=>setSelectedEndpoint((current)=>current?.id===id?undefined:current)}/></div>:null}
            {policyEndpoints.map((endpoint) => (
              <fieldset
                className="mt-4 border-t border-border pt-3"
                key={endpoint.id}
              >
                <legend><Text type="label" weight="medium">{endpoint.name}</Text></legend>
                {endpointMetrics.map((metric) => {
                  const current = draft.endpointWindows.find(
                    (item) =>
                      item.endpointId === endpoint.id &&
                      item.metric === metric.value,
                  );
                  return (
                    <div
                      className="mt-2 grid gap-2 sm:grid-cols-[1fr_10rem] sm:items-end"
                      key={metric.value}
                    >
                      {canManage ? (
                        <>
                          <NumberInput
                            label={`${metric.label} limit`}
                            value={current?.limit ?? null}
                            onChange={(value) =>
                              setDraft((draftValue) =>
                                draftValue
                                  ? updateEndpointLimit(
                                      draftValue,
                                      endpoint.id,
                                      metric.value,
                                      value,
                                    )
                                  : draftValue,
                              )
                            }
                            min={0}
                            step={metric.step}
                            units={metric.units}
                            isIntegerOnly={metric.isIntegerOnly}
                            isOptional
                            isDisabled={saving}
                            placeholder="Unlimited"
                            hasClear
                            size="lg"
                            width="100%"
                          />
                          <Selector
                            label={`${metric.label} window`}
                            options={[
                              { value: "", label: "No window", disabled: true },
                              ...(current && !endpointWindowOptions.some((option) => option.value === current.windowSeconds)
                                ? [{ value: String(current.windowSeconds), label: windowLabel(current.windowSeconds) }]
                                : []),
                              ...endpointWindowOptions.map((option) => ({ value: String(option.value), label: option.label })),
                            ]}
                            value={current ? String(current.windowSeconds) : ""}
                            onChange={(next) =>
                              setDraft((value) =>
                                value
                                  ? updateEndpointWindow(
                                      value,
                                      endpoint.id,
                                      metric.value,
                                      Number(next),
                                    )
                                  : value,
                              )
                            }
                            isDisabled={saving || !current}
                            size="lg"
                            className="w-full"
                          />
                        </>
                      ) : (
                        <>
                          <Text type="supporting" color="secondary">
                            {metric.label}
                          </Text>
                          <Text weight="semibold">
                            {current
                              ? `${current.limit} / ${windowLabel(current.windowSeconds)}`
                              : "Unlimited"}
                          </Text>
                        </>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            ))}
            {!policyEndpoints.length ? (
              <EmptyState className="mt-3" isCompact title="No endpoint windows configured" />
            ) : null}
          </section>
          {canManage ? (
            <div className="flex justify-end border-t border-border pt-4">
              <Button
                type="submit"
                label={saving ? "Saving..." : "Save policy"}
                variant="primary"
                size="lg"
                icon={<Save size={16} />}
                isDisabled={saving || !dirty || draft.activeTasksLimit === null}
              />
            </div>
          ) : null}
        </form>
      ) : null}
    </PageLayout>
  );
}
function windowLabel(seconds: number) {
  return seconds === 3600
    ? "1 hour"
    : seconds === 86400
      ? "24 hours"
      : seconds === 604800
        ? "7 days"
        : `${seconds} seconds`;
}

function policyDraft(policy: ProjectResourcePolicy): PolicyDraft {
  return {
    activeTasksLimit: policy.activeTasksLimit,
    providerRequestsLimit: policy.providerRequestsLimit,
    providerTokensLimit: policy.providerTokensLimit,
    providerCostLimit: policy.providerCostLimit,
    projectFileBytesLimit: policy.projectFileBytesLimit,
    endpointWindows: policy.endpointWindows ?? [],
  };
}

function samePolicyDraft(left: PolicyDraft, right: PolicyDraft): boolean {
  if (
    left.activeTasksLimit !== right.activeTasksLimit ||
    left.providerRequestsLimit !== right.providerRequestsLimit ||
    left.providerTokensLimit !== right.providerTokensLimit ||
    left.providerCostLimit !== right.providerCostLimit ||
    left.projectFileBytesLimit !== right.projectFileBytesLimit
  ) return false;
  return sameEndpointWindows(left.endpointWindows, right.endpointWindows);
}

function policyPatch(draft: PolicyDraft, original: PolicyDraft): ProjectPolicyInput {
  const input: ProjectPolicyInput = {};
  if (draft.activeTasksLimit !== original.activeTasksLimit && draft.activeTasksLimit !== null) input.activeTasksLimit = draft.activeTasksLimit;
  if (draft.providerRequestsLimit !== original.providerRequestsLimit) input.providerRequestsLimit = draft.providerRequestsLimit;
  if (draft.providerTokensLimit !== original.providerTokensLimit) input.providerTokensLimit = draft.providerTokensLimit;
  if (draft.providerCostLimit !== original.providerCostLimit) input.providerCostLimit = draft.providerCostLimit;
  if (draft.projectFileBytesLimit !== original.projectFileBytesLimit) input.projectFileBytesLimit = draft.projectFileBytesLimit;
  if (!sameEndpointWindows(draft.endpointWindows, original.endpointWindows)) input.endpointWindows = draft.endpointWindows;
  return input;
}

function sameEndpointWindows(left: EndpointWindow[], right: EndpointWindow[]): boolean {
  const ordered = (windows: EndpointWindow[]) => [...windows].sort((a, b) =>
    a.endpointId.localeCompare(b.endpointId) || a.metric.localeCompare(b.metric),
  );
  const leftWindows = ordered(left);
  const rightWindows = ordered(right);
  return leftWindows.length === rightWindows.length && leftWindows.every((window, index) => {
    const other = rightWindows[index];
    return other !== undefined && window.endpointId === other.endpointId && window.metric === other.metric && window.limit === other.limit && window.windowSeconds === other.windowSeconds;
  });
}

function policyInputValue(key:(typeof limits)[number]["key"],value:number|null):number|null{return value===null?null:key==="projectFileBytesLimit"?value/MEBIBYTE:value}
function policyInputNumber(key:(typeof limits)[number]["key"],value:number|null):number|null{return value===null?null:key==="projectFileBytesLimit"?Math.round(value*MEBIBYTE):value}
function policyLimitValue(key:(typeof limits)[number]["key"],value:number|null,required:boolean):string|number{if(value===null)return required?"Not configured":"Unlimited";if(key==="projectFileBytesLimit")return formatBytes(value);if(key==="providerCostLimit")return `$${value.toLocaleString(undefined,{maximumFractionDigits:6})}`;return value}
function formatBytes(value:number):string{if(value<1024)return `${value} B`;if(value<1024*1024)return `${(value/1024).toLocaleString(undefined,{maximumFractionDigits:2})} KiB`;return `${(value/MEBIBYTE).toLocaleString(undefined,{maximumFractionDigits:2})} MiB`}

function updateEndpointLimit(
  draft: PolicyDraft,
  endpointId: string,
  metric: EndpointWindow["metric"],
  limit: number | null,
): PolicyDraft {
  const current = draft.endpointWindows.find(
    (item) => item.endpointId === endpointId && item.metric === metric,
  );
  const remaining = draft.endpointWindows.filter(
    (item) => item.endpointId !== endpointId || item.metric !== metric,
  );
  if (limit === null) return { ...draft, endpointWindows: remaining };
  return {
    ...draft,
    endpointWindows: [
      ...remaining,
      {
        endpointId,
        metric,
        limit,
        windowSeconds: current?.windowSeconds ?? 3600,
      },
    ],
  };
}

function updateEndpointWindow(
  draft: PolicyDraft,
  endpointId: string,
  metric: EndpointWindow["metric"],
  windowSeconds: number,
): PolicyDraft {
  return {
    ...draft,
    endpointWindows: draft.endpointWindows.map((item) =>
      item.endpointId === endpointId && item.metric === metric
        ? { ...item, windowSeconds }
        : item,
    ),
  };
}
