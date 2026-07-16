"use client";
import { RefreshCw, Save, SlidersHorizontal } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  ApiError,
  apiClient,
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

type EndpointWindow = NonNullable<ProjectPolicyInput["endpointWindows"]>[number];
type PolicyDraft = Required<ProjectPolicyInput>;

const limits = [
  { key: "activeTasksLimit", label: "Active tasks", step: "1" },
  { key: "providerRequestsLimit", label: "Provider requests", step: "1" },
  { key: "providerTokensLimit", label: "Provider tokens", step: "1" },
  { key: "providerCostLimit", label: "Provider cost", step: "any" },
  { key: "projectFileBytesLimit", label: "Project file storage", step: "1" },
] as const;
const endpointMetrics = [
  { value: "providerRequests", label: "Requests", step: "1" },
  { value: "providerTokens", label: "Tokens", step: "1" },
  { value: "providerCost", label: "Cost", step: "any" },
] as const;
export function ResourcePolicyPage({ projectId }: { projectId: string }) {
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
  const load = useCallback(async () => {
    setState("loading");
    setError("");
    setEndpointState("loading");
    setEndpointError("");
    try {
      const [p, c, endpointResult] = await Promise.all([
        apiClient.policy(projectId),
        apiClient.projectCapabilities(projectId),
        apiClient
          .endpoints(projectId)
          .then((value) => ({ ok: true as const, value }))
          .catch((cause: unknown) => ({ ok: false as const, cause })),
      ]);
      setPolicy(p);
      setDraft(policyDraft(p));
      setCaps(c);
      if (endpointResult.ok) {
        setEndpoints(endpointResult.value);
        setEndpointState("ready");
      } else {
        setEndpointError(
          endpointResult.cause instanceof Error
            ? endpointResult.cause.message
            : "Endpoints could not be loaded.",
        );
        setEndpointState("error");
      }
      setState("ready");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Policy could not be loaded.",
      );
      setState("error");
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  const canManage = caps?.canManagePolicy === true;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || endpointState !== "ready") return;
    const input: ProjectPolicyInput = { ...draft };
    setSaving(true);
    setError("");
    try {
      const saved = await apiClient.updatePolicy(projectId, input);
      setPolicy(saved);
      setDraft(policyDraft(saved));
      toast.success("Resource policy updated.");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 403)
        setCaps((current) =>
          current ? { ...current, canManagePolicy: false } : current,
        );
      setError(
        cause instanceof Error ? cause.message : "Policy could not be saved.",
      );
    } finally {
      setSaving(false);
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
                      value={draft[limit.key] ?? ""}
                      placeholder="Unlimited"
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                [limit.key]: numberOrNull(event.target.value),
                              }
                            : current,
                        )
                      }
                    />
                  ) : (
                    <strong>{policy[limit.key] ?? "Unlimited"}</strong>
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
                <Button variant="quiet" size="sm" onClick={() => void load()}>
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
                            disabled={!current}
                            value={String(current?.windowSeconds ?? 3600)}
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
                            <option value="3600">1 hour</option>
                            <option value="86400">24 hours</option>
                            <option value="604800">7 days</option>
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
                disabled={saving || endpointState !== "ready"}
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

function numberOrNull(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

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
