"use client";

import Link from "next/link";
import {
  AlertTriangle,
  Bell,
  Check,
  CheckCircle2,
  ClipboardList,
  Clock,
  Gauge,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  apiClient,
  type ProjectAlert,
  type ProjectCapabilities,
} from "../../lib/api/client";
import { AlertRulesPanel } from "../alerts/AlertRulesPanel";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { ErrorState } from "../ui/error-state";
import { PageLoading } from "../ui/loading";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { toast } from "../ui/toast";

const labels: Record<ProjectAlert["type"], string> = {
  active_tasks_limit: "Task capacity reached",
  provider_requests_limit: "Endpoint request quota reached",
  provider_tokens_limit: "Token quota exceeded",
  provider_cost_limit: "Cost quota exceeded",
  project_file_bytes_limit: "File quota reached",
  endpoint_failure: "Endpoint failure",
  provider_failure: "Provider failure",
  task_failure: "Task failure",
  sandbox_failure: "Sandbox failure",
};

export function AlertsPage({ projectId }: { projectId: string }) {
  const [alerts, setAlerts] = useState<ProjectAlert[]>([]);
  const [capabilities, setCapabilities] = useState<ProjectCapabilities>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [capabilitiesError, setCapabilitiesError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dismiss, setDismiss] = useState<ProjectAlert | null>(null);
  const [retry, setRetry] = useState<{
    alert: ProjectAlert;
    action: "ack" | "silence";
  } | null>(null);
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const load = useCallback(async () => {
    setState("loading");
    setError("");
    setCapabilities(undefined);
    setCapabilitiesError("");
    const [alertsResult, capabilitiesResult] = await Promise.allSettled([
      apiClient.alerts(projectId),
      apiClient.projectCapabilities(projectId),
    ]);
    if (alertsResult.status === "rejected") {
      setError(
        alertsResult.reason instanceof Error ? alertsResult.reason.message : "Alerts could not be loaded.",
      );
      setState("error");
      return;
    }
    setAlerts(alertsResult.value);
    if (capabilitiesResult.status === "fulfilled") {
      setCapabilities(capabilitiesResult.value);
    } else {
      setCapabilitiesError("Alert permissions could not be loaded. Alerts are read-only until refreshed.");
    }
    setState("ready");
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setSelectedAlertId(
      typeof window === "undefined"
        ? null
        : new URLSearchParams(window.location.search).get("alertId"),
    );
  }, [projectId]);
  const canManage = capabilities?.canManagePolicy === true;
  async function transition(
    alert: ProjectAlert,
    status: "resolved" | "dismissed",
  ) {
    if (!canManage) return;
    setBusyId(alert.id);
    try {
      const saved = await apiClient.transitionAlert(
        projectId,
        alert.id,
        status,
      );
      replace(saved);
      setDismiss(null);
      toast.success(
        status === "resolved" ? "Alert resolved." : "Alert dismissed.",
      );
    } catch (cause) {
      forbidden(cause);
      throw cause;
    } finally {
      setBusyId(null);
    }
  }
  async function instance(alert: ProjectAlert, action: "ack" | "silence") {
    if (!canManage) return;
    setBusyId(alert.id);
    setRetry(null);
    try {
      const silenced =
        alert.silencedUntil !== null &&
        alert.silencedUntil !== undefined &&
        Date.parse(alert.silencedUntil) > Date.now();
      const saved =
        action === "ack"
          ? await apiClient.acknowledgeAlert(projectId, alert.id)
          : await apiClient.silenceAlert(
              projectId,
              alert.id,
              silenced ? null : new Date(Date.now() + 3_600_000).toISOString(),
            );
      replace(saved);
      toast.success(
        action === "ack"
          ? "Alert acknowledged."
          : saved.silencedUntil
            ? "Alert silenced for one hour."
            : "Alert silence cleared.",
      );
    } catch (cause) {
      if (!forbidden(cause)) setRetry({ alert, action });
    } finally {
      setBusyId(null);
    }
  }
  function replace(saved: ProjectAlert) {
    setAlerts((current) =>
      current.map((item) => (item.id === saved.id ? saved : item)),
    );
  }
  function forbidden(cause: unknown) {
    const accessDenied = cause instanceof ApiError && cause.status === 403;
    if (accessDenied) {
      setCapabilities((current) =>
        current ? { ...current, canManagePolicy: false } : current,
      );
      setCapabilitiesError("Alert management permission changed. Alerts and rules are now read-only.");
      setRetry(null);
      setDismiss(null);
      setError("");
    } else {
      setError(
        cause instanceof Error ? cause.message : "Alert could not be updated.",
      );
    }
    toast.error("Alert could not be updated.");
    return accessDenied;
  }
  const active = alerts.filter((alert) => alert.status === "active").length;
  return (
    <PageLayout
      header={
        <PageHeader
          title="Alerts"
          subtitle="Project alert rules and evaluated in-product instances."
          actions={
            <Button
              variant="quiet"
              size="icon"
              aria-label="Refresh alerts"
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
            title="Alerts unavailable"
            message={error}
            onRetry={() => void load()}
          />
        </PageState>
      ) : null}
      {state === "ready" && capabilitiesError ? <p className="mb-3 border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning" role="alert">{capabilitiesError}</p> : null}
      {state === "ready" && error ? <p className="mb-3 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">{error}</p> : null}
      {state === "ready" ? (
        <Tabs defaultValue="instances">
          <TabsList aria-label="Alerts view">
            <TabsTrigger value="instances">
              Instances {active ? `(${active})` : ""}
            </TabsTrigger>
            <TabsTrigger value="rules">Rules</TabsTrigger>
          </TabsList>
          <TabsContent value="instances">
            <AlertInstances
              alerts={alerts}
              canManage={canManage}
              busyId={busyId}
              retry={retry}
              selectedAlertId={selectedAlertId}
              onAck={(alert) => void instance(alert, "ack")}
              onSilence={(alert) => void instance(alert, "silence")}
              onResolve={(alert) =>
                void transition(alert, "resolved").catch(() => undefined)
              }
              onDismiss={setDismiss}
            />
          </TabsContent>
          <TabsContent value="rules">
            <AlertRulesPanel projectId={projectId} canManage={canManage} />
          </TabsContent>
        </Tabs>
      ) : null}
      <ConfirmationDialog
        open={dismiss !== null}
        onOpenChange={(open) => !open && setDismiss(null)}
        title="Dismiss project alert"
        description={
          dismiss
            ? `Dismiss ${labels[dismiss.type]}? The instance remains in history.`
            : ""
        }
        confirmText="Dismiss"
        onConfirm={() =>
          dismiss ? transition(dismiss, "dismissed") : undefined
        }
      />
    </PageLayout>
  );
}

