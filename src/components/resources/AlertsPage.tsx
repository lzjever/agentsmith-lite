"use client";

import Link from "next/link";
import {
  Badge,
  Banner,
  Button,
  Dialog,
  DialogHeader,
  EmptyState,
  IconButton,
  MoreMenu,
  Spinner,
  Tab,
  TabList,
  Text,
  useToast
} from "@astryxdesign/core";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Bell,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock,
  Gauge,
  RefreshCw,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState
} from "react";
import {
  ApiError,
  apiClient,
  isReadOnlyMutationError,
  type MemberRole,
  type ProjectAlert,
  type ProjectCapabilities
} from "../../lib/api/client";
import {
  createAlertPageState,
  reduceAlertPageState,
  type AlertMutationRetry,
  type AlertPageView
} from "../alerts/alertPageState";
import {
  canonicalAlertPageNavigation,
  parseAlertPageRoute,
  tabAlertPageNavigation
} from "../alerts/alertPageUrl";
import { AlertRulesPanel } from "../alerts/AlertRulesPanel";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { formatLocalDateTime as formatDate } from "../../lib/format/date";
import { projectAlertTypeLabel } from "../../../packages/contracts/src/api";

export function AlertsPage({
  workspaceId,
  projectId
}: {
  workspaceId?: string;
  projectId: string;
}) {
  return (
    <ProjectAlertsPage
      key={`${workspaceId ?? "workspace"}:${projectId}`}
      workspaceId={workspaceId}
      projectId={projectId}
    />
  );
}

