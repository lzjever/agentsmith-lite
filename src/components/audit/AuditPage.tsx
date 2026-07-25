"use client";

import {
  Badge,
  Banner,
  Button,
  DateTimeInput,
  EmptyState,
  IconButton,
  Selector,
  Text,
  TextInput,
  type ISODateTimeString,
} from "@astryxdesign/core";
import { ClipboardList, RefreshCw, SlidersHorizontal, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  PROJECT_AUDIT_ACTIONS,
  PROJECT_AUDIT_RESOURCE_KINDS,
  type ProjectAuditAction,
  type ProjectAuditResourceKind,
} from "../../../packages/contracts/src/api";
import {
  apiClient,
  type ProjectAuditEvent,
  type ProjectAuditQuery,
} from "../../lib/api/client";
import { formatLocalDateTime } from "../../lib/format/date";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { Dialog } from "../ui/Dialog";
import { AuditIdentityPicker } from "./AuditIdentityPicker";
import {
  auditIdentityPresentationLabel,
  formatAuditIdentityLabel,
  type AuditIdentityPresentation,
} from "./auditIdentityPickerState";
import {
  AUDIT_PAGE_SIZE,
  auditFiltersEqual,
  createAuditPageState,
  emptyAuditFilters,
  reduceAuditPageState,
  type AuditFilters,
} from "./auditPageState";
import {
  auditCanonicalNavigation,
  auditCommittedNavigation,
  auditTimeInputValue,
  auditTimeValueFromInput,
  parseAuditPageFilters,
} from "./auditPageUrl";

const actionOptions = ["", ...PROJECT_AUDIT_ACTIONS] as const;
const resourceKindOptions = ["", ...PROJECT_AUDIT_RESOURCE_KINDS] as const;
const resultOptions = ["", "accepted", "rejected"] as const;

export function AuditPage({ projectId }: { projectId: string }) {
  return <ProjectAuditPage key={projectId} projectId={projectId} />;
}

