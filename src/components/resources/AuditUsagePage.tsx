"use client";

import { ClipboardList, ExternalLink, RefreshCw, X } from "lucide-react";
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
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader } from "../ui/dialog";
import { ErrorState } from "../ui/error-state";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
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
            <Button
              variant="quiet"
              size="icon"
              aria-label="Refresh usage"
              onClick={() => void load()}
            >
              <RefreshCw size={16} />
            </Button>
          }
        />
      }
    >
      {canSelectUser && currentUserId ? (
        <div className="flex justify-end border-y border-border py-3">
          <label className="grid gap-1 text-xs text-secondary">
            Sandbox member
            <Select value={selectedUserId ?? currentUserId} onValueChange={changeUser}>
              <SelectTrigger aria-label="Sandbox usage member" className="h-9 w-64 max-w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {members.map((member) => <SelectItem key={member.userId} value={member.userId}>{memberLabel(member)}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        </div>
      ) : null}
      {state === "loading" && !visibleUsage ? (
        <PageState state="loading">Loading usage...</PageState>
      ) : null}
      {state === "loading" && visibleUsage ? (
        <div className="border-y border-border px-3 py-2 text-sm text-secondary" role="status">Refreshing usage...</div>
      ) : null}
      {state === "error" && !visibleUsage ? (
        <PageState state="error">
          <ErrorState
            title={usageError(error).title}
            message={usageError(error).message}
            onRetry={() => void load()}
          />
        </PageState>
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
          <h2 id="sandbox-usage" className="type-title text-foreground">Sandbox usage</h2>
          <p className="mt-1 text-sm text-secondary">
            Task sandbox runtime and requested resources for {selectedMember ? memberLabel(selectedMember) : "you"}.
          </p>
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
        <div className="overflow-x-auto border-y border-border">
          <div className="min-w-[52rem] divide-y divide-border">
            {sandbox.rows.map((row) => (
              <div className="grid grid-cols-[minmax(11rem,1fr)_7rem_10rem_10rem_8rem_minmax(14rem,1fr)] items-center gap-3 px-2 py-3 text-xs" key={row.runId}>
                <div className="min-w-0">
                  {row.taskAvailable ? (
                    <a className="inline-flex max-w-full items-center gap-1 font-medium text-foreground hover:underline" href={taskHref(projectId, row.taskId)}>
                      <span className="truncate">Task {row.taskId}</span><ExternalLink className="size-3 shrink-0" />
                    </a>
                  ) : (
                    <span className="inline-flex max-w-full items-center gap-1 text-secondary" title="This task was deleted">
                      <span className="truncate">Task {row.taskId}</span><span className="shrink-0">(deleted)</span>
                    </span>
                  )}
                  <p className="mt-1 truncate font-mono text-[11px] text-tertiary" title={row.runId}>Run {row.runId}</p>
                </div>
                <Badge variant={row.state === "live" ? "default" : "secondary"} className="w-fit">{row.state === "live" ? "Live" : "Settled"}</Badge>
                <SandboxTimestamp label="Started" value={row.startedAt} />
                <SandboxTimestamp label="Released" value={row.releasedAt} />
                <div><span className="text-tertiary">Duration</span><p className="mt-1 text-foreground">{formatDuration(row.durationSeconds)}</p></div>
                <div>
                  <span className="text-tertiary">Resources</span>
                  <p className="mt-1 text-foreground">{formatInteger(row.resources.cpuRequestMillis)} mCPU · {formatBytes(row.resources.memoryRequestBytes)} requested</p>
                  <p className="mt-1 text-tertiary">Limits {formatInteger(row.resources.cpuLimitMillis)} mCPU · {formatBytes(row.resources.memoryLimitBytes)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : <p className="border border-dashed border-border px-4 py-8 text-center text-sm text-secondary">No sandbox runs for this member.</p>}
    </section>
  );
}

function SandboxTotal({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 border-b border-border p-4 sm:border-r xl:border-b-0"><dt className="type-caption text-tertiary">{label}</dt><dd className="mt-2 break-words text-lg text-foreground">{value}</dd></div>;
}

function SandboxTimestamp({ label, value }: { label: string; value: string | null }) {
  return <div><span className="text-tertiary">{label}</span><p className="mt-1 text-foreground">{value ? formatDate(value) : "-"}</p></div>;
}

function InlineUsageError({ error, onRetry }: { error: unknown; onRetry: () => Promise<void> }) {
  const copy = usageError(error);
  return <div className="flex flex-wrap items-center justify-between gap-3 border-y border-error/40 bg-error/5 px-3 py-2 text-sm" role="alert"><span><strong>{copy.title}.</strong> {copy.message}</span><Button variant="quiet" size="sm" onClick={() => void onRetry()}>Retry</Button></div>;
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
  if (seconds < 60) return `${seconds.toLocaleString("en-US", { maximumFractionDigits: 3 })} s`;
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
  "chat.thread.create": "Created conversation", "chat.thread.update": "Updated conversation", "chat.thread.delete": "Deleted conversation",
  "chat.message.send": "Sent chat message", "chat.message.retry": "Retried chat message", "chat.message.stop": "Stopped chat message", "chat.message.edit": "Edited chat message", "chat.message.delete": "Deleted chat message", "chat.message.branch": "Branched conversation",
  "task.create": "Created task", "task.edit": "Edited task", "task.archive": "Archived task", "task.delete": "Deleted task",
  "task.message.create": "Sent task message", "task.message.edit": "Edited task message", "task.message.delete": "Deleted task message", "task.cancel": "Cancelled task", "task.completed": "Task completed", "task.failed": "Task failed", "task.expired": "Task expired", "task.cleaned": "Cleaned task resources",
  "artifact.project": "Projected task artifact", "sandbox.started": "Started sandbox", "sandbox.failed": "Sandbox failed", "sandbox.release_requested": "Requested sandbox release", "sandbox.released": "Released sandbox",
  "file.upload": "Uploaded file", "file.delete": "Deleted file", "file.quota": "Reached file quota",
  "alert.resolve": "Resolved alert", "alert.dismiss": "Dismissed alert", "alert.rule.create": "Created alert rule", "alert.rule.update": "Updated alert rule", "alert.rule.delete": "Deleted alert rule", "alert.acknowledge": "Acknowledged alert", "alert.silence": "Silenced alert"
};

const auditResourceLabels: Record<(typeof PROJECT_AUDIT_RESOURCE_KINDS)[number], string> = {
  project: "Project", credential: "Credential", endpoint: "Endpoint", member: "Project member", chat_thread: "Conversation", chat_message: "Chat message", task: "Task", artifact: "Task artifact", provider: "Model provider", file: "File", file_quota: "File quota", sandbox: "Sandbox", alert: "Alert"
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
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [selected, setSelected] = useState<ProjectAuditEvent | null>(null);
  const requestRevision = useRef(0);
  const cursor = cursors.at(-1);

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const load = useCallback(async () => {
    const revision = ++requestRevision.current;
    setState("loading");
    setSelected(null);
    try {
      const page = await apiClient.audit(projectId, {
        limit: 20,
        cursor,
        actorId: actorId === "all" ? undefined : actorId,
        subjectUserId: subjectUserId === "all" ? undefined : subjectUserId,
        action: action === "all" ? undefined : action,
        status: status === "all" ? undefined : status,
        resourceKind: kind === "all" ? undefined : kind,
        resourceId: resourceId || undefined,
        from: auditTimeQueryFromInput(from) ?? undefined,
        to: auditTimeQueryFromInput(to) ?? undefined,
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
    setFrom(auditTimeInputFromQuery(query.get("from")));
    setTo(auditTimeInputFromQuery(query.get("to")));
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

  function changeTimeFilter(key: "from" | "to", value: string) {
    const query = browserQuery();
    const timestamp = auditTimeQueryFromInput(value);
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
            <Button
              variant="quiet"
              size="icon"
              aria-label="Refresh audit"
              onClick={() => void load()}
            >
              <RefreshCw size={16} />
            </Button>
          }
        />
      }
    >
      {state === "error" ? (
        <PageState state="error">
          <ErrorState
            title="Audit unavailable"
            message="Audit events could not be loaded."
            onRetry={() => void load()}
          />
        </PageState>
      ) : null}
      <section className="space-y-4">
        {resourceId ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border py-2">
            <p className="text-sm text-secondary">
              Showing events for {linkedResourceLabel(kind, resourceId)} <strong>{resourceId}</strong>.
            </p>
            <Button
              variant="quiet"
              size="sm"
              onClick={clearResource}
            >
              <X size={14} />
              Clear resource filter
            </Button>
          </div>
        ) : null}
        <div className="grid gap-3 border-b border-subtle pb-4 md:grid-cols-2 xl:grid-cols-5">
          <div className="grid gap-1">
            <span className="text-xs text-secondary">Actor</span>
            <Select value={actorId} onValueChange={(value) => {
              const query = browserQuery();
              if (value === "all") query.delete("actorId");
              else query.set("actorId", value);
              replaceBrowserQuery(query);
              setActorId(value);
              reset();
            }}>
              <SelectTrigger aria-label="Actor"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actors</SelectItem>
                {auditActors(members, items, actorId).map((actor) => <SelectItem value={actor.id} key={actor.id}>{actor.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <span className="text-xs text-secondary">Resource user</span>
            <Select value={subjectUserId} onValueChange={(value) => {
              const query = browserQuery();
              if (value === "all") query.delete("subjectUserId");
              else query.set("subjectUserId", value);
              replaceBrowserQuery(query);
              setSubjectUserId(value);
              reset();
            }}>
              <SelectTrigger aria-label="Resource user"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All resource users</SelectItem>
                {auditSubjects(members, items, subjectUserId).map((subject) => <SelectItem value={subject.id} key={subject.id}>{subject.label}</SelectItem>)}
              </SelectContent>
            </Select>
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
          <div className="grid gap-1">
            <span className="text-xs text-secondary">From</span>
            <Input
              aria-label="From timestamp"
              type="datetime-local"
              value={from}
              onChange={(event) => changeTimeFilter("from", event.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <span className="text-xs text-secondary">To</span>
            <Input
              aria-label="To timestamp"
              type="datetime-local"
              value={to}
              onChange={(event) => changeTimeFilter("to", event.target.value)}
            />
          </div>
        </div>
        {state === "loading" ? (
          <PageState state="loading">Loading audit events...</PageState>
        ) : null}
        {state === "ready" && !items.length ? (
          <PageState state="empty">
            <div>
              <ClipboardList className="mx-auto size-7 text-tertiary" />
              <p className="mt-2">No audit events match this query.</p>
            </div>
          </PageState>
        ) : null}
        {state === "ready" && items.length ? (
          <div className="divide-y divide-border border-y border-border">
            <div className="hidden gap-2 bg-surface-low px-2 py-2 sm:grid sm:grid-cols-[9rem_9rem_9rem_minmax(10rem,1fr)_6rem_minmax(10rem,1fr)]" aria-hidden="true">
              <span className="type-caption text-tertiary">Time</span>
              <span className="type-caption text-tertiary">Actor</span>
              <span className="type-caption text-tertiary">Resource user</span>
              <span className="type-caption text-tertiary">Action</span>
              <span className="type-caption text-tertiary">Result</span>
              <span className="type-caption text-tertiary">Resource</span>
            </div>
            {items.map((event) => (
              <button
                className="grid w-full gap-2 px-2 py-3 text-left transition-colors hover:bg-hover sm:grid-cols-[9rem_9rem_9rem_minmax(10rem,1fr)_6rem_minmax(10rem,1fr)]"
                onClick={() => setSelected(event)}
                key={event.id}
              >
                <span className="hidden text-xs text-secondary sm:block">
                  {formatDate(event.createdAt)}
                </span>
                <span className="hidden truncate text-xs text-secondary sm:block" title={actorName(event)}>{actorName(event)}</span>
                <span className="hidden truncate text-xs text-secondary sm:block" title={subjectName(event, members)}>{subjectName(event, members)}</span>
                <span className="flex items-start justify-between gap-3 sm:block"><strong className="text-sm font-medium" title={event.action}>{auditActionLabel(event.action)}<span className="sr-only"> ({event.action})</span></strong><Badge className="shrink-0 sm:hidden" variant={event.status === "rejected" ? "destructive" : "secondary"}>{auditResultLabel(event.status)}</Badge></span>
                <Badge
                  className="hidden justify-self-start sm:inline-flex"
                  variant={
                    event.status === "rejected" ? "destructive" : "secondary"
                  }
                >
                  {auditResultLabel(event.status)}
                </Badge>
                <span className="hidden break-all text-xs text-secondary sm:block">
                  {event.resourceId
                    ? `${auditResourceLabel(event.resourceKind)}: ${event.resourceId}`
                    : auditResourceIdentity(event.resourceKind, event.resourceId)}
                </span>
                <span className="text-xs text-secondary sm:hidden">{formatDate(event.createdAt)} · {actorName(event)}</span>
                {subjectName(event, members) !== "-" ? <span className="truncate text-xs text-secondary sm:hidden">Resource user: {subjectName(event, members)}</span> : null}
                <span className="break-all text-xs text-secondary sm:hidden">{event.resourceId ? `${auditResourceLabel(event.resourceKind)}: ${event.resourceId}` : auditResourceIdentity(event.resourceKind, event.resourceId)}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={cursors.length === 1 || state === "loading"}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!next || state === "loading"}
            onClick={() =>
              next && setCursors((current) => [...current, next])
            }
          >
            Next
          </Button>
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
      <span className="text-xs text-secondary">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((item) => (
            <SelectItem value={item} key={item}>
              {item === "all"
                ? `All ${label.toLowerCase()}s`
                : formatValue(item)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
    <Dialog open={event !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {event ? (
          <>
            <DialogHeader
              title="Audit event detail"
              description="Event metadata for this project activity."
            />
            <dl className="grid gap-3 px-5 py-5 text-sm sm:grid-cols-[8rem_1fr]">
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
            </dl>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DT({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-secondary">{label}</dt>
      <dd className="break-all text-foreground">{value}</dd>
    </>
  );
}

const auditDetailLabels: Record<string, string> = {
  endpointId: "Endpoint ID", alertRuleId: "Alert rule ID", alertId: "Alert ID", taskId: "Task ID", runId: "Run ID",
  releaseReason: "Release reason", messageId: "Message ID", deliveryStatus: "Delivery status", credentialVersion: "Credential version",
  healthStatus: "Health status", errorCategory: "Error category", modelCount: "Model count", filePath: "File path", bytes: "Bytes",
  mediaType: "Media type", metric: "Metric", current: "Current", limit: "Limit", windowSeconds: "Window seconds",
};
function auditDetailLabel(key:string):string{return auditDetailLabels[key]??humanizeAuditToken(key)}
function auditDetailValue(key:string,value:string|number):string{if(key==="releaseReason")return value==="legacy_cleaned"?"Legacy cleanup":humanizeAuditToken(String(value));return String(value)}

function browserQuery(): URLSearchParams {
  return new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search,
  );
}

function replaceBrowserQuery(query: URLSearchParams) {
  window.history.replaceState(null, "", `${window.location.pathname}${query.size ? `?${query}` : ""}${window.location.hash}`);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