function ProjectAlertsPage({
  workspaceId,
  projectId
}: {
  workspaceId: string | undefined;
  projectId: string;
}) {
  const routeSearchParams = useSearchParams();
  const initialRoute = parseAlertPageRoute(
    routeSearchParams?.toString() ??
      (typeof window === "undefined" ? "" : window.location.search)
  );
  const [alertState, dispatch] = useReducer(
    reduceAlertPageState,
    createAlertPageState({
      view: initialRoute.view,
      linkedAlertId: initialRoute.linkedAlertId
    })
  );
  const [capabilities, setCapabilities] = useState<ProjectCapabilities>();
  const [memberRole, setMemberRole] = useState<MemberRole>();
  const [capabilitiesError, setCapabilitiesError] = useState("");
  const mounted = useRef(true);
  const dismissDescriptionId = useId();
  const supportGeneration = useRef(0);
  const requestGeneration = useRef({ list: 0, lookup: 0, mutation: 0 });
  const mutationKeys = useMutationKeys();
  const showToast = useToast();
  const projectBasePath = workspaceId
    ? `/workspaces/${workspaceId}/projects/${projectId}`
    : "..";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadSupport = useCallback(async () => {
    const generation = ++supportGeneration.current;
    setCapabilitiesError("");
    const [capabilitiesResult, overviewResult] = await Promise.all([
      Promise.resolve(apiClient.projectCapabilities(projectId)).then((value)=>({status:"fulfilled" as const,value})).catch((reason)=>({status:"rejected" as const,reason})),
      Promise.resolve(apiClient.projectOverview(projectId)).then((value)=>({status:"fulfilled" as const,value})).catch((reason)=>({status:"rejected" as const,reason}))
    ]);
    if (!mounted.current || generation !== supportGeneration.current) return;
    if (capabilitiesResult.status === "fulfilled") {
      setCapabilities(capabilitiesResult.value);
    } else {
      setCapabilities(undefined);
      setCapabilitiesError(
        "Alert permissions could not be loaded. Alerts are read-only until refreshed."
      );
    }
    setMemberRole(
      overviewResult.status === "fulfilled"
        ? overviewResult.value.memberRole
        : undefined
    );
  }, [projectId]);

  useEffect(() => {
    void loadSupport();
  }, [loadSupport]);

  useEffect(() => {
    const query = alertState.candidateQuery;
    if (!alertState.list.pending || !query) return;
    const requestId = nextRequestId(requestGeneration, "list");
    dispatch({ type: "list_request_started", requestId });
    void apiClient.alerts(projectId, {
      view: query.view,
      limit: 20,
      ...(query.cursor ? { cursor: query.cursor } : {})
    }).then((page) => {
      if (!mounted.current) return;
      if (page.view !== query.view) {
        dispatch({
          type: "list_request_failed",
          requestId,
          message: "Alerts response did not match the requested view."
        });
        return;
      }
      dispatch({
        type: "list_request_succeeded",
        requestId,
        rows: page.items,
        nextCursor: page.nextCursor,
        activeCount: page.activeCount
      });
    }).catch((reason) => {
      if (!mounted.current) return;
      dispatch({
        type: "list_request_failed",
        requestId,
        message: errorMessage(reason, "Alerts could not be loaded.")
      });
    }).finally(() => {
      if (mounted.current) {
        dispatch({ type: "list_request_finished", requestId });
      }
    });
  }, [
    alertState.candidateQuery,
    alertState.list.pending,
    projectId
  ]);

  useEffect(() => {
    const alertId = alertState.linkedAlertId;
    if (!alertId || !alertState.linkedLookup.pending) return;
    const requestId = nextRequestId(requestGeneration, "lookup");
    dispatch({ type: "linked_lookup_started", requestId });
    void apiClient.alert(projectId, alertId).then((alert) => {
      if (!mounted.current) return;
      dispatch({
        type: "linked_lookup_succeeded",
        requestId,
        alert
      });
    }).catch((reason) => {
      if (!mounted.current) return;
      dispatch({
        type: "linked_lookup_failed",
        requestId,
        reason:
          reason instanceof ApiError && reason.status === 404
            ? "not_found"
            : "transient",
        message: errorMessage(reason, "Linked alert could not be loaded.")
      });
    }).finally(() => {
      if (mounted.current) {
        dispatch({ type: "linked_lookup_finished", requestId });
      }
    });
  }, [
    alertState.linkedAlertId,
    alertState.linkedLookup.pending,
    projectId
  ]);

  useEffect(() => {
    const navigation = canonicalAlertPageNavigation(window.location.href, {
      view: alertState.view,
      linkedAlertId: alertState.linkedAlertId
    });
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (navigation.href !== current) {
      window.history.replaceState(
        window.history.state,
        "",
        navigation.href
      );
    }
  }, [alertState.linkedAlertId, alertState.view]);

  useEffect(() => {
    const handlePopState = () => {
      const route = parseAlertPageRoute(window.location.search);
      dispatch({
        type: "route_changed",
        view: route.view,
        linkedAlertId: route.linkedAlertId
      });
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const selectedAlertId = alertState.selectedAlertId;
    if (!selectedAlertId) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(alertElementId(selectedAlertId));
      target?.scrollIntoView({ block: "center" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    alertState.linkedAlert,
    alertState.page.rows,
    alertState.selectedAlertId
  ]);

  const canManage = capabilities?.canManagePolicy === true;
  const canViewAudit = memberRole === "owner" || memberRole === "admin";
  const dismiss = alertState.mutation.dismissAlert;
  const dismissBusy = Boolean(
    dismiss && alertState.mutation.busyId === dismiss.id
  );
  const linkedSeparate = Boolean(
    alertState.linkedAlert &&
    !alertState.page.rows.some((row) => row.id === alertState.linkedAlert?.id)
  );

  function changeView(view: AlertPageView) {
    if (view === alertState.view && alertState.linkedAlertId === null) return;
    const navigation = tabAlertPageNavigation(window.location.href, view);
    window.history.pushState(window.history.state, "", navigation.href);
    dispatch({ type: "view_changed", view });
  }

  function refresh() {
    void loadSupport();
    if (alertState.linkedAlertId) {
      dispatch({ type: "linked_lookup_retry_requested" });
    } else if (alertState.view !== "rules") {
      dispatch({ type: "list_reload_requested" });
    }
  }

  async function mutate(
    alert: ProjectAlert,
    action: "ack" | "silence" | "resolve" | "dismiss",
    retrySilencedUntil?: string | null
  ) {
    if (!canManage || alertState.mutation.busyId !== null) return;
    const requestId = nextRequestId(requestGeneration, "mutation");
    const silenced =
      !!alert.silencedUntil && Date.parse(alert.silencedUntil) > Date.now();
    const silencedUntil =
      action === "silence"
        ? retrySilencedUntil ??
          (silenced
            ? null
            : new Date(Date.now() + 3_600_000).toISOString())
        : undefined;
    const identity =
      action === "resolve" || action === "dismiss"
        ? `${alert.id}:${action === "resolve" ? "resolved" : "dismissed"}`
        : action === "ack"
          ? alert.id
          : `${alert.id}:${silencedUntil}`;
    const keyScope =
      action === "resolve" || action === "dismiss"
        ? "project.alert.transition"
        : action === "ack"
          ? "project.alert.acknowledge"
          : "project.alert.silence";
    dispatch({ type: "mutation_started", requestId, alert, action });
    try {
      const saved =
        action === "resolve" || action === "dismiss"
          ? await apiClient.transitionAlert(
              projectId,
              alert.id,
              action === "resolve" ? "resolved" : "dismissed",
              mutationKeys.key(keyScope, identity)
            )
          : action === "ack"
            ? await apiClient.acknowledgeAlert(
                projectId,
                alert.id,
                mutationKeys.key(keyScope, identity)
              )
            : await apiClient.silenceAlert(
                projectId,
                alert.id,
                silencedUntil!,
                mutationKeys.key(keyScope, identity)
              );
      mutationKeys.complete(keyScope, identity);
      if (!mounted.current) return;
      dispatch({ type: "mutation_succeeded", requestId, row: saved });
      showToast({
        body:
          action === "resolve"
            ? "Alert resolved."
            : action === "dismiss"
              ? "Alert dismissed."
              : action === "ack"
                ? "Alert acknowledged."
                : saved.silencedUntil
                  ? "Alert silenced for one hour."
                  : "Alert silence cleared.",
        type: "info"
      });
      if (action === "dismiss") {
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>('[aria-label="Alerts view"] [aria-selected="true"]')?.focus();
        });
      }
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ApiError) {
        mutationKeys.complete(keyScope, identity);
      }
      if (isChangedActiveAlert(reason)) {
        dispatch({ type: "mutation_changed_elsewhere", requestId });
        return;
      }
      if (revokeAccess(reason)) return;
      const retry: AlertMutationRetry | undefined =
        action === "ack"
          ? { alert, action }
          : action === "silence"
            ? {
                alert,
                action,
                ...(silencedUntil === undefined ? {} : { silencedUntil })
              }
            : undefined;
      dispatch({
        type: "mutation_failed",
        requestId,
        message: errorMessage(reason, "Alert could not be updated."),
        ...(retry ? { retry } : {})
      });
    } finally {
      if (mounted.current) {
        dispatch({ type: "mutation_finished", requestId });
      }
    }
  }

  function revokeAccess(reason: unknown) {
    if (!isReadOnlyMutationError(reason)) return false;
    mutationKeys.clear("project.alert.transition");
    mutationKeys.clear("project.alert.acknowledge");
    mutationKeys.clear("project.alert.silence");
    dispatch({ type: "mutation_cleared" });
    if (reason.status === 403) {
      setCapabilities(undefined);
      setCapabilitiesError("");
      void loadSupport();
      if (alertState.view !== "rules") {
        dispatch({ type: "list_reload_requested" });
      }
    } else {
      setCapabilities((current) =>
        current ? { ...current, canManagePolicy: false } : current
      );
      setCapabilitiesError(
        "Alert management access changed. Alerts and rules are now read-only."
      );
    }
    return true;
  }

  function retryMutation(retry: AlertMutationRetry) {
    void mutate(retry.alert, retry.action, retry.silencedUntil);
  }

  return (
    <PageLayout
      header={
        <PageHeader
          title="Alerts"
          subtitle="Monitor project activity and resource limits with in-app notifications."
          actions={
            <IconButton
              label="Refresh alerts"
              tooltip="Refresh alerts"
              variant="ghost"
              size="lg"
              icon={<RefreshCw size={16} />}
              isDisabled={alertState.mutation.busyId !== null}
              onClick={refresh}
            />
          }
        />
      }
    >
      {capabilitiesError ? (
        <Banner
          className="mb-3"
          status="warning"
          title="Alert permissions unavailable"
          description={capabilitiesError}
        />
      ) : null}
      {alertState.mutation.error && !dismiss ? (
        <Banner
          className="mb-3"
          status="error"
          title="Alert update failed"
          description={alertState.mutation.error}
          isDismissable
          onDismiss={() => dispatch({ type: "mutation_feedback_cleared" })}
        />
      ) : null}
      {alertState.mutation.notice ? (
        <Banner
          className="mb-3"
          status="info"
          title="Alert state updated"
          description={alertState.mutation.notice}
          isDismissable
          onDismiss={() => dispatch({ type: "mutation_feedback_cleared" })}
        />
      ) : null}
      <TabList
        value={alertState.view}
        onChange={(next) => changeView(next as AlertPageView)}
        aria-label="Alerts view"
      >
        <Tab
          value="active"
          label={
            alertState.page.activeCount === null
              ? "Active"
              : `Active (${alertState.page.activeCount})`
          }
        />
        <Tab value="history" label="History" />
        <Tab value="rules" label="Rules" />
      </TabList>

      {alertState.view === "rules" ? (
        <AlertRulesPanel
          projectId={projectId}
          canManage={canManage}
          onAccessDenied={revokeAccess}
        />
      ) : (
        <AlertInstances
          state={alertState}
          linkedSeparate={linkedSeparate}
          projectBasePath={projectBasePath}
          canManage={canManage}
          canViewAudit={canViewAudit}
          onRetryList={() => dispatch({ type: "list_reload_requested" })}
          onRetryLookup={() =>
            dispatch({ type: "linked_lookup_retry_requested" })
          }
          onFirstPage={() => dispatch({ type: "first_page" })}
          onPrevious={() => dispatch({ type: "previous_page" })}
          onNext={() => dispatch({ type: "next_page" })}
          onShowActive={() => changeView("active")}
          onAck={(alert) => void mutate(alert, "ack")}
          onSilence={(alert, silencedUntil) =>
            void mutate(alert, "silence", silencedUntil)
          }
          onResolve={(alert) => void mutate(alert, "resolve")}
          onDismiss={(alert) =>
            dispatch({ type: "mutation_dismiss_changed", alert })
          }
          onRetryMutation={retryMutation}
        />
      )}

      <Dialog
        className="[&_button]:min-h-11 [&_button]:min-w-11"
        isOpen={dismiss !== null}
        onOpenChange={(open) => {
          if (!open && !dismissBusy) {
            dispatch({ type: "mutation_dismiss_changed", alert: null });
          }
        }}
        role="alertdialog"
        purpose={dismissBusy ? "required" : "form"}
        padding={0}
        width="min(32rem, calc(100dvw - 1rem))"
        maxHeight="calc(100dvh - 1rem)"
        aria-label="Dismiss project alert"
        aria-describedby={dismissDescriptionId}
      >
        <DialogHeader className="p-4 sm:px-6" title="Dismiss project alert" hasDivider />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <Text id={dismissDescriptionId} as="p" display="block" color="secondary">
            {dismiss
              ? `Dismiss ${alertLabel(dismiss)}? The instance remains in history.`
              : ""}
          </Text>
          <div className="mt-4">
            {dismiss && alertState.mutation.error ? (
              <Banner
                status="error"
                title="Alert could not be dismissed"
                description={alertState.mutation.error}
              />
            ) : null}
          </div>
        </div>
        <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
          <Button data-autofocus="" type="button" label="Cancel" variant="ghost" size="lg" isDisabled={dismissBusy} onClick={() => dispatch({ type: "mutation_dismiss_changed", alert: null })} />
          <Button type="button" label={dismissBusy ? "Dismissing" : "Dismiss"} variant="primary" size="lg" isDisabled={!dismiss || dismissBusy} isLoading={dismissBusy} onClick={() => { if (dismiss && !dismissBusy) void mutate(dismiss, "dismiss"); }} />
        </div>
      </Dialog>
    </PageLayout>
  );
}

