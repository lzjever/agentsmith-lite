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
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      const [p, c, e] = await Promise.all([
        apiClient.policy(projectId),
        apiClient.projectCapabilities(projectId),
        apiClient.endpoints(projectId).catch(() => []),
      ]);
      setPolicy(p);
      setCaps(c);
      setEndpoints(e);
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
    const form = new FormData(event.currentTarget);
    const input: ProjectPolicyInput = {};
    for (const limit of limits) {
      const raw = String(form.get(limit.key) ?? "").trim();
      input[limit.key] = raw === "" ? null : Number(raw);
    }
    input.endpointWindows = [];
    for (const endpoint of endpoints)
      for (const metric of endpointMetrics) {
        const raw = String(
          form.get(name(endpoint.id, metric.value, "limit")) ?? "",
        ).trim();
        if (raw !== "")
          input.endpointWindows.push({
            endpointId: endpoint.id,
            metric: metric.value,
            limit: Number(raw),
            windowSeconds: Number(
              form.get(name(endpoint.id, metric.value, "window")) ?? 3600,
            ),
          });
      }
    setSaving(true);
    setError("");
    try {
      setPolicy(await apiClient.updatePolicy(projectId, input));
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
          subtitle="Project gauges and endpoint rolling windows enforced by the API."
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
      {state === "ready" && policy ? (
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
                      defaultValue={policy[limit.key] ?? ""}
                      placeholder="Unlimited"
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
              Each value is measured over its selected rolling window.
            </p>
            {endpoints.map((endpoint) => (
              <fieldset
                className="mt-4 border-t border-border pt-3"
                key={endpoint.id}
              >
                <legend className="text-sm font-medium">{endpoint.name}</legend>
                {endpointMetrics.map((metric) => {
                  const current = policy.endpointWindows?.find(
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
                            name={name(endpoint.id, metric.value, "limit")}
                            type="number"
                            min="0"
                            step={metric.step}
                            defaultValue={current?.limit ?? ""}
                            placeholder="Unlimited"
                          />
                          <select
                            aria-label={`${endpoint.name} ${metric.label} window`}
                            name={name(endpoint.id, metric.value, "window")}
                            defaultValue={String(
                              current?.windowSeconds ?? 3600,
                            )}
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
            {!endpoints.length ? (
              <p className="mt-3 text-sm text-secondary">
                No endpoints configured.
              </p>
            ) : null}
          </section>
          {canManage ? (
            <div className="flex justify-end">
              <Button type="submit" disabled={saving}>
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
function name(endpointId: string, metric: string, field: string) {
  return `${endpointId}:${metric}:${field}`;
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
