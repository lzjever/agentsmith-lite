"use client";

import Link from "next/link";
import { Badge, Button, Spinner } from "@astryxdesign/core";
import { useSearchParams } from "next/navigation";
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
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  apiClient,
  isReadOnlyMutationError,
  type Endpoint,
  type ProjectAlert,
  type ProjectCapabilities,
} from "../../lib/api/client";
import { AlertRulesPanel } from "../alerts/AlertRulesPanel";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { ErrorState } from "../ui/error-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { toast } from "../ui/toast";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { projectAlertTypeLabel } from "../../../packages/contracts/src/api";

export function AlertsPage({ workspaceId, projectId }: { workspaceId?: string; projectId: string }) {
  return <ProjectAlertsPage key={`${workspaceId ?? "workspace"}:${projectId}`} workspaceId={workspaceId} projectId={projectId} />;
}

function mergeLinkedAlert(items: ProjectAlert[], linked: ProjectAlert | null) {
  return linked && !items.some((alert) => alert.id === linked.id)
    ? [...items, linked]
    : items;
}

function alertItems(page: { items?: ProjectAlert[] }) {
  return page.items ?? [];
}

function ProjectAlertsPage({ workspaceId, projectId }: { workspaceId: string | undefined; projectId: string }) {
  const routeSearchParams = useSearchParams();
  const requestedAlertId =
    routeSearchParams?.get("alertId") ??
    (typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("alertId"));
  const projectBasePath = workspaceId ? `/workspaces/${workspaceId}/projects/${projectId}` : "..";
  const mutationKeys = useMutationKeys();
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const [alerts, setAlerts] = useState<ProjectAlert[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [activeCount, setActiveCount] = useState(0);
  const [alertStatus, setAlertStatus] = useState<"all" | ProjectAlert["status"]>("all");
  const [loadingMore, setLoadingMore] = useState(false);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [capabilities, setCapabilities] = useState<ProjectCapabilities>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [capabilitiesError, setCapabilitiesError] = useState("");
  const [view, setView] = useState<"instances" | "rules">("instances");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dismiss, setDismiss] = useState<ProjectAlert | null>(null);
  const [retry, setRetry] = useState<{
    alert: ProjectAlert;
    action: "ack" | "silence";
    silencedUntil?: string | null;
  } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setState("loading");
    setError("");
    setCapabilities(undefined);
    setCapabilitiesError("");
    const [alertsResult, capabilitiesResult, endpointsResult, linkedResult] =
      await Promise.allSettled([
        apiClient.alerts(projectId, {
          limit: 20,
          ...(alertStatus === "all" ? {} : { status: alertStatus }),
        }),
        apiClient.projectCapabilities(projectId),
        apiClient.endpoints(projectId),
        requestedAlertId && alertStatus === "all"
          ? apiClient.alert(projectId, requestedAlertId)
          : Promise.resolve(null),
      ]);
    if (!mounted.current || request !== loadRequest.current) return;
    if (alertsResult.status === "rejected") {
      setError(
        alertsResult.reason instanceof Error ? alertsResult.reason.message : "Alerts could not be loaded.",
      );
      setState("error");
      return;
    }
    const linked = linkedResult.status === "fulfilled" ? linkedResult.value : null;
    setAlerts(mergeLinkedAlert(alertItems(alertsResult.value), linked));
    setNextCursor(alertsResult.value.nextCursor);
    setActiveCount(alertsResult.value.activeCount);
    if (capabilitiesResult.status === "fulfilled") {
      setCapabilities(capabilitiesResult.value);
    } else {
      setCapabilitiesError("Alert permissions could not be loaded. Alerts are read-only until refreshed.");
    }
    setEndpoints(endpointsResult.status === "fulfilled" ? endpointsResult.value : []);
    setState("ready");
  }, [alertStatus, projectId, requestedAlertId]);
  const refreshInstances = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      const [loaded, linked] = await Promise.all([
        apiClient.alerts(projectId, {
          limit: 20,
          ...(alertStatus === "all" ? {} : { status: alertStatus }),
        }),
        requestedAlertId && alertStatus === "all"
          ? apiClient.alert(projectId, requestedAlertId).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!mounted.current || request !== loadRequest.current) return false;
      setAlerts(mergeLinkedAlert(alertItems(loaded), linked));
      setNextCursor(loaded.nextCursor);
      setActiveCount(loaded.activeCount);
      return true;
    } catch (cause) {
      if (!mounted.current || request !== loadRequest.current) return false;
      setError(cause instanceof Error ? cause.message : "Alert instances could not be refreshed.");
      return false;
    }
  }, [alertStatus, projectId, requestedAlertId]);
  async function loadMoreInstances() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const request = ++loadRequest.current;
    try {
      const page = await apiClient.alerts(projectId, {
        limit: 20,
        cursor: nextCursor,
        ...(alertStatus === "all" ? {} : { status: alertStatus }),
      });
      if (!mounted.current || request !== loadRequest.current) return;
      setAlerts((current) => {
        const seen = new Set(current.map((alert) => alert.id));
        return [...current, ...alertItems(page).filter((alert) => !seen.has(alert.id))];
      });
      setNextCursor(page.nextCursor);
      setActiveCount(page.activeCount);
    } catch (cause) {
      if (mounted.current && request === loadRequest.current)
        setError(cause instanceof Error ? cause.message : "More alerts could not be loaded.");
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }
  useEffect(() => {
    void load();
  }, [load]);
  const selectedAlertId =
    state === "ready" &&
    requestedAlertId &&
    alerts.some((alert) => alert.id === requestedAlertId)
      ? requestedAlertId
      : null;
  useEffect(() => {
    if (state !== "ready" || !requestedAlertId || selectedAlertId) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("alertId");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [requestedAlertId, selectedAlertId, state]);
  useEffect(() => {
    if (selectedAlertId) setView("instances");
  }, [selectedAlertId]);
  const canManage = capabilities?.canManagePolicy === true;
  async function transition(
    alert: ProjectAlert,
    status: "resolved" | "dismissed",
  ) {
    if (!canManage) return;
    loadRequest.current += 1;
    setBusyId(alert.id);
    try {
      const identity = `${alert.id}:${status}`;
      const saved = await apiClient.transitionAlert(
        projectId,
        alert.id,
        status,
        mutationKeys.key("project.alert.transition", identity),
      );
      mutationKeys.complete("project.alert.transition", identity);
      if (!mounted.current) return;
      replace(saved);
      setDismiss(null);
      toast.success(
        status === "resolved" ? "Alert resolved." : "Alert dismissed.",
      );
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError) mutationKeys.complete("project.alert.transition", `${alert.id}:${status}`);
      if (await recoverChangedInstance(cause)) return;
      forbidden(cause);
      throw cause;
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }
  async function instance(alert: ProjectAlert, action: "ack" | "silence", retrySilencedUntil?: string | null) {
    if (!canManage) return;
    loadRequest.current += 1;
    setBusyId(alert.id);
    setRetry(null);
    const silenced = !!alert.silencedUntil && Date.parse(alert.silencedUntil) > Date.now();
    const silencedUntil = action === "silence" ? retrySilencedUntil ?? (silenced ? null : new Date(Date.now() + 3_600_000).toISOString()) : undefined;
    const identity = action === "ack" ? alert.id : `${alert.id}:${silencedUntil}`;
    try {
      const saved =
        action === "ack"
          ? await apiClient.acknowledgeAlert(projectId, alert.id, mutationKeys.key("project.alert.acknowledge", identity))
          : await apiClient.silenceAlert(
              projectId,
              alert.id,
              silencedUntil!,
              mutationKeys.key("project.alert.silence", identity),
            );
      mutationKeys.complete(action === "ack" ? "project.alert.acknowledge" : "project.alert.silence", identity);
      if (!mounted.current) return;
      replace(saved);
      toast.success(
        action === "ack"
          ? "Alert acknowledged."
          : saved.silencedUntil
            ? "Alert silenced for one hour."
            : "Alert silence cleared.",
      );
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError) mutationKeys.complete(action === "ack" ? "project.alert.acknowledge" : "project.alert.silence", identity);
      if (await recoverChangedInstance(cause)) return;
      if (!forbidden(cause)) setRetry({ alert, action, ...(silencedUntil === undefined ? {} : { silencedUntil }) });
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }
  function replace(saved: ProjectAlert) {
    const previous = alerts.find((item) => item.id === saved.id);
    if (previous?.status === "active" && saved.status !== "active")
      setActiveCount((count) => Math.max(0, count - 1));
    if (previous?.status !== "active" && saved.status === "active")
      setActiveCount((count) => count + 1);
    setAlerts((current) =>
      alertStatus !== "all" && saved.status !== alertStatus
        ? current.filter((item) => item.id !== saved.id)
        : current.map((item) => (item.id === saved.id ? saved : item)),
    );
  }
  async function recoverChangedInstance(cause: unknown) {
    if (!(cause instanceof ApiError) || cause.status !== 404 || cause.message !== "Active project alert not found") return false;
    setRetry(null);
    setDismiss(null);
    setError("");
    const refreshed = await refreshInstances();
    if (mounted.current && refreshed) toast.error("Alert changed elsewhere. Latest state loaded.");
    return true;
  }
  function revokeAccess(cause?: unknown) {
    mutationKeys.clear("project.alert.transition");
    mutationKeys.clear("project.alert.acknowledge");
    mutationKeys.clear("project.alert.silence");
    if (cause instanceof ApiError && cause.status === 403) {
      setAlerts([]);
      setCapabilities(undefined);
      setCapabilitiesError("");
      setRetry(null);
      setDismiss(null);
      setState("loading");
      void load();
      return;
    }
    setCapabilities((current) =>
      current ? { ...current, canManagePolicy: false } : current,
    );
    setCapabilitiesError("Alert management access changed. Alerts and rules are now read-only.");
    setRetry(null);
    setDismiss(null);
    setError("");
  }
  function forbidden(cause: unknown) {
    const accessDenied = isReadOnlyMutationError(cause);
    if (accessDenied) {
      revokeAccess(cause);
    } else {
      setError(
        cause instanceof Error ? cause.message : "Alert could not be updated.",
      );
    }
    toast.error("Alert could not be updated.");
    return accessDenied;
  }
  return (
    <PageLayout
      header={
        <PageHeader
          title="Alerts"
          subtitle="Monitor project activity and resource limits with in-app notifications."
          actions={
            <Button
              label="Refresh alerts"
              variant="ghost"
              size="lg"
              isIconOnly
              icon={<RefreshCw size={16} />}
              isDisabled={busyId !== null}
              onClick={() => void load()}
            />
          }
        />
      }
    >
      {state === "loading" ? (
        <PageState state="loading">
          <Spinner label="Loading alerts..." />
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
        <Tabs value={view} onValueChange={(next) => setView(next as "instances" | "rules")}>
          <TabsList aria-label="Alerts view">
            <TabsTrigger value="instances">
              Instances ({activeCount} active)
            </TabsTrigger>
            <TabsTrigger value="rules">Rules</TabsTrigger>
          </TabsList>
          <TabsContent value="instances">
            <AlertInstances
              alerts={alerts}
              status={alertStatus}
              nextCursor={nextCursor}
              loadingMore={loadingMore}
              endpoints={endpoints}
              projectBasePath={projectBasePath}
              canManage={canManage}
              busyId={busyId}
              retry={retry}
              selectedAlertId={selectedAlertId}
              onStatusChange={setAlertStatus}
              onLoadMore={() => void loadMoreInstances()}
              onAck={(alert) => void instance(alert, "ack")}
              onSilence={(alert, silencedUntil) => void instance(alert, "silence", silencedUntil)}
              onResolve={(alert) =>
                void transition(alert, "resolved").catch(() => undefined)
              }
              onDismiss={setDismiss}
            />
          </TabsContent>
          <TabsContent value="rules">
            <AlertRulesPanel projectId={projectId} endpoints={endpoints} canManage={canManage} onAccessDenied={revokeAccess} onInstancesChanged={async () => { await refreshInstances(); }} />
          </TabsContent>
        </Tabs>
      ) : null}
      <ConfirmationDialog
        open={dismiss !== null}
        onOpenChange={(open) => !open && setDismiss(null)}
        title="Dismiss project alert"
        description={
          dismiss
            ? `Dismiss ${alertLabel(dismiss)}? The instance remains in history.`
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
  status,
  nextCursor,
  loadingMore,
  endpoints,
  projectBasePath,
  canManage,
  busyId,
  retry,
  selectedAlertId,
  onStatusChange,
  onLoadMore,
  onAck,
  onSilence,
  onResolve,
  onDismiss,
}: {
  alerts: ProjectAlert[];
  status: "all" | ProjectAlert["status"];
  nextCursor: string | null;
  loadingMore: boolean;
  endpoints: Endpoint[];
  projectBasePath: string;
  canManage: boolean;
  busyId: string | null;
  retry: { alert: ProjectAlert; action: "ack" | "silence"; silencedUntil?: string | null } | null;
  selectedAlertId: string | null;
  onStatusChange: (status: "all" | ProjectAlert["status"]) => void;
  onLoadMore: () => void;
  onAck: (alert: ProjectAlert) => void;
  onSilence: (alert: ProjectAlert, silencedUntil?: string | null) => void;
  onResolve: (alert: ProjectAlert) => void;
  onDismiss: (alert: ProjectAlert) => void;
}) {
  useEffect(() => {
    if (!selectedAlertId) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(alertElementId(selectedAlertId));
      target?.scrollIntoView({ block: "center" });
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [alerts, selectedAlertId]);
  return (
    <section className="mt-4 space-y-3">
      <Select
        value={status}
        onValueChange={(value) =>
          onStatusChange(value as "all" | ProjectAlert["status"])
        }
      >
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
      {alerts.length === 0 ? (
        <PageState state="empty">
          {status === "all" ? (
            <div>
              <Bell className="mx-auto size-8 text-tertiary" />
              <h2 className="mt-3 type-title">No alert instances</h2>
            </div>
          ) : (
            "No instances match this filter."
          )}
        </PageState>
      ) : (
        <>
          <ul className="divide-y divide-border border-y border-border">
            {alerts.map((alert) => {
            const silenced =
              !!alert.silencedUntil &&
              Date.parse(alert.silencedUntil) > Date.now();
            const investigation = alertInvestigation(alert, projectBasePath);
            const endpoint = alert.endpointId
              ? endpoints.find((item) => item.id === alert.endpointId)
              : undefined;
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
                      {alertLabel(alert)}
                    </strong>
                    <Badge variant={alert.status === "active" ? "error" : "neutral"} label={alert.status} />
                    {alert.acknowledgedAt ? (
                      <Badge variant="neutral" label="Acknowledged" />
                    ) : null}
                    {silenced ? (
                      <Badge variant="neutral" label="Silenced" />
                    ) : null}
                    {selectedAlertId === alert.id ? (
                      <Badge variant="neutral" label="Linked instance" />
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-secondary">
                    {alert.metricValue !== null &&
                    alert.metricValue !== undefined
                      ? `${alert.metric?.replaceAll("_", " ")}: ${alert.metricValue}${alert.threshold !== null && alert.threshold !== undefined ? ` of ${alert.threshold}` : ""}`
                      : "No metric context recorded"}
                    {alert.endpointId ? <> · <Link className="hover:text-foreground hover:underline" href={`${projectBasePath}/endpoints`}>{endpoint?.name ?? `Endpoint ${alert.endpointId}`}</Link></> : null}
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
                      href={investigation.href}
                      className="inline-flex items-center gap-1.5 text-xs text-secondary hover:text-foreground"
                    >
                      <Gauge size={14} />
                      {investigation.label}
                    </Link>
                    <Link
                      href={`${projectBasePath}/audit?resourceKind=alert&resourceId=${encodeURIComponent(alert.id)}`}
                      className="inline-flex items-center gap-1.5 text-xs text-secondary hover:text-foreground"
                    >
                      <ClipboardList size={14} />
                      View alert history
                    </Link>
                  </div>
                  {retry?.alert.id === alert.id ? (
                    <div
                      className="mt-2 flex items-center gap-2 text-sm text-error"
                      role="alert"
                    >
                      <span>Update failed.</span>
                      <Button
                        label="Retry"
                        variant="ghost"
                        size="md"
                        onClick={() =>
                          retry.action === "ack"
                            ? onAck(alert)
                            : onSilence(alert, retry.silencedUntil)
                        }
                      />
                    </div>
                  ) : null}
                </div>
                {canManage && alert.status === "active" ? (
                  <div className="flex gap-1">
                    {!alert.acknowledgedAt ? (
                      <Button
                        label="Acknowledge alert"
                        variant="ghost"
                        size="lg"
                        isIconOnly
                        icon={<Check size={15} />}
                        isDisabled={busyId === alert.id}
                        onClick={() => onAck(alert)}
                      />
                    ) : null}
                    <Button
                      label={
                        silenced
                          ? "Clear alert silence"
                          : "Silence alert for one hour"
                      }
                      variant="ghost"
                      size="lg"
                      isIconOnly
                      icon={<Clock size={15} />}
                      isDisabled={busyId === alert.id}
                      onClick={() => onSilence(alert)}
                    />
                    <Button
                      label="Resolve alert"
                      variant="ghost"
                      size="lg"
                      isIconOnly
                      icon={<CheckCircle2 size={15} />}
                      isDisabled={busyId === alert.id}
                      onClick={() => onResolve(alert)}
                    />
                    <Button
                      label="Dismiss alert"
                      variant="ghost"
                      size="lg"
                      isIconOnly
                      icon={<X size={15} />}
                      isDisabled={busyId === alert.id}
                      onClick={() => onDismiss(alert)}
                    />
                  </div>
                ) : null}
              </li>
            );
            })}
          </ul>
          {nextCursor ? (
            <div className="flex justify-center pt-2">
              <Button
                label={loadingMore ? "Loading..." : "Load more"}
                variant="secondary"
                size="lg"
                isDisabled={loadingMore}
                onClick={onLoadMore}
              />
            </div>
          ) : null}
        </>
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

function alertLabel(alert: ProjectAlert) {
  return projectAlertTypeLabel(alert.type, Boolean(alert.endpointId));
}

function alertElementId(alertId: string) {
  return `alert-${alertId.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`;
}

function alertInvestigation(alert: ProjectAlert, projectBasePath: string): { href: string; label: string } {
  if (alert.type === "endpoint_failure") return { href: `${projectBasePath}/endpoints`, label: "Open endpoints" };
  if (alert.type === "provider_failure") return { href: `${projectBasePath}/audit?action=provider.request&status=rejected`, label: "View provider failures" };
  if (alert.type === "task_failure") return { href: `${projectBasePath}/tasks?status=failed`, label: "View failed tasks" };
  if (alert.type === "sandbox_failure") return { href: `${projectBasePath}/audit?action=sandbox.failed&status=accepted`, label: "View sandbox failures" };
  return {
    href: alert.endpointId ? `${projectBasePath}/usage?endpointId=${encodeURIComponent(alert.endpointId)}` : `${projectBasePath}/usage`,
    label: "Investigate usage"
  };
}