function AlertInstances({
  state,
  linkedSeparate,
  projectBasePath,
  canManage,
  canViewAudit,
  onRetryList,
  onRetryLookup,
  onFirstPage,
  onPrevious,
  onNext,
  onShowActive,
  onAck,
  onSilence,
  onResolve,
  onDismiss,
  onRetryMutation
}: {
  state: ReturnType<typeof createAlertPageState>;
  linkedSeparate: boolean;
  projectBasePath: string;
  canManage: boolean;
  canViewAudit: boolean;
  onRetryList: () => void;
  onRetryLookup: () => void;
  onFirstPage: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onShowActive: () => void;
  onAck: (alert: ProjectAlert) => void;
  onSilence: (alert: ProjectAlert, silencedUntil?: string | null) => void;
  onResolve: (alert: ProjectAlert) => void;
  onDismiss: (alert: ProjectAlert) => void;
  onRetryMutation: (retry: AlertMutationRetry) => void;
}) {
  const initialLoading =
    !state.list.hasLoaded &&
    (state.list.loading || state.list.pending) &&
    !state.linkedLookup.error;
  return (
    <section className="mt-4 space-y-4" aria-label={`${capitalize(state.view)} alerts`}>
      {state.linkedLookup.loading && !state.linkedAlert ? (
        <div className="grid min-h-40 place-items-center" role="status">
          <Spinner label="Loading linked alert..." />
        </div>
      ) : null}
      {state.linkedLookup.error ? (
        <Banner
          status="error"
          title="Linked alert unavailable"
          description={state.linkedLookup.error}
          endContent={
            <Button
              label="Retry"
              variant="ghost"
              onClick={onRetryLookup}
            />
          }
        />
      ) : null}
      {state.list.error ? (
        <Banner
          status="error"
          title={state.list.hasLoaded ? "Alerts refresh failed" : "Alerts unavailable"}
          description={state.list.error}
          endContent={
            <Button label="Retry" variant="ghost" onClick={onRetryList} />
          }
        />
      ) : null}
      {linkedSeparate && state.linkedAlert ? (
        <section aria-label="Linked alert">
          <Text type="supporting" color="secondary" display="block" className="mb-2">
            Linked alert
          </Text>
          <ul className="divide-y divide-border border-y border-border">
            <AlertRow
              alert={state.linkedAlert}
              projectBasePath={projectBasePath}
              canManage={canManage}
              canViewAudit={canViewAudit}
              busyId={state.mutation.busyId}
              retry={state.mutation.retry}
              selectedAlertId={state.selectedAlertId}
              onAck={onAck}
              onSilence={onSilence}
              onResolve={onResolve}
              onDismiss={onDismiss}
              onRetryMutation={onRetryMutation}
            />
          </ul>
        </section>
      ) : null}
      {initialLoading ? (
        <div className="grid min-h-48 place-items-center" role="status">
          <Spinner label={`Loading ${state.view} alerts...`} />
        </div>
      ) : null}
      {state.list.hasLoaded &&
      state.page.rows.length === 0 &&
      !linkedSeparate ? (
        <EmptyState
          icon={<Bell />}
          title={
            state.view === "active"
              ? "No active alerts"
              : "No alert history"
          }
          description={
            state.page.pageNumber > 1
              ? "This page has no alerts."
              : state.view === "active"
                ? "No project alerts currently require attention."
                : "Resolved and dismissed alerts will appear here."
          }
          actions={
            <>
              {state.view === "history" ? (
                <Button
                  label="Show active"
                  variant="secondary"
                  onClick={onShowActive}
                />
              ) : null}
              {state.page.pageNumber > 1 ? (
                <Button label="Reset" variant="ghost" onClick={onFirstPage} />
              ) : null}
            </>
          }
        />
      ) : null}
      {state.page.rows.length > 0 ? (
        <ul className="divide-y divide-border border-y border-border">
          {state.page.rows.map((alert) => (
            <AlertRow
              key={alert.id}
              alert={alert}
              projectBasePath={projectBasePath}
              canManage={canManage}
              canViewAudit={canViewAudit}
              busyId={state.mutation.busyId}
              retry={state.mutation.retry}
              selectedAlertId={state.selectedAlertId}
              onAck={onAck}
              onSilence={onSilence}
              onResolve={onResolve}
              onDismiss={onDismiss}
              onRetryMutation={onRetryMutation}
            />
          ))}
        </ul>
      ) : null}
      {state.list.hasLoaded &&
      (state.page.cursorStack.length > 0 || state.page.nextCursor) ? (
        <nav
          className="flex items-center justify-between gap-3 border-t border-border pt-3"
          aria-label="Alert pages"
        >
          <Button
            label="Previous"
            variant="ghost"
            icon={<ChevronLeft size={15} />}
            isDisabled={
              state.list.loading || state.page.cursorStack.length === 0
            }
            onClick={onPrevious}
          />
          <Text type="supporting" color="secondary">
            Page {state.page.pageNumber}
          </Text>
          <Button
            label="Next"
            variant="ghost"
            icon={<ChevronRight size={15} />}
            isDisabled={state.list.loading || !state.page.nextCursor}
            onClick={onNext}
          />
        </nav>
      ) : null}
    </section>
  );
}

