"use client";

import { EmptyState, Heading, Selector, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text } from "@astryxdesign/core";
import type { ProjectUsageOverview, ProjectUsageWindow } from "../../lib/api/client";
import { formatLocalDate, formatLocalTime } from "../../lib/format/date";

const labels = { activeTasks: "Active tasks", providerRequests: "Provider requests", providerTokens: "Provider tokens", providerCost: "Provider cost", projectFileBytes: "Project file storage" } as const;

export function UsageView({ overview, selectedEndpointId, onEndpointChange }: { overview: ProjectUsageOverview; selectedEndpointId: string; onEndpointChange: (endpointId: string) => void }) {
  const peak = Math.max(1, ...overview.daily.map((day) => day.requests));
  const hasTrend = overview.daily.some((day) => day.requests > 0 || day.tokens > 0 || day.cost > 0);
  const selectedEndpoint = overview.endpoints.find((endpoint) => endpoint.endpointId === selectedEndpointId);
  const scopeLabel = selectedEndpointId === "all" ? "All endpoints" : (selectedEndpoint?.endpointName ?? selectedEndpointId);
  return <section className="space-y-7" aria-label="Project usage">
    <section className="flex flex-wrap items-end justify-between gap-3 border-y border-border py-4" aria-labelledby="usage-scope">
      <div><Heading level={2} id="usage-scope">Usage scope</Heading><Text as="p" type="supporting" color="secondary" display="block" className="mt-1 max-w-2xl">The endpoint filter applies to your settled 30-day provider usage. Project lifetime limits and settled endpoint totals remain project-wide; rolling endpoint limits show your capacity.</Text></div>
      <Selector label="Endpoint" options={[{ value: "all", label: "All endpoints" }, ...overview.endpoints.filter((endpoint) => endpoint.endpointId !== null).map((endpoint) => ({ value: endpoint.endpointId!, label: endpoint.endpointName }))]} value={selectedEndpointId} onChange={onEndpointChange} size="sm" width={224} />
    </section>
    <section aria-labelledby="usage-limits">
      <Heading level={2} id="usage-limits">Project limits</Heading>
      <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">Project-wide, independent of the endpoint filter.</Text>
      <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">Provider totals include conservative reservations when final delivery usage is unknown.</Text>
      <dl className="mt-4 grid overflow-hidden border border-border sm:grid-cols-2 xl:grid-cols-5">{overview.limits.map((limit, index) => <div key={limit.metric} className={`min-w-0 border-b border-border p-4 sm:border-r sm:last:border-r-0 xl:border-b-0 ${index >= 2 ? "sm:border-b-0" : ""}`}><dt><Text type="supporting" color="secondary">{labels[limit.metric]}</Text></dt><dd className="mt-3"><Text type="large">{formatMetric(limit.metric, limit.current)}</Text></dd><Text as="p" type="supporting" color="secondary" display="block" className="mt-1">{limit.limit === null ? "No limit" : `${formatMetric(limit.metric, limit.remaining!)} remaining of ${formatMetric(limit.metric, limit.limit)}`}</Text><Text as="p" type="supporting" color="secondary" display="block" className="mt-2">{formatUsageWindow(limit.window)}</Text></div>)}</dl>
    </section>
    <section className="border-y border-border py-5" aria-labelledby="usage-trend">
      <Heading level={2} id="usage-trend">Your 30-day trend</Heading>
      <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">Your settled provider requests · {scopeLabel}.</Text>
      {hasTrend ? <><div className="mt-5 flex h-40 items-end gap-px border-b border-border" aria-label="30-day request trend">{overview.daily.map((day) => <div className="relative min-w-0 flex-1 bg-accent-bg" key={day.date} style={{ height: `${day.requests === 0 ? 0 : Math.max(3, Math.round(day.requests / peak * 100))}%` }} title={`${day.date}: ${day.requests} requests, ${day.tokens} tokens, ${formatCost(day.cost)}`} aria-label={`${day.date}: ${day.requests} requests`} />)}</div><div className="mt-2 flex justify-between"><Text type="supporting" color="secondary">{overview.daily[0]?.date}</Text><Text type="supporting" color="secondary">{overview.daily.at(-1)?.date}</Text></div><dl className="mt-5 grid gap-3 sm:grid-cols-3"><UsageTotal label="Requests" value={String(overview.trendTotals.requests)} /><UsageTotal label="Tokens" value={formatNumber(overview.trendTotals.tokens)} /><UsageTotal label="Cost" value={formatCost(overview.trendTotals.cost)} /></dl></> : <EmptyState className="min-h-40 border border-dashed border-border" isCompact title="No settled provider usage" description="No settled provider usage in this period." />}
    </section>
    <section aria-labelledby="usage-endpoints">
      <Heading level={2} id="usage-endpoints">Project endpoint usage</Heading>
      <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">Settled totals from the last 30 days, including activity not tied to a current endpoint.</Text>
      {overview.endpoints.length === 0 ? <EmptyState className="mt-3" isCompact title="No project endpoint usage" description="No project endpoint usage in this period." /> : <div className="mt-4"><Table aria-label="Project endpoint usage" density="balanced" dividers="rows" verticalAlign="top"><TableHeader><TableRow isHeaderRow><TableHeaderCell>Endpoint</TableHeaderCell><TableHeaderCell>Settled totals</TableHeaderCell><TableHeaderCell>Your rolling limits</TableHeaderCell></TableRow></TableHeader><TableBody>{overview.endpoints.map((endpoint) => <TableRow key={endpoint.endpointId ?? "unassigned-endpoints"}><TableCell>{endpoint.endpointName}</TableCell><TableCell><Text type="supporting" color="secondary">{endpoint.requests} requests · {formatNumber(endpoint.tokens)} tokens · {formatCost(endpoint.cost)}</Text></TableCell><TableCell>{endpoint.limits?.length ? endpoint.limits.map((limit) => <Text type="supporting" color="secondary" display="block" key={limit.metric}>{labels[limit.metric]}: {limit.remaining === null ? "unlimited" : `${formatMetric(limit.metric, limit.remaining)} remaining`} · {formatUsageWindow(limit.window)}</Text>) : <Text type="supporting" color="secondary">No rolling limits</Text>}</TableCell></TableRow>)}</TableBody></Table></div>}
    </section>
  </section>;
}

function UsageTotal({ label, value }: { label: string; value: string }) { return <div><dt><Text type="supporting" color="secondary">{label}</Text></dt><dd className="mt-1"><Text type="large">{value}</Text></dd></div>; }
function formatMetric(metric: keyof typeof labels, value: number): string { return metric === "providerCost" ? formatCost(value) : metric === "projectFileBytes" ? formatBytes(value) : formatNumber(value); }
function formatNumber(value: number): string { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value); }
function formatCost(value: number): string { return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value); }
function formatBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`; return `${(value / (1024 * 1024)).toFixed(1)} MiB`; }
function formatUsageWindow(window: ProjectUsageWindow): string { return window.kind === "current_gauge" ? "Current state" : window.kind === "rolling" ? window.resetAt ? `${duration(window.windowSeconds)} rolling · resets ${formatLocalTime(window.resetAt)}` : `${duration(window.windowSeconds)} rolling · no usage in window` : `Project lifetime · started ${formatLocalDate(window.startedAt)}`; }
function duration(seconds:number){if(seconds%86400===0)return `${seconds/86400}d`;if(seconds%3600===0)return `${seconds/3600}h`;return `${seconds}s`;}
