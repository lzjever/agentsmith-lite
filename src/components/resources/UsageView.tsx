"use client";

import { Check, Copy, ExternalLink, RefreshCw, Search } from "lucide-react";
import {
  Banner,
  Button,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  Selector,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  TextInput,
} from "@astryxdesign/core";
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { apiClient, type
  ProjectMemberCandidate,
  ProjectEndpointUsagePage,
  ProjectSandboxRunHistoryPage,
  ProjectUsageEndpoint,
  ProjectUsageOverview,
  ProjectUsageWindow,
} from "../../lib/api/client";
import {
  formatLocalDate,
  formatLocalDateTime,
  formatLocalTime,
} from "../../lib/format/date";
import { MemberDirectoryPicker } from "../members/MemberDirectoryPicker";
import { EndpointPicker } from "../providers/ProviderDirectoryPicker";
import {
  decideSandboxUsageAnchorActivation,
  type SandboxUsageAnchorActivationState
} from "./sandbox-usage-anchor";

const labels = {
  activeSandboxes: "Active sandboxes",
  providerRequests: "Provider requests",
  providerTokens: "Provider tokens",
  providerCost: "Provider cost",
} as const;

const providerDayFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeZone: "UTC",
});

type LoadState = "idle" | "loading" | "ready" | "error";
type HistoryOperation = "initial" | "pagination" | "refresh";