function AlertInstances({
  alerts,
  canManage,
  busyId,
  retry,
  selectedAlertId,
  onAck,
  onSilence,
  onResolve,
  onDismiss,
}: {
  alerts: ProjectAlert[];
  canManage: boolean;
  busyId: string | null;
  retry: { alert: ProjectAlert; action: "ack" | "silence" } | null;
  selectedAlertId: string | null;
  onAck: (alert: ProjectAlert) => void;
  onSilence: (alert: ProjectAlert) => void;
  onResolve: (alert: ProjectAlert) => void;
  onDismiss: (alert: ProjectAlert) => void;
}) {
  const [status, setStatus] = useState("all");
  const visible = alerts.filter(
    (alert) => status === "all" || alert.status === status,
  );
  useEffect(() => {
    if (!selectedAlertId) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(alertElementId(selectedAlertId));
      target?.scrollIntoView({ block: "center" });
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [alerts, selectedAlertId]);
  if (!alerts.length)
    return (
      <PageState state="empty">
        <div>
          <Bell className="mx-auto size-8 text-tertiary" />
          <h2 className="mt-3 type-title">No alert instances</h2>
        </div>
      </PageState>
    );
  return (
    <section className="mt-4 space-y-3">
      <Select value={status} onValueChange={setStatus}>
        <SelectTrigger className="w-48" aria-label="Alert status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          <SelectItem value="active">Active</SelectItem>
          <SelectItem value="resolved">Resolved</SelectItem>
          <SelectItem value="dismissed">Dismissed</SelectItem>
        </SelectContent>
      </Select>
      {visible.length === 0 ? (
        <PageState state="empty">No instances match this filter.</PageState>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {visible.map((alert) => {
            const silenced =
              !!alert.silencedUntil &&
              Date.parse(alert.silencedUntil) > Date.now();
            return (
              <li
                id={alertElementId(alert.id)}
                tabIndex={-1}
                aria-current={selectedAlertId === alert.id ? "true" : undefined}
                className={`grid gap-3 px-3 py-4 outline-none sm:grid-cols-[1.25rem_minmax(0,1fr)_auto] ${selectedAlertId === alert.id ? "border-l-2 border-accent bg-surface-low" : ""}`}
                key={alert.id}
              >
                <AlertTriangle
                  className={
                    alert.status === "active"
                      ? "text-error"
                      : "text-icon-default"
                  }
                />
                <div>
                  <div className="flex flex-wrap gap-2">
                    <strong className="text-sm text-foreground">
                      {labels[alert.type]}
                    </strong>
                    <Badge
                      variant={
                        alert.status === "active" ? "destructive" : "secondary"
                      }
                    >
                      {alert.status}
                    </Badge>
                    {alert.acknowledgedAt ? (
                      <Badge variant="outline">Acknowledged</Badge>
                    ) : null}
                    {silenced ? (
                      <Badge variant="outline">Silenced</Badge>
                    ) : null}
                    {selectedAlertId === alert.id ? (
                      <Badge variant="outline">Linked instance</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-secondary">
                    {alert.metricValue !== null &&
                    alert.metricValue !== undefined
                      ? `${alert.metric?.replaceAll("_", " ")}: ${alert.metricValue}${alert.threshold !== null && alert.threshold !== undefined ? ` of ${alert.threshold}` : ""}`
                      : "No metric context recorded"}
                    {alert.endpointId ? ` · Endpoint ${alert.endpointId}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-tertiary">
                    Opened {formatDate(alert.createdAt)}
                    {alert.acknowledgedAt
                      ? ` · acknowledged ${formatDate(alert.acknowledgedAt)}`
                      : ""}
                    {silenced
                      ? ` · silenced until ${formatDate(alert.silencedUntil!)}`
                      : ""}
                    {alert.resolvedAt
                      ? ` · recovered ${formatDate(alert.resolvedAt)}`
                      : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <Link
                      href={usageInvestigationPath(alert)}
                      className="inline-flex items-center gap-1.5 text-xs text-secondary hover:text-foreground"
                    >
                      <Gauge size={14} />
                      Investigate usage
                    </Link>
                    <Link
                      href={`audit?resourceKind=alert&resourceId=${encodeURIComponent(alert.id)}`}
                      className="inline-flex items-center gap-1.5 text-xs text-secondary hover:text-foreground"
                    >
                      <ClipboardList size={14} />
                      View related audit
                    </Link>
                  </div>
                  {retry?.alert.id === alert.id ? (
                    <div
                      className="mt-2 flex items-center gap-2 text-sm text-error"
                      role="alert"
                    >
                      <span>Update failed.</span>
                      <Button
                        variant="quiet"
                        size="sm"
                        onClick={() =>
                          retry.action === "ack"
                            ? onAck(alert)
                            : onSilence(alert)
                        }
                      >
                        Retry
                      </Button>
                    </div>
                  ) : null}
                </div>
                {canManage && alert.status === "active" ? (
                  <div className="flex gap-1">
                    {!alert.acknowledgedAt ? (
                      <Button
                        variant="quiet"
                        size="icon"
                        aria-label="Acknowledge alert"
                        disabled={busyId === alert.id}
                        onClick={() => onAck(alert)}
                      >
                        <Check size={15} />
                      </Button>
                    ) : null}
                    <Button
                      variant="quiet"
                      size="icon"
                      aria-label={
                        silenced
                          ? "Clear alert silence"
                          : "Silence alert for one hour"
                      }
                      disabled={busyId === alert.id}
                      onClick={() => onSilence(alert)}
                    >
                      <Clock size={15} />
                    </Button>
                    <Button
                      variant="quiet"
                      size="icon"
                      aria-label="Resolve alert"
                      disabled={busyId === alert.id}
                      onClick={() => onResolve(alert)}
                    >
                      <CheckCircle2 size={15} />
                    </Button>
                    <Button
                      variant="quiet"
                      size="icon"
                      aria-label="Dismiss alert"
                      disabled={busyId === alert.id}
                      onClick={() => onDismiss(alert)}
                    >
                      <X size={15} />
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function alertElementId(alertId: string) {
  return `alert-${alertId.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`;
}

function usageInvestigationPath(alert: ProjectAlert) {
  return alert.endpointId
    ? `usage?endpointId=${encodeURIComponent(alert.endpointId)}`
    : "usage";
}
