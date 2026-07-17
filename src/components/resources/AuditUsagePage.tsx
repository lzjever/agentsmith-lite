"use client";

import { ClipboardList, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PROJECT_AUDIT_ACTIONS,
  PROJECT_AUDIT_RESOURCE_KINDS,
} from "../../../packages/contracts/src/api";
import {
  ApiError,
  apiClient,
  type ProjectAuditEvent,
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

export function UsagePage({ projectId }: { projectId: string }) {
  const [usage, setUsage] = useState<ProjectUsageOverview>();
  const [endpointId, setEndpointId] = useState("all");
  const [queryProjectId, setQueryProjectId] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const requestRevision = useRef(0);
  const load = useCallback(async () => {
    const revision = ++requestRevision.current;
    setState("loading");
    try {
      const loaded = await apiClient.usage(
        projectId,
        endpointId === "all" ? undefined : endpointId,
      );
      if (revision !== requestRevision.current) return;
      setUsage(loaded);
      setState("ready");
    } catch (cause) {
      if (revision !== requestRevision.current) return;
      if (endpointId !== "all" && cause instanceof ApiError && cause.status === 404) {
        const query = browserQuery();
        query.delete("endpointId");
        replaceBrowserQuery(query);
        setEndpointId("all");
        return;
      }
      setState("error");
    }
  }, [projectId, endpointId]);

  useEffect(() => {
    requestRevision.current += 1;
    const requested = browserQuery().get("endpointId");
    setEndpointId(requested || "all");
    setQueryProjectId(projectId);
  }, [projectId]);
  useEffect(() => {
    if (queryProjectId === projectId) void load();
  }, [load, projectId, queryProjectId]);

  function changeEndpoint(nextEndpointId: string) {
    const query = browserQuery();
    if (nextEndpointId === "all") query.delete("endpointId");
    else query.set("endpointId", nextEndpointId);
    replaceBrowserQuery(query);
    setEndpointId(nextEndpointId);
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
      {state === "loading" ? (
        <PageState state="loading">Loading usage...</PageState>
      ) : null}
      {state === "error" ? (
        <PageState state="error">
          <ErrorState
            title="Usage unavailable"
            message="Usage could not be loaded."
            onRetry={() => void load()}
          />
        </PageState>
      ) : null}
      {state === "ready" && usage ? (
        <UsageView
          overview={usage}
          selectedEndpointId={endpointId}
          onEndpointChange={changeEndpoint}
        />
      ) : null}
    </PageLayout>
  );
}

const actions = ["all", ...PROJECT_AUDIT_ACTIONS] as const;
const kinds = ["all", ...PROJECT_AUDIT_RESOURCE_KINDS] as const;

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
        action: action === "all" ? undefined : action,
        status: status === "all" ? undefined : status,
        resourceKind: kind === "all" ? undefined : kind,
        resourceId: resourceId || undefined,
        from: from ? new Date(from).toISOString() : undefined,
        to: to ? new Date(to).toISOString() : undefined,
      });
      if (!active.current || revision !== requestRevision.current) return;
      setItems(page.items);
      setNext(page.nextCursor);
      setState("ready");
    } catch {
      if (!active.current || revision !== requestRevision.current) return;
      setState("error");
    }
  }, [projectId, cursor, action, status, kind, resourceId, from, to]);

  useEffect(() => {
    requestRevision.current += 1;
    const query = browserQuery();
    const requestedAction = query.get("action");
    const requestedKind = query.get("resourceKind");
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
    setResourceId(query.get("resourceId") ?? "");
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
              Showing events for {kind === "alert" ? "alert instance" : `${kind === "all" ? "linked" : kind.replaceAll("_", " ")} resource`} <strong>{resourceId}</strong>.
            </p>
            <Button
              variant="quiet"
              size="sm"
              onClick={clearResource}
            >
              <X size={14} />
              Clear instance
            </Button>
          </div>
        ) : null}
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
          <Filter
            label="Action"
            value={action}
            onChange={(value) => {
              setAction(value);
              reset();
            }}
            values={actions}
          />
          <Filter
            label="Result"
            value={status}
            onChange={(value) => {
              setStatus(value);
              reset();
            }}
            values={["all", "accepted", "rejected"]}
          />
          <Filter
            label="Resource type"
            value={kind}
            onChange={(value) => {
              setKind(value);
              setResourceId("");
              reset();
            }}
            values={kinds}
          />
          <Input
            aria-label="From timestamp"
            type="datetime-local"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              reset();
            }}
          />
          <Input
            aria-label="To timestamp"
            type="datetime-local"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              reset();
            }}
          />
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
            {items.map((event) => (
              <button
                className="grid w-full gap-2 py-3 text-left sm:grid-cols-[11rem_1fr_7rem_1fr]"
                onClick={() => setSelected(event)}
                key={event.id}
              >
                <span className="text-xs text-secondary">
                  {formatDate(event.createdAt)}
                </span>
                <strong className="text-sm font-medium">{event.action}</strong>
                <Badge
                  variant={
                    event.status === "rejected" ? "destructive" : "secondary"
                  }
                >
                  {event.status}
                </Badge>
                <span className="break-all text-xs text-secondary">
                  {event.resourceKind}: {event.resourceId ?? "-"}
                </span>
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

function Filter({
  label,
  value,
  onChange,
  values,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  values: readonly string[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {values.map((item) => (
          <SelectItem value={item} key={item}>
            {item === "all"
              ? `All ${label.toLowerCase()}s`
              : item.replaceAll("_", " ")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
              <DT label="Timestamp" value={formatDate(event.createdAt)} />
              <DT label="Action" value={event.action} />
              <DT
                label="Actor"
                value={
                  event.actorDisplayName ||
                  event.actorEmail ||
                  event.actorId ||
                  "System"
                }
              />
              <DT
                label="Resource"
                value={`${event.resourceKind}: ${event.resourceId ?? "-"}`}
              />
              <DT label="Result" value={event.status} />
              {Object.entries(event.detail ?? {}).map(([key, value]) => (
                <DT
                  label={key.replaceAll(/([A-Z])/g, " $1")}
                  value={String(value)}
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