export function UsageView({
  projectId,
  overview,
  overviewState,
  overviewError,
  scopeNotice,
  currentUserId,
  selectedMember,
  selectedEndpointId,
  selectedSandboxUserId,
  historyOpen,
  history,
  historyPageIndex,
  historyState,
  historyError,
  historyOperation,
  fileStorageState,
  fileStorageError,
  onEndpointChange,
  onSandboxUserChange,
  onRetryOverview,
  onHistoryOpenChange,
  onHistoryPrevious,
  onHistoryNext,
  onHistoryRefresh,
  onHistoryRetry,
  onMeasureFileStorage,
}: {
  projectId: string;
  overview: ProjectUsageOverview | undefined;
  overviewState: LoadState;
  overviewError: unknown;
  scopeNotice: string | undefined;
  currentUserId: string | undefined;
  selectedMember: ProjectMemberCandidate | undefined;
  selectedEndpointId: string;
  selectedSandboxUserId: string | undefined;
  historyOpen: boolean;
  history: ProjectSandboxRunHistoryPage | undefined;
  historyPageIndex: number;
  historyState: LoadState;
  historyError: unknown;
  historyOperation: HistoryOperation;
  fileStorageState: "idle" | "loading" | "error";
  fileStorageError: unknown;
  onEndpointChange: (endpointId: string) => void;
  onSandboxUserChange: (member: ProjectMemberCandidate) => void;
  onRetryOverview: () => Promise<void>;
  onHistoryOpenChange: (open: boolean) => void;
  onHistoryPrevious: () => void;
  onHistoryNext: () => void;
  onHistoryRefresh: () => void;
  onHistoryRetry: () => void;
  onMeasureFileStorage: () => Promise<void>;
}) {
  const overviewCopy = usageErrorCopy(overviewError);
  const overviewLoaded = overview !== undefined;
  const sandboxUsageRegion = useRef<HTMLElement>(null);
  const sandboxAnchorActivation = useRef<SandboxUsageAnchorActivationState>({
    activated: false
  });

  useEffect(() => {
    const decision = decideSandboxUsageAnchorActivation(
      sandboxAnchorActivation.current,
      {
        hash: window.location.hash,
        overviewLoaded
      }
    );
    sandboxAnchorActivation.current = decision.state;
    if (!decision.activate) return;
    const frame = window.requestAnimationFrame(() => {
      const region = sandboxUsageRegion.current;
      if (!region) return;
      region.scrollIntoView({ block: "start" });
      region.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [overviewLoaded]);

  return (
    <div className="space-y-6">
      {scopeNotice ? <Banner status="warning" title="Usage scope changed" description={scopeNotice} /> : null}
      {overviewState === "loading" && !overview ? (
        <div className="grid min-h-64 place-items-center" role="status">
          <Text color="secondary">Loading usage...</Text>
        </div>
      ) : null}
      {overviewState === "error" && !overview ? (
        <Banner
          status="error"
          title={overviewCopy.title}
          description={overviewCopy.message}
          endContent={<Button label="Try again" variant="ghost" onClick={() => void onRetryOverview()} />}
        />
      ) : null}
      {overview ? (
        <>
          {overviewState === "loading" ? (
            <div className="border-y border-border px-3 py-2" role="status">
              <Text type="supporting" color="secondary">Refreshing usage...</Text>
            </div>
          ) : null}
          {overviewState === "error" ? (
            <Banner
              status="error"
              title="Usage could not be refreshed"
              description={overviewCopy.message}
              endContent={<Button label="Retry" variant="ghost" size="md" onClick={() => void onRetryOverview()} />}
            />
          ) : null}
          <ProjectLimits
            overview={overview}
            fileStorageState={fileStorageState}
            fileStorageError={fileStorageError}
            onMeasureFileStorage={onMeasureFileStorage}
          />
          <ProviderUsage
            projectId={projectId}
            overview={overview}
            selectedEndpointId={selectedEndpointId}
            onEndpointChange={onEndpointChange}
          />
        </>
      ) : null}
      <SandboxUsage
        regionRef={sandboxUsageRegion}
        projectId={projectId}
        overview={overview}
        currentUserId={currentUserId}
        selectedMember={selectedMember}
        selectedSandboxUserId={selectedSandboxUserId}
        historyOpen={historyOpen}
        history={history}
        historyPageIndex={historyPageIndex}
        historyState={historyState}
        historyError={historyError}
        historyOperation={historyOperation}
        onSandboxUserChange={onSandboxUserChange}
        onHistoryOpenChange={onHistoryOpenChange}
        onHistoryPrevious={onHistoryPrevious}
        onHistoryNext={onHistoryNext}
        onHistoryRefresh={onHistoryRefresh}
        onHistoryRetry={onHistoryRetry}
      />
    </div>
  );
}

function ProjectLimits({
  overview,
  fileStorageState,
  fileStorageError,
  onMeasureFileStorage,
}: {
  overview: ProjectUsageOverview;
  fileStorageState: "idle" | "loading" | "error";
  fileStorageError: unknown;
  onMeasureFileStorage: () => Promise<void>;
}) {
  const fileStorage = overview.fileStorage;
  return (
    <section aria-labelledby="usage-limits">
      <Heading level={2} id="usage-limits">Project limits</Heading>
      <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">
        Current project policy and remaining capacity. Provider totals include conservative reservations when final delivery usage is unknown.
      </Text>
      <dl className="mt-4 grid gap-px overflow-hidden border border-border bg-border sm:grid-cols-2 xl:grid-cols-5">
        {overview.limits.map((limit) => (
          <div
            key={limit.metric}
            className="min-w-0 bg-surface p-4"
          >
            <dt><Text type="supporting" color="secondary">{labels[limit.metric]}</Text></dt>
            <dd className="mt-3"><Text type="large">{formatMetric(limit.metric, limit.current)}</Text></dd>
            <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">
              {limit.limit === null ? "No limit" : `${formatMetric(limit.metric, limit.remaining!)} remaining of ${formatMetric(limit.metric, limit.limit)}`}
            </Text>
            <Text as="p" type="supporting" color="secondary" display="block" className="mt-2">
              {formatUsageWindow(limit.window)}
            </Text>
          </div>
        ))}
        <div className="min-w-0 bg-surface p-4">
          <dt className="flex items-start justify-between gap-2">
            <Text type="supporting" color="secondary">Recorded file storage</Text>
            <IconButton
              className="shrink-0"
              label="Measure file storage"
              tooltip="Measure file storage"
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={14} />}
              isLoading={fileStorageState === "loading"}
              isDisabled={fileStorageState === "loading"}
              onClick={() => void onMeasureFileStorage()}
            />
          </dt>
          <dd className="mt-3"><Text type="large">{formatBytes(String(fileStorage.recordedBytes))}</Text></dd>
          <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">
            {fileStorage.limitBytes === null
              ? "No limit"
              : fileStorage.remainingBytes === null
                ? `${formatBytes(String(fileStorage.limitBytes))} limit · remaining unavailable`
                : `${formatBytes(String(fileStorage.remainingBytes))} remaining of ${formatBytes(String(fileStorage.limitBytes))}`}
          </Text>
          <Text as="p" type="supporting" color="secondary" display="block" className="mt-2">
            Point-in-time · {fileStorage.measuredAt ? `Measured ${formatLocalDateTime(fileStorage.measuredAt)}` : "Measurement time unavailable"}
          </Text>
          {fileStorageState === "loading" ? (
            <Text as="p" type="supporting" color="secondary" display="block" className="mt-2" role="status">
              Measuring file storage...
            </Text>
          ) : null}
          {fileStorageState === "error" ? (
            <p className="mt-2 text-error" role="alert">
              <Text type="supporting" color="inherit">{fileStorageMeasurementError(fileStorageError)}</Text>
            </p>
          ) : null}
        </div>
      </dl>
    </section>
  );
}

function ProviderUsage({
  projectId,
  overview,
  selectedEndpointId,
  onEndpointChange,
}: {
  projectId:string;
  overview: ProjectUsageOverview;
  selectedEndpointId: string;
  onEndpointChange: (endpointId: string) => void;
}) {
  const provider = overview.provider;
  const peak = Math.max(1, ...provider.daily.map((day) => day.requests));
  const hasTrend = provider.daily.some((day) => day.requests > 0 || day.tokens > 0 || day.cost > 0);
  const scopeLabel = provider.selectedEndpointId === null ? "All endpoints" : (provider.selectedEndpoint?.name ?? provider.selectedEndpointId);
  const firstDay = provider.daily[0]?.date;
  const lastDay = provider.daily.at(-1)?.date;
  return (
    <section className="space-y-6 border-y border-border py-6" aria-labelledby="provider-usage">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Heading level={2} id="provider-usage">Your provider usage</Heading>
          <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">
            Authenticated user only · {scopeLabel}
          </Text>
          <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">
            {firstDay && lastDay ? `30-day period: ${formatProviderDay(firstDay)} through ${formatProviderDay(lastDay)}` : "30-day period"}
          </Text>
        </div>
        <div className="w-full max-w-sm space-y-2"><Button label="All endpoints" variant={selectedEndpointId==="all"?"primary":"secondary"} size="sm" onClick={()=>onEndpointChange("all")}/><EndpointPicker projectId={projectId} value={selectedEndpointId==="all"?"":selectedEndpointId} label="Filter to endpoint" onChange={(endpoint)=>onEndpointChange(endpoint.id)} onUnavailable={()=>onEndpointChange("all")}/></div>
      </div>
      {hasTrend ? (
        <>
          <ProviderDailyTrend daily={provider.daily} peak={peak} />
          <dl className="grid gap-px overflow-hidden border border-border bg-border sm:grid-cols-3">
            <UsageTotal label="Requests" value={formatNumber(provider.totals.requests)} />
            <UsageTotal label="Tokens" value={formatNumber(provider.totals.tokens)} />
            <UsageTotal label="Cost" value={formatCost(provider.totals.cost)} />
          </dl>
        </>
      ) : (
        <EmptyState
          className="min-h-40 border border-dashed border-border"
          isCompact
          title="No settled provider usage"
          description="No settled provider usage in this 30-day period."
        />
      )}
      <EndpointUsageDirectory projectId={projectId} userId={provider.userId}/>
    </section>
  );
}

type ProviderEndpoint = ProjectUsageEndpoint;

function EndpointUsageDirectory({projectId,userId}:{projectId:string;userId:string}){
  const [query,setQuery]=useState(""),[committedQuery,setCommittedQuery]=useState("");
  const [cursor,setCursor]=useState<string|undefined>(),[history,setHistory]=useState<Array<string|undefined>>([]);
  const [loadedCursor,setLoadedCursor]=useState<string|undefined>(),[loadedHistory,setLoadedHistory]=useState<Array<string|undefined>>([]);
  const [page,setPage]=useState<ProjectEndpointUsagePage>({items:[],nextCursor:null,total:0});
  const [state,setState]=useState<"loading"|"ready"|"error">("loading"),[refreshing,setRefreshing]=useState(false),[error,setError]=useState("");
  const revision=useRef(0),hasContent=useRef(false);
  useEffect(()=>{const timer=window.setTimeout(()=>{setCommittedQuery(query.trim());setHistory([]);setCursor(undefined)},250);return()=>window.clearTimeout(timer)},[query]);
  useEffect(()=>{revision.current+=1;hasContent.current=false;setQuery("");setCommittedQuery("");setCursor(undefined);setHistory([]);setLoadedCursor(undefined);setLoadedHistory([]);setPage({items:[],nextCursor:null,total:0})},[projectId,userId]);
  const load=useCallback(async()=>{
    const request=++revision.current,preserve=hasContent.current;
    preserve?setRefreshing(true):setState("loading");setError("");
    try{
      const loaded=await apiClient.endpointUsage(projectId,{q:committedQuery,...(cursor!==undefined?{cursor}:{}),limit:20,userId});
      if(request!==revision.current)return;
      setPage(loaded);setLoadedCursor(cursor);setLoadedHistory(history);setState("ready");hasContent.current=true;
    }catch(reason){if(request!==revision.current)return;setError(reason instanceof Error?reason.message:"Endpoint usage could not be loaded.");if(!preserve)setState("error")}
    finally{if(request===revision.current)setRefreshing(false)}
  },[committedQuery,cursor,history,projectId,userId]);
  useEffect(()=>{void load()},[load]);
  return <div>
    <Heading level={3}>Endpoint totals</Heading>
    <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">Settled totals and rolling limits for the same 30-day period.</Text>
    <TextInput label="Search endpoint totals" isLabelHidden startIcon={<Search size={15}/>} value={query} onChange={(value)=>{revision.current+=1;setQuery(value)}} placeholder="Search endpoint totals" className="mt-3 max-w-sm" size="lg"/>
    {error?<Banner className="mt-3" status="error" title="Endpoint totals unavailable" description={error} endContent={<Button label="Retry" variant="ghost" onClick={()=>void load()}/>}/>:null}
    {state==="loading"?<Text as="p" type="supporting" color="secondary" className="mt-3">Loading endpoint totals...</Text>:null}
    {state==="ready"&&page.items.length===0?<EmptyState className="mt-3" isCompact title="No endpoint totals" description={query?"No endpoints match this search.":"No endpoints are configured."}/>:null}
    {state==="ready"&&page.items.length>0?<><ul className="mt-4 divide-y divide-border border-y border-border md:hidden" aria-label="Your endpoint usage">{page.items.map((endpoint)=><li className="py-4" key={endpoint.endpointId}><Text weight="semibold" wordBreak="break-word">{endpoint.endpointName}</Text><dl className="mt-3 grid gap-4"><div><dt><Text type="supporting" color="secondary">Settled totals</Text></dt><dd className="mt-1"><EndpointSettledTotals endpoint={endpoint}/></dd></div><div><dt><Text type="supporting" color="secondary">Your rolling limits</Text></dt><dd className="mt-1"><EndpointRollingLimits endpoint={endpoint}/></dd></div></dl></li>)}</ul><div className="mt-4 hidden overflow-x-auto md:block"><Table aria-label="Your endpoint usage" density="balanced" dividers="rows" verticalAlign="top"><TableHeader><TableRow isHeaderRow><TableHeaderCell>Endpoint</TableHeaderCell><TableHeaderCell>Settled totals</TableHeaderCell><TableHeaderCell>Your rolling limits</TableHeaderCell></TableRow></TableHeader><TableBody>{page.items.map((endpoint)=><TableRow key={endpoint.endpointId}><TableCell>{endpoint.endpointName}</TableCell><TableCell><EndpointSettledTotals endpoint={endpoint}/></TableCell><TableCell><EndpointRollingLimits endpoint={endpoint}/></TableCell></TableRow>)}</TableBody></Table></div></>:null}
    {loadedHistory.length>0||page.nextCursor?<div className="mt-3 flex items-center justify-end gap-2"><Button label="Previous" variant="secondary" size="sm" isDisabled={refreshing||Boolean(error)||loadedHistory.length===0} onClick={()=>{setCursor(loadedHistory.at(-1));setHistory(loadedHistory.slice(0,-1))}}/><Text type="supporting" color="secondary">Page {loadedHistory.length+1} · {page.total} endpoints</Text><Button label="Next" variant="secondary" size="sm" isDisabled={refreshing||Boolean(error)||query.trim()!==committedQuery||!page.nextCursor} onClick={()=>{if(page.nextCursor){setHistory([...loadedHistory,loadedCursor]);setCursor(page.nextCursor)}}}/></div>:null}
  </div>;
}

function EndpointSettledTotals({ endpoint }: { endpoint: ProviderEndpoint }) {
  return (
    <Text type="supporting" color="secondary">
      {formatNumber(endpoint.requests)} requests · {formatNumber(endpoint.tokens)} tokens · {formatCost(endpoint.cost)}
    </Text>
  );
}

function EndpointRollingLimits({ endpoint }: { endpoint: ProviderEndpoint }) {
  return endpoint.limits?.length ? endpoint.limits.map((limit) => (
    <Text type="supporting" color="secondary" display="block" key={limit.metric}>
      {labels[limit.metric]}: {limit.remaining === null ? "unlimited" : `${formatMetric(limit.metric, limit.remaining)} remaining`} · {formatUsageWindow(limit.window)}
    </Text>
  )) : <Text type="supporting" color="secondary">No rolling limits</Text>;
}

function ProviderDailyTrend({
  daily,
  peak,
}: {
  daily: ProjectUsageOverview["provider"]["daily"];
  peak: number;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const detailsId = useId();
  const chartWidth = 300;
  const chartTop = 4;
  const baseline = 116;
  const slotWidth = chartWidth / daily.length;
  return (
    <figure>
      <svg
        className="h-40 w-full border-b border-border text-accent-bg"
        viewBox={`0 0 ${chartWidth} 120`}
        preserveAspectRatio="none"
        role="img"
        tabIndex={0}
        aria-labelledby={titleId}
        aria-describedby={`${descriptionId} ${detailsId}`}
      >
        <title id={titleId}>30-day provider request trend</title>
        <desc id={descriptionId}>Daily request volume. Detailed requests, tokens, and cost for every day follow.</desc>
        {daily.map((day, index) => {
          const height = day.requests === 0 ? 0 : Math.max(3, day.requests / peak * (baseline - chartTop));
          return (
            <rect
              key={day.date}
              x={index * slotWidth + 0.5}
              y={baseline - height}
              width={Math.max(1, slotWidth - 1)}
              height={height}
              fill="currentColor"
            />
          );
        })}
      </svg>
      <ul id={detailsId} className="sr-only">
        {daily.map((day) => (
          <li key={day.date}>
            {day.date}: {formatNumber(day.requests)} requests, {formatNumber(day.tokens)} tokens, {formatCost(day.cost)}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex justify-between" aria-hidden="true">
        <Text type="supporting" color="secondary">{daily[0]?.date}</Text>
        <Text type="supporting" color="secondary">{daily.at(-1)?.date}</Text>
      </div>
    </figure>
  );
}

function SandboxUsage({
  regionRef,
  projectId,
  overview,
  currentUserId,
  selectedMember,
  selectedSandboxUserId,
  historyOpen,
  history,
  historyPageIndex,
  historyState,
  historyError,
  historyOperation,
  onSandboxUserChange,
  onHistoryOpenChange,
  onHistoryPrevious,
  onHistoryNext,
  onHistoryRefresh,
  onHistoryRetry,
}: {
  regionRef: RefObject<HTMLElement | null>;
  projectId: string;
  overview: ProjectUsageOverview | undefined;
  currentUserId: string | undefined;
  selectedMember: ProjectMemberCandidate | undefined;
  selectedSandboxUserId: string | undefined;
  historyOpen: boolean;
  history: ProjectSandboxRunHistoryPage | undefined;
  historyPageIndex: number;
  historyState: LoadState;
  historyError: unknown;
  historyOperation: HistoryOperation;
  onSandboxUserChange: (member: ProjectMemberCandidate) => void;
  onHistoryOpenChange: (open: boolean) => void;
  onHistoryPrevious: () => void;
  onHistoryNext: () => void;
  onHistoryRefresh: () => void;
  onHistoryRetry: () => void;
}) {
  if (!overview) {
    return (
      <section
        ref={regionRef}
        id="sandbox-usage"
        tabIndex={-1}
        aria-label="Sandbox allocations"
      />
    );
  }
  const sandbox = overview.sandbox;
  const memberScope = selectedMember
    ? memberLabel(selectedMember)
    : !selectedSandboxUserId || sandbox.selectedUserId === currentUserId
      ? "You"
      : sandbox.selectedUserId;
  return (
    <section
      ref={regionRef}
      id="sandbox-usage"
      tabIndex={-1}
      className="space-y-5 outline-none"
      aria-labelledby="sandbox-usage-heading"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <Heading level={2} id="sandbox-usage-heading">Sandbox allocations</Heading>
          <Text as="p" type="supporting" color="secondary" display="block" wordBreak="break-word" className="mt-1">
            {memberScope} · summary from {formatLocalDateTime(sandbox.summaryStartedAt)} through {formatLocalDateTime(sandbox.measuredAt)}
          </Text>
        </div>
        {overview.canSelectMemberUsage&&currentUserId?<div className="min-w-0 w-full lg:w-72 lg:shrink-0"><MemberDirectoryPicker kind="project" scopeId={projectId} label="Sandbox member" value={selectedSandboxUserId??currentUserId} onChange={onSandboxUserChange} pinned={[{userId:currentUserId,displayName:"You",email:currentUserId},...(selectedMember?[selectedMember]:[])]}/></div>:null}
      </div>
      <dl className="grid gap-px overflow-hidden border border-border bg-border sm:grid-cols-2 xl:grid-cols-5">
        <SandboxTotal label="Unreleased runs" value={formatInteger(String(sandbox.unreleasedCount))} />
        <SandboxTotal label="Launches" value={formatInteger(String(sandbox.launches))} />
        <SandboxTotal label="Total runtime" value={`${formatDecimal(sandbox.totalDurationSeconds)} s`} />
        <SandboxTotal label="CPU request-time" value={`${formatDecimal(sandbox.cpuRequestSeconds)} CPU-s`} />
        <SandboxTotal label="Memory request-time" value={`${formatDecimal(sandbox.memoryRequestByteSeconds, 1_073_741_824n)} GiB-s`} />
      </dl>
      <div>
        <Heading level={3}>Unreleased runs</Heading>
        {sandbox.liveRuns.length ? (
          <ul className="mt-3 divide-y divide-border border-y border-border" aria-label="Unreleased Sandbox runs">
            {sandbox.liveRuns.map((run) => (
              <li key={run.runId} className="grid gap-3 py-4 md:grid-cols-[minmax(14rem,1.2fr)_minmax(0,1fr)] md:gap-6">
                <RunIdentity projectId={projectId} run={run} />
                <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
                  <RunDetail label="State" value={liveStateLabel(run.state)} />
                  <RunDetail label="Started" value={run.startedAt ? formatLocalDateTime(run.startedAt) : "Waiting to start"} />
                  <RunDetail label="Duration" value={formatDuration(run.durationSeconds)} />
                  <RunDetail label="Requested" value={`${formatInteger(run.resources.cpuRequestMillis)} mCPU · ${formatBytes(run.resources.memoryRequestBytes)}`} />
                  <RunDetail label="Limits" value={`${formatInteger(run.resources.cpuLimitMillis)} mCPU · ${formatBytes(run.resources.memoryLimitBytes)}`} />
                </dl>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            className="mt-3 border border-dashed border-border"
            isCompact
            title="No unreleased Sandbox runs"
            description="This member is not currently holding a Sandbox allocation."
          />
        )}
      </div>
      <Collapsible trigger="View run history" isOpen={historyOpen} onOpenChange={onHistoryOpenChange}>
        <div className="mt-4">
          <HistoryContent
            projectId={projectId}
            history={history}
            pageIndex={historyPageIndex}
            state={historyState}
            error={historyError}
            operation={historyOperation}
            onPrevious={onHistoryPrevious}
            onNext={onHistoryNext}
            onRefresh={onHistoryRefresh}
            onRetry={onHistoryRetry}
          />
        </div>
      </Collapsible>
    </section>
  );
}

function HistoryContent({
  projectId,
  history,
  pageIndex,
  state,
  error,
  operation,
  onPrevious,
  onNext,
  onRefresh,
  onRetry,
}: {
  projectId: string;
  history: ProjectSandboxRunHistoryPage | undefined;
  pageIndex: number;
  state: LoadState;
  error: unknown;
  operation: HistoryOperation;
  onPrevious: () => void;
  onNext: () => void;
  onRefresh: () => void;
  onRetry: () => void;
}) {
  const errorCopy = historyErrorCopy(error);
  if (state === "loading" && !history) {
    return <div className="grid min-h-32 place-items-center" role="status"><Text color="secondary">Loading run history...</Text></div>;
  }
  if (state === "error" && !history) {
    return (
      <Banner
        status="error"
        title="Run history unavailable"
        description={errorCopy}
        endContent={<Button label="Try again" variant="ghost" onClick={onRetry} />}
      />
    );
  }
  if (!history) return null;
  const start = pageIndex * 20 + 1;
  const end = start + history.items.length - 1;
  const isBusy = state === "loading";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Heading level={3}>Settled run history</Heading>
          <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">
            Summary from {formatLocalDateTime(history.summaryStartedAt)} · released through {formatLocalDateTime(history.scopeMeasuredAt)}
          </Text>
        </div>
        <IconButton
          label="Refresh run history"
          tooltip="Refresh run history"
          variant="ghost"
          size="lg"
          icon={<RefreshCw size={16} />}
          isDisabled={isBusy}
          onClick={onRefresh}
        />
      </div>
      {isBusy ? (
        <div role="status">
          <Text type="supporting" color="secondary">
            {operation === "pagination" ? "Loading run history page..." : "Refreshing run history..."}
          </Text>
        </div>
      ) : null}
      {state === "error" ? (
        <Banner
          status="error"
          title={operation === "pagination" ? "Run history page could not be loaded" : "Run history could not be refreshed"}
          description={`${errorCopy} The current page is still shown.`}
          endContent={<Button label="Retry" variant="ghost" size="md" onClick={onRetry} />}
        />
      ) : null}
      {history.items.length ? (
        <>
          <div className="hidden overflow-x-auto md:block">
            <Table aria-label="Settled Sandbox run history" density="balanced" dividers="rows" verticalAlign="top">
              <TableHeader>
                <TableRow isHeaderRow>
                  <TableHeaderCell>Task and run</TableHeaderCell>
                  <TableHeaderCell>Started</TableHeaderCell>
                  <TableHeaderCell>Released</TableHeaderCell>
                  <TableHeaderCell>Duration</TableHeaderCell>
                  <TableHeaderCell>Resources</TableHeaderCell>
                  <TableHeaderCell>Release</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.items.map((run) => (
                  <TableRow key={run.runId}>
                    <TableCell><RunIdentity projectId={projectId} run={run} /></TableCell>
                    <TableCell>{run.startedAt ? formatLocalDateTime(run.startedAt) : "-"}</TableCell>
                    <TableCell>{formatLocalDateTime(run.releasedAt)}</TableCell>
                    <TableCell>{formatDuration(run.durationSeconds)}</TableCell>
                    <TableCell>
                      <Text display="block">{formatInteger(run.resources.cpuRequestMillis)} mCPU · {formatBytes(run.resources.memoryRequestBytes)} requested</Text>
                      <Text type="supporting" color="secondary" display="block" className="mt-1">
                        Limits {formatInteger(run.resources.cpuLimitMillis)} mCPU · {formatBytes(run.resources.memoryLimitBytes)}
                      </Text>
                    </TableCell>
                    <TableCell>{releaseReasonLabel(run.releaseReason)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="divide-y divide-border border-y border-border md:hidden" aria-label="Settled Sandbox run history">
            {history.items.map((run) => (
              <li key={run.runId} className="grid gap-3 py-4">
                <RunIdentity projectId={projectId} run={run} />
                <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
                  <RunDetail label="Started" value={run.startedAt ? formatLocalDateTime(run.startedAt) : "-"} />
                  <RunDetail label="Released" value={formatLocalDateTime(run.releasedAt)} />
                  <RunDetail label="Duration" value={formatDuration(run.durationSeconds)} />
                  <RunDetail label="Requested" value={`${formatInteger(run.resources.cpuRequestMillis)} mCPU · ${formatBytes(run.resources.memoryRequestBytes)}`} />
                  <RunDetail label="Limits" value={`${formatInteger(run.resources.cpuLimitMillis)} mCPU · ${formatBytes(run.resources.memoryLimitBytes)}`} />
                  <RunDetail label="Release" value={releaseReasonLabel(run.releaseReason)} />
                </dl>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <EmptyState
          className="border border-dashed border-border"
          isCompact
          title="No settled Sandbox runs"
          description="No released Sandbox runs are in this member's history."
        />
      )}
      {history.items.length || pageIndex > 0 || history.nextCursor ? (
        <nav className="flex flex-wrap items-center justify-between gap-3" aria-label="Run history pages">
          <Text type="supporting" color="secondary">
            {history.items.length ? `Runs ${start}-${end}` : "No runs on this page"} · {history.nextCursor ? "More available" : "End of history"}
          </Text>
          <div className="flex gap-2">
            <Button label="Previous" variant="secondary" size="md" isDisabled={pageIndex === 0 || isBusy} onClick={onPrevious} />
            <Button label="Next" variant="secondary" size="md" isDisabled={!history.nextCursor || isBusy} onClick={onNext} />
          </div>
        </nav>
      ) : null}
    </div>
  );
}

type UsageRun = ProjectUsageOverview["sandbox"]["liveRuns"][number] | ProjectSandboxRunHistoryPage["items"][number];

function RunIdentity({ projectId, run }: { projectId: string; run: UsageRun }) {
  return (
    <div className="min-w-0">
      {run.taskAvailable ? (
        <a className="inline-flex max-w-full items-center gap-1 hover:underline" href={taskHref(projectId, run.taskId)}>
          <Text weight="semibold" maxLines={1}>{run.taskTitle || "Untitled task"}</Text>
          <ExternalLink className="size-3 shrink-0" />
        </a>
      ) : (
        <Text weight="semibold">Deleted task</Text>
      )}
      <div className="mt-2 grid gap-1">
        <CopyIdentifier label="Task" value={run.taskId} />
        <CopyIdentifier label="Run" value={run.runId} />
      </div>
    </div>
  );
}

function CopyIdentifier({ label, value }: { label: "Task" | "Run"; value: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
      window.setTimeout(() => setStatus("idle"), 1_500);
    } catch {
      setStatus("error");
    }
  }
  const actionLabel = status === "copied" ? `${label} ID copied` : status === "error" ? `Copy ${label} ID failed` : `Copy ${label} ID`;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Text type="code" color="secondary" maxLines={1}>{label} {value}</Text>
      <IconButton
        className="shrink-0"
        label={actionLabel}
        tooltip={actionLabel}
        variant="ghost"
        size="sm"
        icon={status === "copied" ? <Check size={14} /> : <Copy size={14} />}
        onClick={() => void copy()}
      />
    </div>
  );
}

function RunDetail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt><Text type="supporting" color="secondary">{label}</Text></dt>
      <dd><Text type="supporting" wordBreak="break-word">{value}</Text></dd>
    </>
  );
}

function SandboxTotal({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-surface p-4">
      <dt><Text type="supporting" color="secondary">{label}</Text></dt>
      <dd className="mt-2 break-words"><Text type="large">{value}</Text></dd>
    </div>
  );
}

function UsageTotal({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-surface p-4">
      <dt><Text type="supporting" color="secondary">{label}</Text></dt>
      <dd className="mt-1"><Text type="large">{value}</Text></dd>
    </div>
  );
}

function usageErrorCopy(error: unknown): { title: string; message: string } {
  if (isApiError(error, 503, "sandbox_usage_unavailable")) {
    return { title: "Sandbox allocations unavailable", message: "Sandbox accounting is temporarily unavailable. Retry after the run state is reconciled." };
  }
  return { title: "Usage unavailable", message: "Usage could not be loaded." };
}

function historyErrorCopy(error: unknown): string {
  if (isApiError(error, 400)) return "The run history cursor is no longer valid.";
  if (isApiError(error, 503, "sandbox_usage_unavailable")) return "Sandbox accounting is temporarily unavailable.";
  return "Run history could not be loaded.";
}

function fileStorageMeasurementError(error: unknown): string {
  if (isApiError(error, 503)) return "File storage measurement is temporarily unavailable.";
  return "File storage could not be measured.";
}

function isApiError(error: unknown, status: number, code?: string): boolean {
  return !!error && typeof error === "object" && "status" in error && error.status === status && (code === undefined || ("code" in error && error.code === code));
}

function memberLabel(member: ProjectMemberCandidate): string {
  return member.displayName ? `${member.displayName} (${member.email})` : member.email;
}

function taskHref(_projectId: string, taskId: string): string {
  const pathname = typeof window === "undefined" ? "" : window.location.pathname;
  const projectBase = /^(.*)\/usage\/?$/.exec(pathname)?.[1] || "..";
  return `${projectBase}/tasks/${encodeURIComponent(taskId)}`;
}

function liveStateLabel(state: ProjectUsageOverview["sandbox"]["liveRuns"][number]["state"]): string {
  return {
    starting: "Starting",
    active: "Active",
    release_requested: "Release requested",
    failed: "Failed",
  }[state];
}

function releaseReasonLabel(reason: ProjectSandboxRunHistoryPage["items"][number]["releaseReason"]): string {
  return { requested: "Requested", failed: "Failed", cleanup: "Cleanup" }[reason];
}

function formatMetric(metric: keyof typeof labels, value: number): string {
  return metric === "providerCost" ? formatCost(value) : formatNumber(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatCost(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

function formatProviderDay(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return providerDayFormatter.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
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

function formatUsageWindow(window: ProjectUsageWindow): string {
  if (window.kind === "current_gauge") return "Current state";
  if (window.kind === "rolling") {
    return window.resetAt
      ? `${duration(window.windowSeconds)} rolling · resets ${formatLocalTime(window.resetAt)}`
      : `${duration(window.windowSeconds)} rolling · no usage in window`;
  }
  return `Project lifetime · started ${formatLocalDate(window.startedAt)}`;
}

function duration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${seconds}s`;
}
