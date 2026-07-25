"use client";

import { RefreshCw } from "lucide-react";
import { IconButton } from "@astryxdesign/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  apiClient,
  type ProjectMemberCandidate,
  type ProjectSandboxRunHistoryPage,
  type ProjectUsageOverview,
} from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { UsageView } from "./UsageView";

export { AuditPage } from "../audit/AuditPage";

export function UsagePage({ projectId }: { projectId: string }) {
  return <UsageProjectPage key={projectId} projectId={projectId} />;
}

type UsageOverviewProvenance = {
  projectId: string;
  sandboxScope: string;
  endpointId: string;
  overview: ProjectUsageOverview;
};

type UsageState = {
  usage: UsageOverviewProvenance | undefined;
  fileStorage: { projectId: string; value: ProjectUsageOverview["fileStorage"] } | undefined;
};

type UsageCommit =
  | { kind: "overview"; usage: UsageOverviewProvenance }
  | { kind: "file_storage"; projectId: string; fileStorage: ProjectUsageOverview["fileStorage"] }
  | { kind: "clear_overview"; projectId: string };

function mergeUsageCommit(current: UsageState, commit: UsageCommit): UsageState {
  if (commit.kind === "clear_overview") {
    return current.usage?.projectId === commit.projectId ? { ...current, usage: undefined } : current;
  }
  if (commit.kind === "file_storage") {
    const sameUsage = current.usage?.projectId === commit.projectId;
    const sameStorage = current.fileStorage?.projectId === commit.projectId;
    if (!sameUsage && !sameStorage) return current;
    const fileStorage = sameStorage
      ? newerFileStorage(current.fileStorage!.value, commit.fileStorage)
      : commit.fileStorage;
    return {
      usage: sameUsage
        ? { ...current.usage!, overview: { ...current.usage!.overview, fileStorage } }
        : current.usage,
      fileStorage: { projectId: commit.projectId, value: fileStorage },
    };
  }
  const preserved = current.fileStorage?.projectId === commit.usage.projectId
    ? current.fileStorage.value
    : undefined;
  const fileStorage = preserved
    ? newerFileStorage(preserved, commit.usage.overview.fileStorage)
    : commit.usage.overview.fileStorage;
  return {
    usage: {
      ...commit.usage,
      overview: { ...commit.usage.overview, fileStorage },
    },
    fileStorage: { projectId: commit.usage.projectId, value: fileStorage },
  };
}

function newerFileStorage(
  current: ProjectUsageOverview["fileStorage"],
  incoming: ProjectUsageOverview["fileStorage"],
): ProjectUsageOverview["fileStorage"] {
  const currentTime = current.measuredAt === null ? Number.NEGATIVE_INFINITY : Date.parse(current.measuredAt);
  const incomingTime = incoming.measuredAt === null ? Number.NEGATIVE_INFINITY : Date.parse(incoming.measuredAt);
  return incomingTime >= currentTime ? incoming : current;
}

type UsageHistoryProvenance = {
  projectId: string;
  sandboxScope: string;
  cursor: string | null;
  cursorStack: Array<string | null>;
  page: ProjectSandboxRunHistoryPage;
};

type UsageLoadState = "idle" | "loading" | "ready" | "error";
type HistoryOperation = "initial" | "pagination" | "refresh";
type FileStorageState = "idle" | "loading" | "error";
type HistoryRequest = {
  requestedUserId: string | undefined;
  cursor: string | null;
  cursorStack: Array<string | null>;
  operation: HistoryOperation;
};

