"use client";

import { ClipboardList, ExternalLink, RefreshCw, SlidersHorizontal, X } from "lucide-react";
import {
  Badge,
  Banner,
  Button,
  DateTimeInput,
  DialogHeader,
  EmptyState,
  Heading,
  IconButton,
  Layout,
  LayoutContent,
  Selector,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  type ISODateTimeString,
} from "@astryxdesign/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PROJECT_AUDIT_ACTIONS,
  PROJECT_AUDIT_RESOURCE_KINDS,
} from "../../../packages/contracts/src/api";
import {
  ApiError,
  apiClient,
  type ProjectAuditEvent,
  type ProjectMember,
  type ProjectUsageOverview,
} from "../../lib/api/client";
import { Dialog } from "../ui/Dialog";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { formatLocalDateTime as formatDate } from "../../lib/format/date";
import { UsageView } from "./UsageView";
import { auditResourceIdentity } from "./audit-resource-identity";
import {
  auditTimeInputFromQuery,
  auditTimeQueryFromInput,
} from "./audit-time-filter";

export function UsagePage({ projectId }: { projectId: string }) {
  return <UsageProjectPage key={projectId} projectId={projectId} />;
}

type UsageProvenance = {
  projectId: string;
  userId: string;
  endpointId: string;
  overview: ProjectUsageOverview;
};