function ProjectAuditPage({ projectId }: { projectId: string }) {
  const routeSearchParams = useSearchParams();
  const initialFilters = parseAuditPageFilters(
    routeSearchParams?.toString() ??
      (typeof window === "undefined" ? "" : window.location.search),
  );
  const [state, dispatch] = useReducer(
    reduceAuditPageState,
    createAuditPageState(initialFilters),
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [timezone, setTimezone] = useState("your local timezone");
  const [resourceIdDraft, setResourceIdDraft] = useState(
    initialFilters.resourceId ?? "",
  );
  const [identityPresentations, setIdentityPresentations] = useState<{
    actor: AuditIdentityPresentation | null;
    subject: AuditIdentityPresentation | null;
  }>({
    actor: null,
    subject: null,
  });
  const mounted = useRef(true);
  const requestGeneration = useRef(0);

  const handleActorIdentityResolved = useCallback(
    (presentation: AuditIdentityPresentation) => {
      setIdentityPresentations((current) => ({
        ...current,
        actor: presentation,
      }));
    },
    [],
  );
  const handleSubjectIdentityResolved = useCallback(
    (presentation: AuditIdentityPresentation) => {
      setIdentityPresentations((current) => ({
        ...current,
        subject: presentation,
      }));
    },
    [],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setResourceIdDraft(state.filters.resourceId ?? "");
  }, [state.filters.resourceId]);

  useEffect(() => {
    setTimezone(
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
        "your local timezone",
    );
  }, []);

  useEffect(() => {
    if (!state.list.pending) return;
    const requestId = `audit-list:${++requestGeneration.current}`;
    const query = state.candidateQuery;
    dispatch({ type: "list_request_started", requestId });
    void apiClient
      .audit(projectId, auditClientQuery(query))
      .then((page) => {
        if (!mounted.current) return;
        dispatch({
          type: "list_request_succeeded",
          requestId,
          rows: page.items,
          nextCursor: page.nextCursor,
        });
      })
      .catch((reason) => {
        if (!mounted.current) return;
        dispatch({
          type: "list_request_failed",
          requestId,
          message:
            reason instanceof Error
              ? reason.message
              : "Audit events could not be loaded.",
        });
      })
      .finally(() => {
        if (mounted.current) {
          dispatch({ type: "list_request_finished", requestId });
        }
      });
  }, [projectId, state.candidateQuery, state.list.pending]);

  useEffect(() => {
    const navigation = auditCanonicalNavigation(
      window.location.href,
      state.filters,
    );
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (navigation.href !== current) {
      window.history.replaceState(
        window.history.state,
        "",
        navigation.href,
      );
    }
  }, [state.filters]);

  useEffect(() => {
    const handlePopState = () => {
      dispatch({
        type: "route_changed",
        filters: parseAuditPageFilters(window.location.search),
      });
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const activeFilters = auditFilterChips(
    state.filters,
    identityPresentations,
  );
  const pageMatchesFilters = Boolean(
    state.query && auditFiltersEqual(state.query.filters, state.filters),
  );
  const fromInput = auditTimeInputValue(state.filters.from);
  const throughInput = auditTimeInputValue(state.filters.to);

  function commitFilters(filters: AuditFilters) {
    if (auditFiltersEqual(filters, state.filters)) return;
    const navigation = auditCommittedNavigation(
      window.location.href,
      filters,
    );
    window.history.pushState(window.history.state, "", navigation.href);
    dispatch({ type: "filters_committed", filters });
  }

  function commitPatch(patch: Partial<AuditFilters>) {
    commitFilters({ ...state.filters, ...patch });
  }

  function applyResourceId(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = resourceIdDraft.trim();
    commitPatch({ resourceId: value || null });
  }

  return (
    <PageLayout
      header={
        <PageHeader
          title="Audit"
          subtitle="Review project activity by actor, resource, and result."
          actions={
            <IconButton
              label="Refresh audit"
              tooltip="Refresh audit"
              variant="ghost"
              size="lg"
              icon={<RefreshCw size={16} />}
              onClick={() => dispatch({ type: "refresh_requested" })}
            />
          }
        />
      }
    >
      <section className="space-y-4" aria-label="Audit events">
        <div className="flex flex-wrap items-center gap-2 border-y border-border py-3">
          <Text type="supporting" color="secondary">
            Scope
          </Text>
          {activeFilters.length === 0 ? (
            <Badge label="All events" variant="neutral" />
          ) : (
            activeFilters.map((filter) => (
              <Button
                key={filter.key}
                label={filter.label}
                variant="secondary"
                size="sm"
                icon={<X size={13} />}
                onClick={() => commitPatch({ [filter.key]: null })}
              />
            ))
          )}
          <Button
            className="ml-auto"
            label="Clear all"
            variant="ghost"
            size="sm"
            isDisabled={activeFilters.length === 0}
            onClick={() => commitFilters(emptyAuditFilters())}
          />
          <Text type="supporting" color="secondary" className="basis-full">
            Times shown in {timezone}.
          </Text>
        </div>

        <Button
          label={`Filters${activeFilters.length ? ` (${activeFilters.length})` : ""}`}
          className="w-fit sm:hidden"
          variant="secondary"
          size="lg"
          icon={<SlidersHorizontal size={16} />}
          aria-expanded={filtersOpen}
          aria-controls="audit-filters"
          onClick={() => setFiltersOpen((open) => !open)}
        />

        <div
          id="audit-filters"
          className={`${filtersOpen ? "grid" : "hidden"} gap-4 border-b border-border pb-4 sm:grid md:grid-cols-2 xl:grid-cols-4`}
        >
          <AuditIdentityPicker
            projectId={projectId}
            role="actor"
            label="Actor"
            value={state.filters.actorId}
            onChange={(actorId) => commitPatch({ actorId })}
            onIdentityResolved={handleActorIdentityResolved}
          />
          <AuditIdentityPicker
            projectId={projectId}
            role="subject"
            label="Sandbox user"
            value={state.filters.subjectUserId}
            onChange={(subjectUserId) => commitPatch({ subjectUserId })}
            onIdentityResolved={handleSubjectIdentityResolved}
          />
          <AuditEnumFilter
            label="Action"
            value={state.filters.action ?? ""}
            values={actionOptions}
            formatValue={auditActionLabel}
            onChange={(action) =>
              commitPatch({
                action: action ? (action as ProjectAuditAction) : null,
              })
            }
          />
          <AuditEnumFilter
            label="Result"
            value={state.filters.status ?? ""}
            values={resultOptions}
            formatValue={auditResultLabel}
            onChange={(status) =>
              commitPatch({
                status:
                  status === "accepted" || status === "rejected"
                    ? status
                    : null,
              })
            }
          />
          <AuditEnumFilter
            label="Resource type"
            value={state.filters.resourceKind ?? ""}
            values={resourceKindOptions}
            formatValue={auditResourceLabel}
            onChange={(resourceKind) =>
              commitPatch({
                resourceKind: resourceKind
                  ? (resourceKind as ProjectAuditResourceKind)
                  : null,
              })
            }
          />
          <form className="grid content-start gap-2" onSubmit={applyResourceId}>
            <Text type="label" color="secondary">
              Exact Resource ID
            </Text>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <TextInput
                label="Exact Resource ID"
                isLabelHidden
                value={resourceIdDraft}
                onChange={setResourceIdDraft}
                size="lg"
                width="100%"
              />
              <Button
                label="Apply"
                type="submit"
                variant="secondary"
                size="lg"
                isDisabled={
                  resourceIdDraft.trim() ===
                  (state.filters.resourceId ?? "")
                }
              />
            </div>
          </form>
          <DateTimeInput
            label="From"
            {...(fromInput
              ? { value: fromInput as ISODateTimeString }
              : {})}
            {...(throughInput
              ? { max: throughInput as ISODateTimeString }
              : {})}
            onChange={(value) =>
              commitPatch({
                from: auditTimeValueFromInput(value ?? "", "from"),
              })
            }
            isOptional
            hasClear
            hourFormat="24h"
            size="lg"
            width="100%"
          />
          <DateTimeInput
            label="Through"
            {...(throughInput
              ? { value: throughInput as ISODateTimeString }
              : {})}
            {...(fromInput
              ? { min: fromInput as ISODateTimeString }
              : {})}
            onChange={(value) =>
              commitPatch({
                to: auditTimeValueFromInput(value ?? "", "through"),
              })
            }
            isOptional
            hasClear
            hourFormat="24h"
            size="lg"
            width="100%"
          />
        </div>

        {state.list.error ? (
          <Banner
            status="error"
            title="Audit events could not be loaded"
            description={
              state.list.hasLoaded
                ? "Prior results remain shown. Retry the attempted query."
                : state.list.error
            }
            endContent={
              <Button
                label="Retry"
                variant="ghost"
                onClick={() => dispatch({ type: "retry_requested" })}
              />
            }
          />
        ) : null}

        {state.list.loading && state.page.rows.length > 0 ? (
          <Text role="status" type="supporting" color="secondary">
            Updating audit events...
          </Text>
        ) : null}

        {!state.list.hasLoaded &&
        (state.list.loading || state.list.pending) ? (
          <div className="grid min-h-48 place-items-center" role="status">
            <Text color="secondary">Loading audit events...</Text>
          </div>
        ) : null}

        {state.list.hasLoaded &&
        !state.list.loading &&
        !state.list.pending &&
        !state.list.error &&
        state.page.rows.length === 0 ? (
          <EmptyState
            icon={<ClipboardList />}
            title="No audit events"
            description="No audit events match this scope."
          />
        ) : null}

        {state.page.rows.length > 0 ? (
          <ul className="divide-y divide-border border-y border-border">
            {state.page.rows.map((event) => (
              <AuditEventRow
                key={event.id}
                event={event}
                onOpen={() =>
                  dispatch({
                    type: "selected_event_changed",
                    event,
                  })
                }
              />
            ))}
          </ul>
        ) : null}

        {state.page.rows.length > 0 ? (
          <nav
            className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"
            aria-label="Audit pages"
          >
            <Button
              label="Previous"
              variant="ghost"
              size="md"
              isDisabled={
                state.list.loading ||
                state.list.pending ||
                !pageMatchesFilters ||
                state.page.cursorStack.length === 0
              }
              onClick={() => dispatch({ type: "previous_page" })}
            />
            <Text type="supporting" color="secondary">
              {auditPageStatus(
                state.page.pageNumber,
                state.page.rows.length,
                state.page.nextCursor !== null,
              )}
            </Text>
            <Button
              label="Next"
              variant="ghost"
              size="md"
              isDisabled={
                state.list.loading ||
                state.list.pending ||
                !pageMatchesFilters ||
                !state.page.nextCursor
              }
              onClick={() => dispatch({ type: "next_page" })}
            />
          </nav>
        ) : null}
      </section>

      <AuditDetailDialog
        event={state.selectedEvent}
        onClose={() =>
          dispatch({ type: "selected_event_changed", event: null })
        }
      />
    </PageLayout>
  );
}

function AuditEventRow({
  event,
  onOpen,
}: {
  event: ProjectAuditEvent;
  onOpen: () => void;
}) {
  return (
    <li className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Text weight="semibold" wordBreak="break-word">
            {auditActionLabel(event.action)}
          </Text>
          <Badge
            variant={event.status === "rejected" ? "error" : "neutral"}
            label={auditResultLabel(event.status)}
          />
        </div>
        <Text
          display="block"
          type="supporting"
          color="secondary"
          className="mt-1"
        >
          {formatLocalDateTime(event.createdAt)}
        </Text>
        <dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
          <AuditRowDatum label="Actor" value={actorName(event)} />
          <AuditRowDatum label="Sandbox user" value={subjectName(event)} />
          <AuditRowDatum
            label="Resource"
            value={auditResourceDisplay(event)}
          />
        </dl>
      </div>
      <Button
        className="justify-self-start sm:justify-self-end"
        label="View details"
        variant="secondary"
        size="sm"
        onClick={onOpen}
      />
    </li>
  );
}

function AuditRowDatum({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>
        <Text type="supporting" color="secondary">
          {label}
        </Text>
      </dt>
      <dd>
        <Text type="supporting" wordBreak="break-all">
          {value}
        </Text>
      </dd>
    </>
  );
}

function AuditEnumFilter({
  label,
  value,
  values,
  formatValue,
  onChange,
}: {
  label: string;
  value: string;
  values: readonly string[];
  formatValue: (value: string) => string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid content-start gap-2">
      <Text type="label" color="secondary">
        {label}
      </Text>
      <Selector
        label={label}
        isLabelHidden
        options={values.map((item) => ({
          value: item,
          label: item
            ? formatValue(item)
            : `All ${label.toLowerCase()}s`,
        }))}
        value={value}
        onChange={onChange}
        size="lg"
      />
    </div>
  );
}

function AuditDetailDialog({
  event,
  onClose,
}: {
  event: ProjectAuditEvent | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      isOpen={event !== null}
      onOpenChange={(open) => !open && onClose()}
      mode="info"
      title="Audit event detail"
      subtitle="Immutable event data for this project activity."
    >
      {event ? (
        <dl className="grid gap-3 sm:grid-cols-[8rem_1fr]">
          <AuditDetail label="Timestamp" value={event.createdAt} />
          <AuditDetail
            label="Action"
            value={auditActionLabel(event.action)}
          />
          <AuditDetail label="Action ID" value={event.action} />
          <AuditDetail label="Actor" value={actorName(event)} />
          <AuditDetail label="Sandbox user" value={subjectName(event)} />
          <AuditDetail
            label="Resource type"
            value={auditResourceLabel(event.resourceKind)}
          />
          <AuditDetail label="Resource ID" value={event.resourceId ?? "-"} />
          <AuditDetail label="Result" value={auditResultLabel(event.status)} />
          {Object.entries(event.detail ?? {}).map(([key, value]) => (
            <AuditDetail
              key={key}
              label={auditDetailLabel(key)}
              value={auditDetailValue(key, value)}
            />
          ))}
        </dl>
      ) : null}
    </Dialog>
  );
}

function AuditDetail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>
        <Text type="supporting" color="secondary">
          {label}
        </Text>
      </dt>
      <dd className="break-all">
        <Text type="code">{value}</Text>
      </dd>
    </>
  );
}

function auditClientQuery(
  query: ReturnType<typeof createAuditPageState>["candidateQuery"],
): ProjectAuditQuery {
  const filters = query.filters;
  return {
    limit: AUDIT_PAGE_SIZE,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(filters.actorId
      ? { actorId: filters.actorId === "system" ? null : filters.actorId }
      : {}),
    ...(filters.subjectUserId
      ? { subjectUserId: filters.subjectUserId }
      : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.resourceKind
      ? { resourceKind: filters.resourceKind }
      : {}),
    ...(filters.resourceId ? { resourceId: filters.resourceId } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
  };
}

function auditFilterChips(
  filters: AuditFilters,
  identityPresentations: {
    actor: AuditIdentityPresentation | null;
    subject: AuditIdentityPresentation | null;
  },
): Array<{
  key: keyof AuditFilters;
  label: string;
}> {
  return [
    ...(filters.actorId
      ? [
          {
            key: "actorId" as const,
            label: `Actor: ${
              filters.actorId === "system"
                ? "System"
                : auditIdentityPresentationLabel(
                    filters.actorId,
                    identityPresentations.actor,
                  )
            }`,
          },
        ]
      : []),
    ...(filters.subjectUserId
      ? [
          {
            key: "subjectUserId" as const,
            label: `Sandbox user: ${auditIdentityPresentationLabel(
              filters.subjectUserId,
              identityPresentations.subject,
            )}`,
          },
        ]
      : []),
    ...(filters.action
      ? [
          {
            key: "action" as const,
            label: `Action: ${auditActionLabel(filters.action)}`,
          },
        ]
      : []),
    ...(filters.status
      ? [
          {
            key: "status" as const,
            label: `Result: ${auditResultLabel(filters.status)}`,
          },
        ]
      : []),
    ...(filters.resourceKind
      ? [
          {
            key: "resourceKind" as const,
            label: `Resource: ${auditResourceLabel(filters.resourceKind)}`,
          },
        ]
      : []),
    ...(filters.resourceId
      ? [
          {
            key: "resourceId" as const,
            label: `Resource ID: ${filters.resourceId}`,
          },
        ]
      : []),
    ...(filters.from
      ? [
          {
            key: "from" as const,
            label: `From: ${auditTimeInputValue(filters.from).replace("T", " ")}`,
          },
        ]
      : []),
    ...(filters.to
      ? [
          {
            key: "to" as const,
            label: `Through: ${auditTimeInputValue(filters.to).replace("T", " ")}`,
          },
        ]
      : []),
  ];
}

function auditPageStatus(
  pageNumber: number,
  rowCount: number,
  hasMore: boolean,
): string {
  const first = (pageNumber - 1) * AUDIT_PAGE_SIZE + 1;
  const last = first + rowCount - 1;
  return `Events ${first}-${last} · Page ${pageNumber} · ${
    hasMore ? "More available" : "End of history"
  }`;
}

function actorName(event: ProjectAuditEvent): string {
  return event.actorId === null
    ? "System"
    : formatAuditIdentityLabel(
        event.actorId,
        event.actorDisplayName,
        event.actorEmail,
      );
}

function subjectName(event: ProjectAuditEvent): string {
  return event.subjectUserId
    ? formatAuditIdentityLabel(
        event.subjectUserId,
        event.subjectDisplayName,
        event.subjectEmail,
      )
    : "-";
}

function auditResourceDisplay(event: ProjectAuditEvent): string {
  return event.resourceId
    ? `${auditResourceLabel(event.resourceKind)}: ${event.resourceId}`
    : event.resourceKind === "provider"
      ? "Project-level provider activity"
      : "-";
}

const auditActionLabels: Record<ProjectAuditAction, string> = {
  "project.settings.update": "Updated project settings",
  "project.archive": "Archived project",
  "project.unarchive": "Restored project",
  "project.owner.transfer": "Transferred project ownership",
  "project.delete": "Deleted project",
  "policy.update": "Updated resource policy",
  "credential.create": "Created credential",
  "credential.rotate": "Rotated credential",
  "credential.delete": "Deleted credential",
  "endpoint.create": "Created endpoint",
  "endpoint.update": "Updated endpoint",
  "endpoint.delete": "Deleted endpoint",
  "endpoint.health_check": "Checked endpoint health",
  "endpoint.model_discover": "Discovered endpoint models",
  "membership.add": "Added project member",
  "membership.change": "Changed project member",
  "membership.remove": "Removed project member",
  "provider.request": "Called model provider",
  "task.create": "Created task",
  "task.edit": "Edited task",
  "task.archive": "Archived task",
  "task.delete": "Deleted task",
  "task.message.create": "Sent task message",
  "task.message.edit": "Edited task message",
  "task.message.delete": "Deleted task message",
  "artifact.project": "Projected task artifact",
  "sandbox.started": "Started sandbox",
  "sandbox.failed": "Sandbox failed",
  "sandbox.released": "Released sandbox",
  "file.upload": "Uploaded file",
  "file.delete": "Deleted file",
  "file_library.delete": "Deleted File Library",
  "file.quota": "Reached file quota",
  "alert.resolve": "Resolved alert",
  "alert.dismiss": "Dismissed alert",
  "alert.rule.create": "Created alert rule",
  "alert.rule.update": "Updated alert rule",
  "alert.rule.delete": "Deleted alert rule",
  "alert.acknowledge": "Acknowledged alert",
  "alert.silence": "Silenced alert",
};

const auditResourceLabels: Record<ProjectAuditResourceKind, string> = {
  project: "Project",
  credential: "Credential",
  endpoint: "Endpoint",
  member: "Project member",
  task: "Task",
  artifact: "Task artifact",
  provider: "Model provider",
  file: "File",
  file_quota: "File quota",
  sandbox: "Sandbox",
  alert: "Alert",
};

const auditDetailLabels: Record<string, string> = {
  endpointId: "Endpoint ID",
  alertRuleId: "Alert rule ID",
  alertId: "Alert ID",
  taskId: "Task ID",
  runId: "Run ID",
  releaseReason: "Release reason",
  messageId: "Message ID",
  deliveryStatus: "Delivery status",
  credentialVersion: "Credential version",
  healthStatus: "Health status",
  errorCategory: "Error category",
  modelCount: "Model count",
  filePath: "File path",
  bytes: "Bytes",
  mediaType: "Media type",
  metric: "Metric",
  current: "Current",
  limit: "Limit",
  windowSeconds: "Window seconds",
};

function auditActionLabel(value: string): string {
  return value in auditActionLabels
    ? auditActionLabels[value as ProjectAuditAction]
    : humanizeAuditToken(value);
}

function auditResourceLabel(value: string): string {
  return value in auditResourceLabels
    ? auditResourceLabels[value as ProjectAuditResourceKind]
    : humanizeAuditToken(value);
}

function auditResultLabel(value: string): string {
  return value === "accepted"
    ? "Accepted"
    : value === "rejected"
      ? "Rejected"
      : humanizeAuditToken(value);
}

function auditDetailLabel(key: string): string {
  return auditDetailLabels[key] ?? humanizeAuditToken(key);
}

function auditDetailValue(key: string, value: string | number): string {
  return key === "releaseReason"
    ? humanizeAuditToken(String(value))
    : String(value);
}

function humanizeAuditToken(value: string): string {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (character) => character.toUpperCase());
}