function UsageProjectPage({ projectId }: { projectId: string }) {
  const [usageState, setUsageState] = useState<UsageState>({ usage: undefined, fileStorage: undefined });
  const usage = usageState.usage;
  const [history, setHistory] = useState<UsageHistoryProvenance>();
  const [endpointId, setEndpointId] = useState(() => browserQuery().get("endpointId") || "all");
  const [selectedUserId, setSelectedUserId] = useState<string>();
  const [currentUserId, setCurrentUserId] = useState<string>();
  const [selectedMember,setSelectedMember]=useState<ProjectMemberCandidate>();
  const [overviewError, setOverviewError] = useState<unknown>();
  const [historyError, setHistoryError] = useState<unknown>();
  const [fileStorageError, setFileStorageError] = useState<unknown>();
  const [scopeNotice, setScopeNotice] = useState<string>();
  const [overviewState, setOverviewState] = useState<UsageLoadState>("loading");
  const [historyState, setHistoryState] = useState<UsageLoadState>("idle");
  const [historyOperation, setHistoryOperation] = useState<HistoryOperation>("initial");
  const [fileStorageState, setFileStorageState] = useState<FileStorageState>("idle");
  const [historyRetry, setHistoryRetry] = useState<HistoryRequest>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const active = useRef(true);
  const overviewRevision = useRef(0);
  const historyRevision = useRef(0);
  const fileStorageRevision = useRef(0);
  const sandboxScope = selectedUserId ?? "self";
  const visibleUsage = usage?.projectId === projectId && usage.sandboxScope === sandboxScope && usage.endpointId === endpointId ? usage.overview : undefined;
  const visibleHistory = history?.projectId === projectId && history.sandboxScope === sandboxScope ? history : undefined;

  const loadOverview = useCallback(async () => {
    const revision = ++overviewRevision.current;
    const requestedProjectId = projectId;
    const requestedSandboxScope = selectedUserId ?? "self";
    const requestedEndpointId = endpointId;
    setOverviewState("loading");
    setOverviewError(undefined);
    try {
      const loaded = await apiClient.usage(projectId, {
        ...(endpointId === "all" ? {} : { endpointId }),
        ...(selectedUserId ? { userId: selectedUserId } : {}),
      });
      if (!active.current || revision !== overviewRevision.current || requestedProjectId !== projectId) return;
      setUsageState((current) => mergeUsageCommit(current, {
        kind: "overview",
        usage: {
          projectId: requestedProjectId,
          sandboxScope: requestedSandboxScope,
          endpointId: requestedEndpointId,
          overview: loaded,
        },
      }));
      if(!selectedUserId)setCurrentUserId(loaded.sandbox.selectedUserId);
      setOverviewError(undefined);
      setOverviewState("ready");
    } catch (cause) {
      if (!active.current || revision !== overviewRevision.current || requestedProjectId !== projectId) return;
      if (selectedUserId && cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) {
        historyRevision.current += 1;
        setUsageState((current) => mergeUsageCommit(current, { kind: "clear_overview", projectId: requestedProjectId }));
        setHistory(undefined);
        setSelectedUserId(undefined);
        setSelectedMember(undefined);
        setHistoryError(undefined);
        setHistoryRetry(undefined);
        setHistoryState("idle");
        setScopeNotice("That member's Sandbox usage is no longer available. Showing your usage.");
        return;
      }
      if (endpointId !== "all" && cause instanceof ApiError && cause.status === 404) {
        const query = browserQuery();
        query.delete("endpointId");
        replaceBrowserQuery(query);
        setUsageState((current) => mergeUsageCommit(current, { kind: "clear_overview", projectId: requestedProjectId }));
        setEndpointId("all");
        setScopeNotice("That endpoint is no longer available. Showing all endpoints.");
        return;
      }
      setOverviewError(cause);
      setOverviewState("error");
    }
  }, [projectId, endpointId, selectedUserId]);

  const loadHistory = useCallback(async ({
    requestedUserId,
    cursor,
    cursorStack,
    operation,
  }: HistoryRequest) => {
    const revision = ++historyRevision.current;
    const requestedProjectId = projectId;
    const requestedSandboxScope = requestedUserId ?? "self";
    setHistoryOperation(operation);
    setHistoryState("loading");
    setHistoryError(undefined);
    try {
      const page = await apiClient.sandboxRunHistory(projectId, {
        ...(requestedUserId ? { userId: requestedUserId } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 20,
      });
      if (!active.current || revision !== historyRevision.current || requestedProjectId !== projectId) return;
      setHistory({
        projectId: requestedProjectId,
        sandboxScope: requestedSandboxScope,
        cursor,
        cursorStack,
        page,
      });
      setHistoryRetry(undefined);
      setHistoryState("ready");
    } catch (cause) {
      if (!active.current || revision !== historyRevision.current || requestedProjectId !== projectId) return;
      if (requestedUserId && cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) {
        overviewRevision.current += 1;
        setUsageState((current) => mergeUsageCommit(current, { kind: "clear_overview", projectId: requestedProjectId }));
        setHistory(undefined);
        setSelectedUserId(undefined);
        setSelectedMember(undefined);
        setOverviewError(undefined);
        setOverviewState("loading");
        setHistoryRetry(undefined);
        setHistoryState("idle");
        setScopeNotice("That member's Sandbox usage is no longer available. Showing your usage.");
        return;
      }
      setHistoryRetry({ requestedUserId, cursor, cursorStack, operation });
      setHistoryError(cause);
      setHistoryState("error");
    }
  }, [projectId]);

  const measureFileStorage = useCallback(async () => {
    const revision = ++fileStorageRevision.current;
    const requestedProjectId = projectId;
    setFileStorageState("loading");
    setFileStorageError(undefined);
    try {
      const measured = await apiClient.measureFileStorage(projectId);
      if (!active.current || revision !== fileStorageRevision.current || requestedProjectId !== projectId) return;
      if (measured.projectId !== requestedProjectId) throw new ApiError(502, "File storage measurement returned the wrong project.");
      setUsageState((current) => mergeUsageCommit(current, {
        kind: "file_storage",
        projectId: requestedProjectId,
        fileStorage: measured.fileStorage,
      }));
      setFileStorageState("idle");
    } catch (cause) {
      if (!active.current || revision !== fileStorageRevision.current || requestedProjectId !== projectId) return;
      setFileStorageError(cause);
      setFileStorageState("error");
    }
  }, [projectId]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      overviewRevision.current += 1;
      historyRevision.current += 1;
      fileStorageRevision.current += 1;
    };
  }, []);
  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);
  useEffect(() => {
    if (!historyOpen || visibleHistory || historyState !== "idle") return;
    void loadHistory({
      requestedUserId: selectedUserId,
      cursor: null,
      cursorStack: [],
      operation: "initial",
    });
  }, [historyOpen, historyState, loadHistory, selectedUserId, visibleHistory]);

  function changeEndpoint(nextEndpointId: string) {
    if (nextEndpointId === endpointId) return;
    overviewRevision.current += 1;
    setOverviewError(undefined);
    setOverviewState("loading");
    setScopeNotice(undefined);
    const query = browserQuery();
    if (nextEndpointId === "all") query.delete("endpointId");
    else query.set("endpointId", nextEndpointId);
    replaceBrowserQuery(query);
    setEndpointId(nextEndpointId);
  }

  function changeUser(member:ProjectMemberCandidate) {
    const nextUserId = member.userId === currentUserId ? undefined : member.userId;
    if (nextUserId === selectedUserId) return;
    overviewRevision.current += 1;
    historyRevision.current += 1;
    setOverviewError(undefined);
    setOverviewState("loading");
    setHistory(undefined);
    setHistoryError(undefined);
    setHistoryRetry(undefined);
    setHistoryState("idle");
    setScopeNotice(undefined);
    setSelectedMember(nextUserId?member:undefined);
    setSelectedUserId(nextUserId);
  }

  function refresh() {
    void loadOverview();
    if (historyOpen && visibleHistory) {
      void loadHistory({
        requestedUserId: selectedUserId,
        cursor: visibleHistory.cursor,
        cursorStack: visibleHistory.cursorStack,
        operation: "refresh",
      });
    }
  }

  function nextHistoryPage() {
    if (!visibleHistory?.page.nextCursor || historyState === "loading") return;
    void loadHistory({
      requestedUserId: selectedUserId,
      cursor: visibleHistory.page.nextCursor,
      cursorStack: [...visibleHistory.cursorStack, visibleHistory.cursor],
      operation: "pagination",
    });
  }

  function previousHistoryPage() {
    if (!visibleHistory || historyState === "loading") return;
    const previousCursor = visibleHistory.cursorStack.at(-1);
    if (previousCursor === undefined) return;
    void loadHistory({
      requestedUserId: selectedUserId,
      cursor: previousCursor,
      cursorStack: visibleHistory.cursorStack.slice(0, -1),
      operation: "pagination",
    });
  }

  function refreshHistory() {
    if (!visibleHistory || historyState === "loading") return;
    void loadHistory({
      requestedUserId: selectedUserId,
      cursor: visibleHistory.cursor,
      cursorStack: visibleHistory.cursorStack,
      operation: "refresh",
    });
  }

  function retryHistory() {
    if (historyRetry) {
      void loadHistory(historyRetry);
      return;
    }
    void loadHistory({
      requestedUserId: selectedUserId,
      cursor: visibleHistory?.cursor ?? null,
      cursorStack: visibleHistory?.cursorStack ?? [],
      operation: visibleHistory ? "refresh" : "initial",
    });
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
              onClick={refresh}
            />
          }
        />
      }
    >
      <UsageView
        projectId={projectId}
        overview={visibleUsage}
        overviewState={overviewState}
        overviewError={overviewError}
        scopeNotice={scopeNotice}
        currentUserId={currentUserId}
        selectedMember={selectedMember}
        selectedEndpointId={endpointId}
        selectedSandboxUserId={selectedUserId}
        historyOpen={historyOpen}
        history={visibleHistory?.page}
        historyPageIndex={visibleHistory?.cursorStack.length ?? 0}
        historyState={historyState}
        historyError={historyError}
        historyOperation={historyOperation}
        fileStorageState={fileStorageState}
        fileStorageError={fileStorageError}
        onEndpointChange={changeEndpoint}
        onSandboxUserChange={changeUser}
        onRetryOverview={loadOverview}
        onHistoryOpenChange={setHistoryOpen}
        onHistoryPrevious={previousHistoryPage}
        onHistoryNext={nextHistoryPage}
        onHistoryRefresh={refreshHistory}
        onHistoryRetry={retryHistory}
        onMeasureFileStorage={measureFileStorage}
      />
    </PageLayout>
  );
}

function browserQuery(): URLSearchParams {
  return new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search,
  );
}

function replaceBrowserQuery(query: URLSearchParams) {
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${query.size ? `?${query}` : ""}${window.location.hash}`,
  );
}