function UsageProjectPage({ projectId }: { projectId: string }) {
  const [usage, setUsage] = useState<UsageProvenance>();
  const [endpointId, setEndpointId] = useState(() => browserQuery().get("endpointId") || "all");
  const [selectedUserId, setSelectedUserId] = useState<string>();
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [canSelectUser, setCanSelectUser] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [state, setState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const active = useRef(true);
  const requestRevision = useRef(0);
  const accessRevision = useRef(0);
  const userScope = selectedUserId ?? "self";
  const visibleUsage = usage?.projectId === projectId && usage.userId === userScope && usage.endpointId === endpointId ? usage.overview : undefined;

  const load = useCallback(async () => {
    const revision = ++requestRevision.current;
    const requestedProjectId = projectId;
    const requestedUserId = selectedUserId ?? "self";
    const requestedEndpointId = endpointId;
    setState("loading");
    setError(undefined);
    try {
      const loaded = await apiClient.usage(projectId, {
        ...(endpointId === "all" ? {} : { endpointId }),
        ...(selectedUserId ? { userId: selectedUserId } : {}),
      });
      if (!active.current || revision !== requestRevision.current || requestedProjectId !== projectId) return;
      setUsage({ projectId: requestedProjectId, userId: requestedUserId, endpointId: requestedEndpointId, overview: loaded });
      setError(undefined);
      setState("ready");
    } catch (cause) {
      if (!active.current || revision !== requestRevision.current || requestedProjectId !== projectId) return;
      if (endpointId !== "all" && cause instanceof ApiError && cause.status === 404) {
        const query = browserQuery();
        query.delete("endpointId");
        replaceBrowserQuery(query);
        setEndpointId("all");
        return;
      }
      setError(cause);
      setState("error");
    }
  }, [projectId, endpointId, selectedUserId]);

  useEffect(() => {
    active.current = true;
    const revision = ++accessRevision.current;
    const requestedProjectId = projectId;
    void Promise.all([apiClient.currentIdentity(), apiClient.members(projectId)])
      .then(([identity, listed]) => {
        if (!active.current || revision !== accessRevision.current || requestedProjectId !== projectId) return;
        const current = listed.find((member) => member.userId === identity.user.id);
        setMembers(listed);
        setCurrentUserId(identity.user.id);
        setCanSelectUser(current?.role === "owner" || current?.role === "admin");
      })
      .catch(() => undefined);
    return () => {
      active.current = false;
      requestRevision.current += 1;
      accessRevision.current += 1;
    };
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  function changeEndpoint(nextEndpointId: string) {
    requestRevision.current += 1;
    setError(undefined);
    setState("loading");
    const query = browserQuery();
    if (nextEndpointId === "all") query.delete("endpointId");
    else query.set("endpointId", nextEndpointId);
    replaceBrowserQuery(query);
    setEndpointId(nextEndpointId);
  }

  function changeUser(userId: string) {
    requestRevision.current += 1;
    setError(undefined);
    setState("loading");
    setSelectedUserId(userId === currentUserId ? undefined : userId);
  }

  return (
    <PageLayout
      header={
        <PageHeader
          title="Usage"
          subtitle="Your provider activity with project-wide limits."
          actions={
            <IconButton
              label="Refresh usage"
              tooltip="Refresh usage"
              variant="ghost"
              icon={<RefreshCw size={16} />}
              onClick={() => void load()}
            />
          }
        />
      }
    >
      {canSelectUser && currentUserId ? (
        <div className="flex justify-end border-y border-border py-3">
          <div className="grid gap-1 text-secondary">
            <Text type="label" color="secondary">Sandbox member</Text>
            <Selector
              label="Sandbox usage member"
              isLabelHidden
              options={members.map((member) => ({ value: member.userId, label: memberLabel(member) }))}
              value={selectedUserId ?? currentUserId}
              onChange={changeUser}
              size="lg"
              className="w-64 max-w-full"
            />
          </div>
        </div>
      ) : null}
      {state === "loading" && !visibleUsage ? (
        <div className="grid min-h-64 place-items-center" role="status"><Text color="secondary">Loading usage...</Text></div>
      ) : null}
      {state === "loading" && visibleUsage ? (
        <div className="border-y border-border px-3 py-2 text-secondary" role="status"><Text type="supporting" color="secondary">Refreshing usage...</Text></div>
      ) : null}
      {state === "error" && !visibleUsage ? (
        <Banner status="error" title={usageError(error).title} description={usageError(error).message} endContent={<Button label="Try again" variant="ghost" onClick={() => void load()} />} />
      ) : null}
      {visibleUsage ? (
        <div className="space-y-7">
          {state === "error" ? <InlineUsageError error={error} onRetry={load} /> : null}
          <SandboxUsageView
            projectId={projectId}
            usage={visibleUsage}
            members={members}
          />
          <UsageView overview={visibleUsage} selectedEndpointId={endpointId} onEndpointChange={changeEndpoint} />
        </div>
      ) : null}
    </PageLayout>
  );
}

function SandboxUsageView({
  projectId,
  usage,
  members,
}: {
  projectId: string;
  usage: ProjectUsageOverview;
  members: ProjectMember[];
}) {
  const sandbox = usage.sandbox;
  const selectedMember = members.find((member) => member.userId === sandbox.selectedUserId);
  return (
    <section className="space-y-4 border-y border-border py-5" aria-labelledby="sandbox-usage">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Heading level={2} id="sandbox-usage">Sandbox usage</Heading>
          <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">
            Task sandbox runtime and requested resources for {selectedMember ? memberLabel(selectedMember) : "you"}.
          </Text>
        </div>
      </div>
      <dl className="grid overflow-hidden border border-border sm:grid-cols-2 xl:grid-cols-5">
        <SandboxTotal label="Active" value={formatInteger(String(sandbox.activeCount))} />
        <SandboxTotal label="Launches" value={formatInteger(String(sandbox.launches))} />
        <SandboxTotal label="Total runtime" value={`${formatDecimal(sandbox.totalDurationSeconds)} s`} />
        <SandboxTotal label="CPU request-time" value={`${formatDecimal(sandbox.cpuRequestSeconds)} CPU-s`} />
        <SandboxTotal label="Memory request-time" value={`${formatDecimal(sandbox.memoryRequestByteSeconds, 1_073_741_824n)} GiB-s`} />
      </dl>
      {sandbox.rows.length ? (
        <Table aria-label="Sandbox runs" density="balanced" dividers="rows" verticalAlign="top">
          <TableHeader><TableRow isHeaderRow><TableHeaderCell>Task and run</TableHeaderCell><TableHeaderCell>State</TableHeaderCell><TableHeaderCell>Started</TableHeaderCell><TableHeaderCell>Released</TableHeaderCell><TableHeaderCell>Duration</TableHeaderCell><TableHeaderCell>Resources</TableHeaderCell></TableRow></TableHeader>
          <TableBody>{sandbox.rows.map((row) => <TableRow key={row.runId}><TableCell><div className="min-w-0">{row.taskAvailable ? <a className="inline-flex max-w-full items-center gap-1 hover:underline" href={taskHref(projectId, row.taskId)}><Text weight="medium" maxLines={1}>Task {row.taskId}</Text><ExternalLink className="size-3 shrink-0" /></a> : <span title="This task was deleted"><Text type="supporting" color="secondary">Task {row.taskId} (deleted)</Text></span>}<span className="mt-1 block" title={row.runId}><Text type="code" color="secondary" display="block" maxLines={1}>Run {row.runId}</Text></span></div></TableCell><TableCell><Badge variant={row.state === "live" ? "success" : "neutral"} label={row.state === "live" ? "Live" : "Settled"} /></TableCell><TableCell>{row.startedAt ? formatDate(row.startedAt) : "-"}</TableCell><TableCell>{row.releasedAt ? formatDate(row.releasedAt) : "-"}</TableCell><TableCell>{formatDuration(row.durationSeconds)}</TableCell><TableCell><Text display="block">{formatInteger(row.resources.cpuRequestMillis)} mCPU · {formatBytes(row.resources.memoryRequestBytes)} requested</Text><Text type="supporting" color="secondary" display="block" className="mt-1">Limits {formatInteger(row.resources.cpuLimitMillis)} mCPU · {formatBytes(row.resources.memoryLimitBytes)}</Text></TableCell></TableRow>)}</TableBody>
        </Table>
      ) : <EmptyState className="border border-dashed border-border" isCompact title="No sandbox runs" description="No sandbox runs for this member." />}
    </section>
  );
}

function SandboxTotal({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 border-b border-border p-4 sm:border-r xl:border-b-0"><dt><Text type="supporting" color="secondary">{label}</Text></dt><dd className="mt-2 break-words"><Text type="large">{value}</Text></dd></div>;
}

function InlineUsageError({ error, onRetry }: { error: unknown; onRetry: () => Promise<void> }) {
  const copy = usageError(error);
  return <Banner status="error" title={copy.title} description={copy.message} endContent={<Button label="Retry" variant="ghost" size="md" onClick={() => void onRetry()} />} />;
}

function usageError(error: unknown): { title: string; message: string } {
  if (error instanceof ApiError && error.status === 503 && error.code === "sandbox_usage_unavailable") return { title: "Sandbox usage unavailable", message: "Sandbox accounting is temporarily unavailable. Retry after the run state is reconciled." };
  if (error instanceof ApiError && error.status === 403) return { title: "Sandbox usage not permitted", message: "You do not have permission to view that member's sandbox usage." };
  if (error instanceof ApiError && error.status === 404) return { title: "Usage scope not found", message: "The selected member or endpoint is no longer available." };
  return { title: "Usage unavailable", message: "Usage could not be loaded." };
}

function memberLabel(member: ProjectMember): string {
  return member.displayName ? `${member.displayName} (${member.email})` : member.email;
}

function taskHref(_projectId: string, taskId: string): string {
  const pathname = typeof window === "undefined" ? "" : window.location.pathname;
  const projectBase = /^(.*)\/usage\/?$/.exec(pathname)?.[1] || "..";
  return `${projectBase}/tasks/${encodeURIComponent(taskId)}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "-";
  if (seconds < 60) return `${seconds.toLocaleString(undefined, { maximumFractionDigits: 3 })} s`;
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${remainder}s`].filter(Boolean).join(" ");
}

function formatBytes(value: string): string {
  if (!/^\d+$/.test(value)) return value;
  const bytes = BigInt(value);
  if (bytes >= 1_073_741_824n) return `${formatDecimal(value, 1_073_741_824n)} GiB`;
  if (bytes >= 1_048_576n) return `${formatDecimal(value, 1_048_576n)} MiB`;
  if (bytes >= 1_024n) return `${formatDecimal(value, 1_024n)} KiB`;
  return `${formatInteger(value)} B`;
}

function formatInteger(value: string): string {
  if (!/^\d+$/.test(value)) return value;
  return BigInt(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatDecimal(value: string, divisor = 1n, maximumFractionDigits = 2): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || divisor <= 0n) return value;
  const fraction = match[2] ?? "";
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${match[1]}${fraction}`);
  const denominator = scale * divisor;
  const displayScale = 10n ** BigInt(maximumFractionDigits);
  const rounded = (numerator * displayScale + denominator / 2n) / denominator;
  const whole = rounded / displayScale;
  const decimals = (rounded % displayScale).toString().padStart(maximumFractionDigits, "0").replace(/0+$/, "");
  return `${formatInteger(whole.toString())}${decimals ? `.${decimals}` : ""}`;
}

const actions = ["all", ...PROJECT_AUDIT_ACTIONS] as const;
const kinds = ["all", ...PROJECT_AUDIT_RESOURCE_KINDS] as const;
const statuses = ["all", "accepted", "rejected"] as const;

const auditActionLabels: Record<(typeof PROJECT_AUDIT_ACTIONS)[number], string> = {
  "project.settings.update": "Updated project settings", "project.archive": "Archived project", "project.unarchive": "Restored project", "project.owner.transfer": "Transferred project ownership", "project.delete": "Deleted project",
  "policy.update": "Updated resource policy",
  "credential.create": "Created credential", "credential.rotate": "Rotated credential", "credential.delete": "Deleted credential",
  "endpoint.create": "Created endpoint", "endpoint.update": "Updated endpoint", "endpoint.delete": "Deleted endpoint", "endpoint.health_check": "Checked endpoint health", "endpoint.model_discover": "Discovered endpoint models",
  "membership.add": "Added project member", "membership.change": "Changed project member", "membership.remove": "Removed project member",
  "provider.request": "Called model provider",
  "task.create": "Created task", "task.edit": "Edited task", "task.archive": "Archived task", "task.delete": "Deleted task",
  "task.message.create": "Sent task message", "task.message.edit": "Edited task message", "task.message.delete": "Deleted task message",
  "task.historical_terminal": "Historical task terminal",
  "artifact.project": "Projected task artifact", "sandbox.started": "Started sandbox", "sandbox.failed": "Sandbox failed", "sandbox.release_requested": "Requested sandbox release", "sandbox.released": "Released sandbox",
  "file.upload": "Uploaded file", "file.delete": "Deleted file", "file.quota": "Reached file quota",
  "alert.resolve": "Resolved alert", "alert.dismiss": "Dismissed alert", "alert.rule.create": "Created alert rule", "alert.rule.update": "Updated alert rule", "alert.rule.delete": "Deleted alert rule", "alert.acknowledge": "Acknowledged alert", "alert.silence": "Silenced alert"
};

const auditResourceLabels: Record<(typeof PROJECT_AUDIT_RESOURCE_KINDS)[number], string> = {
  project: "Project", credential: "Credential", endpoint: "Endpoint", member: "Project member", task: "Task", artifact: "Task artifact", provider: "Model provider", file: "File", file_quota: "File quota", sandbox: "Sandbox", alert: "Alert"
};

export function AuditPage({ projectId }: { projectId: string }) {
  return <AuditProjectPage key={projectId} projectId={projectId} />;
}

function AuditProjectPage({ projectId }: { projectId: string }) {
  const active = useRef(true);
  const [items, setItems] = useState<ProjectAuditEvent[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [action, setAction] = useState("all");
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState("all");
  const [actorId, setActorId] = useState("all");
  const [subjectUserId, setSubjectUserId] = useState("all");
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [resourceId, setResourceId] = useState("");
  const [queryProjectId, setQueryProjectId] = useState("");
  const [from, setFrom] = useState<ISODateTimeString>();
  const [to, setTo] = useState<ISODateTimeString>();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [selected, setSelected] = useState<ProjectAuditEvent | null>(null);
  const requestRevision = useRef(0);
  const cursor = cursors.at(-1);
  const activeFilterCount = [actorId, subjectUserId, action, status, kind].filter((value) => value !== "all").length + [resourceId, from, to].filter(Boolean).length;

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const load = useCallback(async () => {
    const revision = ++requestRevision.current;
    setState("loading");
    setSelected(null);
    try {
      const fromTimestamp = auditTimeQueryFromInput(from ?? "");
      const toTimestamp = auditTimeQueryFromInput(to ?? "");
      const page = await apiClient.audit(projectId, {
        limit: 20,
        ...(cursor ? { cursor } : {}),
        ...(actorId === "all" ? {} : { actorId }),
        ...(subjectUserId === "all" ? {} : { subjectUserId }),
        ...(action === "all" ? {} : { action }),
        ...(status === "all" ? {} : { status }),
        ...(kind === "all" ? {} : { resourceKind: kind }),
        ...(resourceId ? { resourceId } : {}),
        ...(fromTimestamp ? { from: fromTimestamp } : {}),
        ...(toTimestamp ? { to: toTimestamp } : {}),
      });
      if (!active.current || revision !== requestRevision.current) return;
      setItems(page.items);
      setNext(page.nextCursor);
      setState("ready");
    } catch {
      if (!active.current || revision !== requestRevision.current) return;
      setState("error");
    }
  }, [projectId, cursor, actorId, subjectUserId, action, status, kind, resourceId, from, to]);

  useEffect(() => {
    requestRevision.current += 1;
    const query = browserQuery();
    const requestedAction = query.get("action");
    const requestedKind = query.get("resourceKind");
    const requestedStatus = query.get("status");
    const requestedActor = query.get("actorId");
    const requestedSubject = query.get("subjectUserId");
    setAction(
      requestedAction &&
        PROJECT_AUDIT_ACTIONS.includes(
          requestedAction as (typeof PROJECT_AUDIT_ACTIONS)[number],
        )
        ? requestedAction
        : "all",
    );
    setKind(
      requestedKind &&
        PROJECT_AUDIT_RESOURCE_KINDS.includes(
          requestedKind as (typeof PROJECT_AUDIT_RESOURCE_KINDS)[number],
        )
        ? requestedKind
        : "all",
    );
    setStatus(requestedStatus === "accepted" || requestedStatus === "rejected" ? requestedStatus : "all");
    setActorId(requestedActor || "all");
    setSubjectUserId(requestedSubject || "all");
    setResourceId(query.get("resourceId") ?? "");
    const fromInput = auditTimeInputFromQuery(query.get("from"));
    const toInput = auditTimeInputFromQuery(query.get("to"));
    setFrom(fromInput ? fromInput as ISODateTimeString : undefined);
    setTo(toInput ? toInput as ISODateTimeString : undefined);
    setMembers([]);
    void apiClient.members(projectId).then((listed) => { if (active.current) setMembers(listed); }).catch(() => undefined);
    setCursors([undefined]);
    setQueryProjectId(projectId);
  }, [projectId]);
  useEffect(() => {
    if (queryProjectId === projectId) void load();
  }, [load, projectId, queryProjectId]);

  function reset() {
    setCursors([undefined]);
  }

  function clearResource() {
    const query = browserQuery();
    query.delete("resourceId");
    replaceBrowserQuery(query);
    setResourceId("");
    reset();
  }

  function changeTimeFilter(key: "from" | "to", value: ISODateTimeString | undefined) {
    const query = browserQuery();
    const timestamp = auditTimeQueryFromInput(value ?? "");
    if (timestamp) query.set(key, timestamp);
    else query.delete(key);
    replaceBrowserQuery(query);
    if (key === "from") setFrom(value);
    else setTo(value);
    reset();
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
              onClick={() => void load()}
            />
          }
        />
      }
    >
      {state === "error" ? (
        <Banner status="error" title="Audit unavailable" description="Audit events could not be loaded." endContent={<Button label="Try again" variant="ghost" onClick={() => void load()} />} />
      ) : null}
      <section className="space-y-4">
        {resourceId ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border py-2">
            <Text as="p" type="supporting" color="secondary" display="block">
              Showing events for {linkedResourceLabel(kind, resourceId)} <strong>{resourceId}</strong>.
            </Text>
            <Button
              label="Clear resource filter"
              variant="ghost"
              size="md"
              icon={<X size={14} />}
              onClick={clearResource}
            />
          </div>
        ) : null}
        <Button label={`Filters${activeFilterCount ? ` (${activeFilterCount})` : ""}`} className="w-fit sm:hidden" variant="secondary" size="lg" icon={<SlidersHorizontal size={16} />} aria-expanded={filtersOpen} aria-controls="audit-filters" onClick={() => setFiltersOpen((open) => !open)} />
        <div id="audit-filters" className={`${filtersOpen ? "grid" : "hidden"} gap-3 border-b border-border pb-4 sm:grid md:grid-cols-2 xl:grid-cols-5`}>
          <div className="grid gap-1">
            <Text type="label" color="secondary">Actor</Text>
            <Selector
              label="Actor"
              isLabelHidden
              options={[{ value: "all", label: "All actors" }, ...auditActors(members, items, actorId).map((actor) => ({ value: actor.id, label: actor.label }))]}
              value={actorId}
              onChange={(value) => {
                const query = browserQuery();
                if (value === "all") query.delete("actorId");
                else query.set("actorId", value);
                replaceBrowserQuery(query);
                setActorId(value);
                reset();
              }}
              size="lg"
            />
          </div>
          <div className="grid gap-1">
            <Text type="label" color="secondary">Resource user</Text>
            <Selector
              label="Resource user"
              isLabelHidden
              options={[{ value: "all", label: "All resource users" }, ...auditSubjects(members, items, subjectUserId).map((subject) => ({ value: subject.id, label: subject.label }))]}
              value={subjectUserId}
              onChange={(value) => {
                const query = browserQuery();
                if (value === "all") query.delete("subjectUserId");
                else query.set("subjectUserId", value);
                replaceBrowserQuery(query);
                setSubjectUserId(value);
                reset();
              }}
              size="lg"
            />
          </div>
          <Filter
            label="Action"
            value={action}
            onChange={(value) => {
              const query = browserQuery();
              if (value === "all") query.delete("action");
              else query.set("action", value);
              replaceBrowserQuery(query);
              setAction(value);
              reset();
            }}
            values={actions}
            formatValue={auditActionLabel}
          />
          <Filter
            label="Result"
            value={status}
            onChange={(value) => {
              const query = browserQuery();
              if (value === "all") query.delete("status");
              else query.set("status", value);
              replaceBrowserQuery(query);
              setStatus(value);
              reset();
            }}
            values={statuses}
            formatValue={auditResultLabel}
          />
          <Filter
            label="Resource type"
            value={kind}
            onChange={(value) => {
              const query = browserQuery();
              if (value === "all") query.delete("resourceKind");
              else query.set("resourceKind", value);
              query.delete("resourceId");
              replaceBrowserQuery(query);
              setKind(value);
              setResourceId("");
              reset();
            }}
            values={kinds}
            formatValue={auditResourceLabel}
          />
          <DateTimeInput
            label="From"
            {...(from ? { value: from } : {})}
            {...(to ? { max: to } : {})}
            onChange={(value) => changeTimeFilter("from", value)}
            isOptional
            hasClear
            hourFormat="24h"
            size="lg"
            width="100%"
          />
          <DateTimeInput
            label="To"
            {...(to ? { value: to } : {})}
            {...(from ? { min: from } : {})}
            onChange={(value) => changeTimeFilter("to", value)}
            isOptional
            hasClear
            hourFormat="24h"
            size="lg"
            width="100%"
          />
        </div>
        {state === "loading" ? (
          <div className="grid min-h-64 place-items-center" role="status"><Text color="secondary">Loading audit events...</Text></div>
        ) : null}
        {state === "ready" && !items.length ? (
          <EmptyState icon={<ClipboardList />} title="No audit events" description="No audit events match this query." />
        ) : null}
        {state === "ready" && items.length ? (
          <>
            <div className="hidden overflow-x-auto md:block">
              <Table aria-label="Project audit events" density="balanced" dividers="rows" verticalAlign="top">
                <TableHeader>
                  <TableRow isHeaderRow>
                    <TableHeaderCell>Time</TableHeaderCell>
                    <TableHeaderCell>Actor</TableHeaderCell>
                    <TableHeaderCell>Resource user</TableHeaderCell>
                    <TableHeaderCell>Action</TableHeaderCell>
                    <TableHeaderCell>Result</TableHeaderCell>
                    <TableHeaderCell>Resource</TableHeaderCell>
                    <TableHeaderCell />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell><Text type="supporting" color="secondary">{formatDate(event.createdAt)}</Text></TableCell>
                      <TableCell><Text type="supporting" color="secondary" maxLines={1}>{actorName(event)}</Text></TableCell>
                      <TableCell><Text type="supporting" color="secondary" maxLines={1}>{subjectName(event, members)}</Text></TableCell>
                      <TableCell><span title={event.action}><Text weight="semibold">{auditActionLabel(event.action)}<span className="sr-only"> ({event.action})</span></Text></span></TableCell>
                      <TableCell><Badge variant={event.status === "rejected" ? "error" : "neutral"} label={auditResultLabel(event.status)} /></TableCell>
                      <TableCell><Text type="supporting" color="secondary" wordBreak="break-all">{auditResourceDisplay(event)}</Text></TableCell>
                      <TableCell><Button label="View details" variant="ghost" size="sm" onClick={() => setSelected(event)} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <ul className="divide-y divide-border border-y border-border md:hidden" aria-label="Project audit events">
              {items.map((event) => (
                <li key={event.id} className="grid gap-3 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Text display="block" weight="semibold" wordBreak="break-word">{auditActionLabel(event.action)}</Text>
                      <Text display="block" type="supporting" color="secondary" className="mt-1">{formatDate(event.createdAt)}</Text>
                    </div>
                    <Badge className="shrink-0" variant={event.status === "rejected" ? "error" : "neutral"} label={auditResultLabel(event.status)} />
                  </div>
                  <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
                    <dt><Text type="supporting" color="secondary">Actor</Text></dt>
                    <dd><Text type="supporting" wordBreak="break-all">{actorName(event)}</Text></dd>
                    <dt><Text type="supporting" color="secondary">Resource user</Text></dt>
                    <dd><Text type="supporting" wordBreak="break-all">{subjectName(event, members)}</Text></dd>
                    <dt><Text type="supporting" color="secondary">Resource</Text></dt>
                    <dd><Text type="supporting" wordBreak="break-all">{auditResourceDisplay(event)}</Text></dd>
                  </dl>
                  <Button className="justify-self-start" label="View details" variant="secondary" size="sm" onClick={() => setSelected(event)} />
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            label="Previous"
            variant="secondary"
            size="md"
            isDisabled={cursors.length === 1 || state === "loading"}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          />
          <Button
            label="Next"
            variant="secondary"
            size="md"
            isDisabled={!next || state === "loading"}
            onClick={() =>
              next && setCursors((current) => [...current, next])
            }
          />
        </div>
      </section>
      <DetailDialog event={selected} onClose={() => setSelected(null)} />
    </PageLayout>
  );
}

function actorName(event:ProjectAuditEvent):string{return event.actorId===null?"System":event.actorDisplayName||event.actorEmail||event.actorId}
function auditActors(members:ProjectMember[],events:ProjectAuditEvent[],selected:string):Array<{id:string;label:string}>{const actors=new Map<string,string>();actors.set("system","System");for(const member of members)actors.set(member.userId,member.displayName?`${member.displayName} (${member.email})`:member.email);for(const event of events)if(event.actorId)actors.set(event.actorId,event.actorDisplayName?`${event.actorDisplayName} (${event.actorEmail??event.actorId})`:event.actorEmail??event.actorId);if(selected!=="all"&&!actors.has(selected))actors.set(selected,selected);return [...actors].map(([id,label])=>({id,label}))}
function auditSubjects(members:ProjectMember[],events:ProjectAuditEvent[],selected:string):Array<{id:string;label:string}>{const subjects=new Map(members.map((member)=>[member.userId,memberLabel(member)]));for(const event of events)if(event.subjectUserId)subjects.set(event.subjectUserId,subjects.get(event.subjectUserId)??event.subjectUserId);if(selected!=="all"&&!subjects.has(selected))subjects.set(selected,selected);return [...subjects].map(([id,label])=>({id,label}))}
function subjectName(event:ProjectAuditEvent,members:ProjectMember[]):string{if(!event.subjectUserId)return "-";const member=members.find((candidate)=>candidate.userId===event.subjectUserId);return member?memberLabel(member):event.subjectUserId}
function auditResourceDisplay(event:ProjectAuditEvent):string{return event.resourceId?`${auditResourceLabel(event.resourceKind)}: ${event.resourceId}`:auditResourceIdentity(event.resourceKind,event.resourceId)}
function linkedResourceLabel(kind:string,resourceId:string):string{if(kind==="alert")return resourceId.startsWith("alert_rule_")?"alert rule":"alert instance";return `${kind==="all"?"linked":kind.replaceAll("_"," ")} resource`}
function auditActionLabel(value:string):string{return value in auditActionLabels?auditActionLabels[value as keyof typeof auditActionLabels]:humanizeAuditToken(value)}
function auditResourceLabel(value:string):string{return value in auditResourceLabels?auditResourceLabels[value as keyof typeof auditResourceLabels]:humanizeAuditToken(value)}
function auditResultLabel(value:string):string{return value==="accepted"?"Accepted":value==="rejected"?"Rejected":humanizeAuditToken(value)}
function humanizeAuditToken(value:string):string{return value.replace(/[._-]+/g," ").replace(/\s+/g," ").trim().replace(/^./,(character)=>character.toUpperCase())}

function Filter({
  label,
  value,
  onChange,
  values,
  formatValue = humanizeAuditToken,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  values: readonly string[];
  formatValue?: (value: string) => string;
}) {
  return (
    <div className="grid gap-1">
      <Text type="label" color="secondary">{label}</Text>
      <Selector
        label={label}
        isLabelHidden
        options={values.map((item) => ({
          value: item,
          label: item === "all" ? `All ${label.toLowerCase()}s` : formatValue(item),
        }))}
        value={value}
        onChange={onChange}
        size="lg"
      />
    </div>
  );
}

function DetailDialog({
  event,
  onClose,
}: {
  event: ProjectAuditEvent | null;
  onClose: () => void;
}) {
  return (
    <Dialog isOpen={event !== null} onOpenChange={(open) => !open && onClose()} purpose="info" width="min(34rem, calc(100vw - 2rem))" maxHeight="calc(100dvh - 2rem)" aria-label="Audit event detail">
      {event ? (
        <Layout
          header={<DialogHeader
            title="Audit event detail"
            subtitle="Event metadata for this project activity."
            onOpenChange={(open) => !open && onClose()}
            hasDivider
          />}
          content={<LayoutContent><dl className="grid gap-3 sm:grid-cols-[8rem_1fr]">
            <DT label="Timestamp" value={event.createdAt} />
            <DT label="Action" value={auditActionLabel(event.action)} />
            <DT label="Action ID" value={event.action} />
            <DT
              label="Actor"
              value={
                event.actorDisplayName ||
                event.actorEmail ||
                event.actorId ||
                "System"
              }
            />
            <DT label="Resource user" value={subjectName(event, [])} />
            <DT label="Resource type" value={auditResourceLabel(event.resourceKind)} />
            <DT label="Resource ID" value={auditResourceIdentity(event.resourceKind, event.resourceId)} />
            <DT label="Result" value={auditResultLabel(event.status)} />
            {Object.entries(event.detail ?? {}).filter(([key, value]) => !(key === "releaseReason" && value === "expired")).map(([key, value]) => (
              <DT
                label={auditDetailLabel(key)}
                value={auditDetailValue(key, value)}
                key={key}
              />
            ))}
          </dl></LayoutContent>}
        />
      ) : null}
    </Dialog>
  );
}

function DT({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt><Text type="supporting" color="secondary">{label}</Text></dt>
      <dd className="break-all"><Text type="code">{value}</Text></dd>
    </>
  );
}

const auditDetailLabels: Record<string, string> = {
  endpointId: "Endpoint ID", alertRuleId: "Alert rule ID", alertId: "Alert ID", taskId: "Task ID", runId: "Run ID",
  releaseReason: "Release reason", messageId: "Message ID", deliveryStatus: "Delivery status", credentialVersion: "Credential version",
  healthStatus: "Health status", errorCategory: "Error category", modelCount: "Model count", filePath: "File path", bytes: "Bytes",
  mediaType: "Media type", metric: "Metric", current: "Current", limit: "Limit", windowSeconds: "Window seconds", historicalAction: "Original action",
};
function auditDetailLabel(key:string):string{return auditDetailLabels[key]??humanizeAuditToken(key)}
function auditDetailValue(key:string,value:string|number):string{if(key==="releaseReason"||key==="historicalAction")return humanizeAuditToken(String(value));return String(value)}

function browserQuery(): URLSearchParams {
  return new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search,
  );
}

function replaceBrowserQuery(query: URLSearchParams) {
  window.history.replaceState(null, "", `${window.location.pathname}${query.size ? `?${query}` : ""}${window.location.hash}`);
}