function AlertRow({
  alert,
  projectBasePath,
  canManage,
  canViewAudit,
  busyId,
  retry,
  selectedAlertId,
  onAck,
  onSilence,
  onResolve,
  onDismiss,
  onRetryMutation
}: {
  alert: ProjectAlert;
  projectBasePath: string;
  canManage: boolean;
  canViewAudit: boolean;
  busyId: string | null;
  retry: AlertMutationRetry | null;
  selectedAlertId: string | null;
  onAck: (alert: ProjectAlert) => void;
  onSilence: (alert: ProjectAlert, silencedUntil?: string | null) => void;
  onResolve: (alert: ProjectAlert) => void;
  onDismiss: (alert: ProjectAlert) => void;
  onRetryMutation: (retry: AlertMutationRetry) => void;
}) {
  const silenced =
    !!alert.silencedUntil && Date.parse(alert.silencedUntil) > Date.now();
  const investigation = alertInvestigation(alert, projectBasePath, canViewAudit);
  const selected = selectedAlertId === alert.id;
  return (
    <li
      id={alertElementId(alert.id)}
      tabIndex={-1}
      aria-current={selected ? "true" : undefined}
      className={`grid gap-3 px-3 py-4 outline-none sm:grid-cols-[1.25rem_minmax(0,1fr)] ${
        selected ? "border-l-2 border-accent bg-muted" : ""
      }`}
    >
      <AlertTriangle
        className={
          alert.status === "active" ? "text-error" : "text-icon-secondary"
        }
      />
      <div className="min-w-0">
        <div className="flex flex-wrap gap-2">
          <Text weight="semibold">{alertLabel(alert)}</Text>
          <Badge
            variant={alert.status === "active" ? "error" : "neutral"}
            label={alert.status}
          />
          {alert.acknowledgedAt ? (
            <Badge variant="neutral" label="Acknowledged" />
          ) : null}
          {silenced ? <Badge variant="neutral" label="Silenced" /> : null}
          {selected ? <Badge variant="neutral" label="Linked instance" /> : null}
        </div>
        <Text
          as="p"
          type="supporting"
          color="secondary"
          display="block"
          className="mt-1"
        >
          {alert.metricValue !== null && alert.metricValue !== undefined
            ? `${alert.metric === "active_sandboxes" ? "Active sandboxes" : alert.metric?.replaceAll("_", " ")}: ${alert.metricValue}${
                alert.threshold !== null && alert.threshold !== undefined
                  ? ` of ${alert.threshold}`
                  : ""
              }`
            : "No metric context recorded"}
          {alert.endpointId ? (
            <>
              {" "}
              ·{" "}
              <Link
                className="hover:text-primary hover:underline"
                href={`${projectBasePath}/endpoints?endpointId=${encodeURIComponent(alert.endpointId)}`}
              >
                {alert.endpointName ?? `Endpoint ${alert.endpointId}`}
              </Link>
            </>
          ) : null}
        </Text>
        <Text
          as="p"
          type="supporting"
          color="secondary"
          display="block"
          className="mt-1"
        >
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
        </Text>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {investigation ? (
            <Link
              href={investigation.href}
              className="inline-flex items-center gap-1.5 text-secondary hover:text-primary"
            >
              <Gauge size={14} />
              <Text type="supporting" color="secondary">
                {investigation.label}
              </Text>
            </Link>
          ) : null}
          {canViewAudit ? (
            <Link
              href={`${projectBasePath}/audit?resourceKind=alert&resourceId=${encodeURIComponent(alert.id)}`}
              className="inline-flex items-center gap-1.5 text-secondary hover:text-primary"
            >
              <ClipboardList size={14} />
              <Text type="supporting" color="secondary">
                View alert history
              </Text>
            </Link>
          ) : null}
        </div>
        {retry?.alert.id === alert.id ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-error" role="alert">
            <Text type="supporting" color="inherit">
              Update failed.
            </Text>
            <Button
              label="Retry"
              variant="ghost"
              size="sm"
              onClick={() => onRetryMutation(retry)}
            />
          </div>
        ) : null}
        {canManage && alert.status === "active" ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              label="Resolve"
              variant="primary"
              size="md"
              icon={<CheckCircle2 size={15} />}
              isDisabled={busyId !== null}
              isLoading={busyId === alert.id}
              onClick={() => onResolve(alert)}
            />
            <MoreMenu
              label={`More actions for ${alertLabel(alert)}`}
              size="md"
              isDisabled={busyId !== null}
              items={[
                ...(!alert.acknowledgedAt
                  ? [{
                      label: "Acknowledge",
                      icon: <Check size={15} />,
                      onClick: () => onAck(alert)
                    }]
                  : []),
                {
                  label: silenced
                    ? "Clear silence"
                    : "Silence for one hour",
                  icon: <Clock size={15} />,
                  onClick: () => onSilence(alert)
                },
                {
                  label: "Dismiss",
                  icon: <X size={15} />,
                  onClick: () => onDismiss(alert)
                }
              ]}
            />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function alertLabel(alert: ProjectAlert) {
  return projectAlertTypeLabel(alert.type, Boolean(alert.endpointId));
}

function alertElementId(alertId: string) {
  return `alert-${alertId.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`;
}

function alertInvestigation(
  alert: ProjectAlert,
  projectBasePath: string,
  canViewAudit: boolean
): { href: string; label: string } | null {
  if (alert.type === "endpoint_failure") {
    return {
      href: `${projectBasePath}/endpoints${
        alert.endpointId
          ? `?endpointId=${encodeURIComponent(alert.endpointId)}`
          : ""
      }`,
      label: "Open endpoint"
    };
  }
  if (alert.type === "provider_failure") {
    return canViewAudit ? {
      href: `${projectBasePath}/audit?action=provider.request&status=rejected`,
      label: "View provider failures"
    } : null;
  }
  if (alert.type === "sandbox_failure") {
    return canViewAudit ? {
      href: `${projectBasePath}/audit?action=sandbox.failed&status=accepted`,
      label: "View sandbox failures"
    } : null;
  }
  return {
    href: alert.endpointId
      ? `${projectBasePath}/usage?endpointId=${encodeURIComponent(alert.endpointId)}`
      : `${projectBasePath}/usage`,
    label: "Investigate usage"
  };
}

function capitalize(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

function isChangedActiveAlert(reason: unknown) {
  return (
    reason instanceof ApiError &&
    reason.status === 404 &&
    reason.message === "Active project alert not found"
  );
}

function nextRequestId(
  generations: {
    current: { list: number; lookup: number; mutation: number };
  },
  domain: "list" | "lookup" | "mutation"
) {
  generations.current[domain] += 1;
  return `${domain}:${generations.current[domain]}`;
}
