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
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";
import { ErrorState } from "../ui/error-state";
import { Input } from "../ui/input";
import { PageLoading } from "../ui/loading";
import { toast } from "../ui/toast";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";

type EndpointWindow = NonNullable<ProjectPolicyInput["endpointWindows"]>[number];
type PolicyDraft = Omit<Required<ProjectPolicyInput>, "activeTasksLimit"> & { activeTasksLimit: number | null };

const limits = [
  { key: "activeTasksLimit", label: "Active tasks", step: "1", required: true },
  { key: "providerRequestsLimit", label: "Provider requests", step: "1", required: false },
  { key: "providerTokensLimit", label: "Provider tokens", step: "1", required: false },
  { key: "providerCostLimit", label: "Provider cost (USD)", step: "any", required: false },
  { key: "projectFileBytesLimit", label: "Project file storage (MiB)", step: "any", required: false },
] as const;
const endpointMetrics = [
  { value: "providerRequests", label: "Requests", step: "1" },
  { value: "providerTokens", label: "Tokens", step: "1" },
  { value: "providerCost", label: "Cost (USD)", step: "any" },
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
  const active = useRef(true);
  const loadRequest = useRef(0);
  const [policy, setPolicy] = useState<ProjectResourcePolicy>();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [caps, setCaps] = useState<ProjectCapabilities>();
  const [draft, setDraft] = useState<PolicyDraft>();
  const [endpointState, setEndpointState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [endpointError, setEndpointError] = useState("");
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
    setEndpointState("loading");
    setEndpointError("");
    const [policyResult, capabilitiesResult, endpointResult] = await Promise.allSettled([
      apiClient.policy(projectId),
      apiClient.projectCapabilities(projectId),
      apiClient.endpoints(projectId),
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
    if (capabilitiesResult.status === "fulfilled") {
      setCaps(capabilitiesResult.value);
    } else {
      setCapabilitiesError("Policy permissions could not be loaded. The policy is read-only until refreshed.");
    }
    if (endpointResult.status === "fulfilled") {
      setEndpoints(endpointResult.value);
      setEndpointState("ready");
    } else {
      setEndpoints([]);
      setEndpointError(endpointResult.reason instanceof Error ? endpointResult.reason.message : "Endpoints could not be loaded.");
      setEndpointState("error");
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
      toast.success("Resource policy updated.");
    } catch (cause) {
      if (!active.current) return;
      if (cause instanceof ApiError) mutationKeys.complete("project.policy.update", projectId);
      if (cause instanceof ApiError && cause.status === 409 && cause.message === "Project policy changed elsewhere. Reload and try again.") {
        await load();
        if (active.current) toast.error("Resource policy changed elsewhere. Latest values loaded.");
        return;
      }
      if (cause instanceof ApiError && cause.status === 403) {
        setPolicy(undefined);
        setDraft(undefined);
        setEndpoints([]);
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
  return (
    <PageLayout
      header={
        <PageHeader
          title="Resource policy"
          subtitle="Project-wide gauges and lifetime provider budgets, with per-user endpoint rolling windows."
          actions={
            <Button
              variant="quiet"
              size="icon"
              aria-label="Refresh policy"
              disabled={saving}
              onClick={() => void load()}
            >
              <RefreshCw size={16} />
            </Button>
          }
        />
      }
    >
      {state === "loading" ? (
        <PageState state="loading">
          <PageLoading />
        </PageState>
      ) : null}
      {state === "error" ? (
        <PageState state="error">
          <ErrorState
            title="Resource policy unavailable"
            message={error}
            onRetry={() => void load()}
          />
        </PageState>
      ) : null}
      {state === "ready" && policy && draft ? (
        <form onSubmit={save} className="space-y-7">
          {capabilitiesError ? (
            <p role="alert" className="border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
              {capabilitiesError}
            </p>
          ) : null}
          {!canManage ? (
            <p className="flex items-center gap-2 text-sm text-secondary">
              <SlidersHorizontal size={16} />
              Read-only policy
            </p>
          ) : null}
          {error ? (
            <p
              role="alert"
              className="border border-error/30 bg-error/10 px-3 py-2 text-sm text-error"
            >
              {error}
            </p>
          ) : null}
          <section>
            <h2 className="type-title">Project limits</h2>
            <div className="mt-3 divide-y divide-border border-y border-border">
              {limits.map((limit) => (
                <label
                  className="grid gap-2 py-3 sm:grid-cols-[1fr_12rem] sm:items-center"
                  key={limit.key}
                >
                  <span className="text-sm text-foreground">{limit.label}</span>
                  {canManage ? (
                    <Input
                      aria-label={limit.label}
                      name={limit.key}
                      type="number"
                      min="0"
                      step={limit.step}
                      required={limit.required}
                      disabled={saving}
                      value={policyInputValue(limit.key, draft[limit.key])}
                      placeholder={limit.required ? "Required" : "Unlimited"}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                [limit.key]: policyInputNumber(limit.key, event.target.value),
                              }
                            : current,
                        )
                      }
                    />
                  ) : (
                    <strong>{policyLimitValue(limit.key, policy[limit.key], limit.required)}</strong>
                  )}
                </label>
              ))}
            </div>
          </section>
          <section>
            <h2 className="type-title">Endpoint windows</h2>
            <p className="mt-1 text-sm text-secondary">
              Each limit applies independently to every user over the selected rolling window.
            </p>
            {endpointState === "error" ? (
              <div
                className="mt-3 flex flex-wrap items-center justify-between gap-3 border border-error/30 bg-error/10 px-3 py-2"
                role="alert"
              >
                <span className="text-sm text-error">
                  Endpoint windows could not be loaded: {endpointError}
                </span>
                <Button variant="quiet" size="sm" disabled={saving} onClick={() => void load()}>
                  <RefreshCw size={15} />
                  Retry
                </Button>
              </div>
            ) : null}
            {endpoints.map((endpoint) => (
              <fieldset
                className="mt-4 border-t border-border pt-3"
                key={endpoint.id}
              >
                <legend className="text-sm font-medium">{endpoint.name}</legend>
                {endpointMetrics.map((metric) => {
                  const current = draft.endpointWindows.find(
                    (item) =>
                      item.endpointId === endpoint.id &&
                      item.metric === metric.value,
                  );
                  return (
                    <div
                      className="mt-2 grid gap-2 sm:grid-cols-[1fr_10rem_10rem] sm:items-center"
                      key={metric.value}
                    >
                      <span className="text-sm text-secondary">
                        {metric.label}
                      </span>
                      {canManage ? (
                        <>
                          <Input
                            aria-label={`${endpoint.name} ${metric.label} limit`}
                            type="number"
                            min="0"
                            step={metric.step}
                            disabled={saving}
                            value={current?.limit ?? ""}
                            placeholder="Unlimited"
                            onChange={(event) =>
                              setDraft((value) =>
                                value
                                  ? updateEndpointLimit(
                                      value,
                                      endpoint.id,
                                      metric.value,
                                      event.target.value,
                                    )
                                  : value,
                              )
                            }
                          />
                          <select
                            aria-label={`${endpoint.name} ${metric.label} window`}
                            disabled={saving || !current}
                            value={current ? String(current.windowSeconds) : ""}
                            onChange={(event) =>
                              setDraft((value) =>
                                value
                                  ? updateEndpointWindow(
                                      value,
                                      endpoint.id,
                                      metric.value,
                                      Number(event.target.value),
                                    )
                                  : value,
                              )
                            }
                            className="h-9 border border-input bg-input px-2 text-sm"
                          >
                            <option value="" disabled>No window</option>
                            {current && !endpointWindowOptions.some((option) => option.value === current.windowSeconds) ? (
                              <option value={current.windowSeconds}>{windowLabel(current.windowSeconds)}</option>
                            ) : null}
                            {endpointWindowOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                          </select>
                        </>
                      ) : (
                        <strong className="text-sm">
                          {current
                            ? `${current.limit} / ${windowLabel(current.windowSeconds)}`
                            : "Unlimited"}
                        </strong>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            ))}
            {endpointState === "ready" && !endpoints.length ? (
              <p className="mt-3 text-sm text-secondary">
                No endpoints configured.
              </p>
            ) : null}
          </section>
          {canManage ? (
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={saving || !dirty || draft.activeTasksLimit === null}
              >
                <Save size={16} />
                {saving ? "Saving..." : "Save policy"}
              </Button>
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

function numberOrNull(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

const MEBIBYTE = 1024 * 1024;
function policyInputValue(key:(typeof limits)[number]["key"],value:number|null):number|string{return value===null?"":key==="projectFileBytesLimit"?value/MEBIBYTE:value}
function policyInputNumber(key:(typeof limits)[number]["key"],value:string):number|null{const parsed=numberOrNull(value);return parsed===null?null:key==="projectFileBytesLimit"?Math.round(parsed*MEBIBYTE):parsed}
function policyLimitValue(key:(typeof limits)[number]["key"],value:number|null,required:boolean):string|number{if(value===null)return required?"Not configured":"Unlimited";if(key==="projectFileBytesLimit")return formatBytes(value);if(key==="providerCostLimit")return `$${value.toLocaleString(undefined,{maximumFractionDigits:6})}`;return value}
function formatBytes(value:number):string{if(value<1024)return `${value} B`;if(value<1024*1024)return `${(value/1024).toLocaleString(undefined,{maximumFractionDigits:2})} KiB`;return `${(value/MEBIBYTE).toLocaleString(undefined,{maximumFractionDigits:2})} MiB`}

function updateEndpointLimit(
  draft: PolicyDraft,
  endpointId: string,
  metric: EndpointWindow["metric"],
  rawValue: string,
): PolicyDraft {
  const current = draft.endpointWindows.find(
    (item) => item.endpointId === endpointId && item.metric === metric,
  );
  const remaining = draft.endpointWindows.filter(
    (item) => item.endpointId !== endpointId || item.metric !== metric,
  );
  if (rawValue.trim() === "") return { ...draft, endpointWindows: remaining };
  return {
    ...draft,
    endpointWindows: [
      ...remaining,
      {
        endpointId,
        metric,
        limit: Number(rawValue),
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
