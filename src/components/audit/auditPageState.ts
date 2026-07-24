import type {
  ProjectAuditAction,
  ProjectAuditResourceKind,
} from "../../../packages/contracts/src/api.js";
import type { ProjectAuditEvent } from "../../lib/api/client.js";

export const AUDIT_PAGE_SIZE = 20;

export interface AuditFilters {
  actorId: string | null;
  subjectUserId: string | null;
  action: ProjectAuditAction | null;
  status: "accepted" | "rejected" | null;
  resourceKind: ProjectAuditResourceKind | null;
  resourceId: string | null;
  from: string | null;
  to: string | null;
}

export interface AuditPageQuery {
  filters: AuditFilters;
  cursor: string | null;
  pageNumber: number;
  cursorStack: string[];
}

interface AuditPageSnapshot {
  rows: ProjectAuditEvent[];
  pageNumber: number;
  cursorStack: string[];
  nextCursor: string | null;
}

interface AuditListState {
  requestId: string | null;
  requestQuery: AuditPageQuery | null;
  pending: boolean;
  loading: boolean;
  hasLoaded: boolean;
  error: string | null;
}

export interface AuditPageState {
  filters: AuditFilters;
  page: AuditPageSnapshot;
  query: AuditPageQuery | null;
  candidateQuery: AuditPageQuery;
  failedQuery: AuditPageQuery | null;
  list: AuditListState;
  selectedEvent: ProjectAuditEvent | null;
}

export type AuditPageAction =
  | { type: "filters_committed"; filters: AuditFilters }
  | { type: "route_changed"; filters: AuditFilters }
  | { type: "refresh_requested" }
  | { type: "retry_requested" }
  | { type: "next_page" }
  | { type: "previous_page" }
  | { type: "list_request_started"; requestId: string }
  | {
      type: "list_request_succeeded";
      requestId: string;
      rows: ProjectAuditEvent[];
      nextCursor: string | null;
    }
  | { type: "list_request_failed"; requestId: string; message: string }
  | { type: "list_request_finished"; requestId: string }
  | {
      type: "selected_event_changed";
      event: ProjectAuditEvent | null;
    };

export function emptyAuditFilters(): AuditFilters {
  return {
    actorId: null,
    subjectUserId: null,
    action: null,
    status: null,
    resourceKind: null,
    resourceId: null,
    from: null,
    to: null,
  };
}

export function createAuditPageState(
  filters: AuditFilters = emptyAuditFilters(),
): AuditPageState {
  const candidateQuery = firstQuery(filters);
  return {
    filters,
    page: {
      rows: [],
      pageNumber: 1,
      cursorStack: [],
      nextCursor: null,
    },
    query: null,
    candidateQuery,
    failedQuery: null,
    list: {
      requestId: null,
      requestQuery: null,
      pending: true,
      loading: false,
      hasLoaded: false,
      error: null,
    },
    selectedEvent: null,
  };
}

export function reduceAuditPageState(
  state: AuditPageState,
  action: AuditPageAction,
): AuditPageState {
  switch (action.type) {
    case "filters_committed":
    case "route_changed":
      return startCandidate(state, firstQuery(action.filters), action.filters);
    case "refresh_requested": {
      const candidate =
        state.failedQuery ??
        (state.query && filtersEqual(state.query.filters, state.filters)
          ? state.query
          : firstQuery(state.filters));
      return startCandidate(state, candidate);
    }
    case "retry_requested":
      if (!state.failedQuery) return state;
      return {
        ...startCandidate(state, state.failedQuery),
        failedQuery: state.failedQuery,
      };
    case "next_page": {
      if (
        state.list.loading ||
        state.list.pending ||
        !state.query ||
        !filtersEqual(state.query.filters, state.filters) ||
        !state.page.nextCursor
      ) {
        return state;
      }
      const cursorStack = [
        ...state.page.cursorStack,
        state.page.nextCursor,
      ];
      return startCandidate(state, {
        filters: state.filters,
        cursor: state.page.nextCursor,
        pageNumber: cursorStack.length + 1,
        cursorStack,
      });
    }
    case "previous_page": {
      if (
        state.list.loading ||
        state.list.pending ||
        !state.query ||
        !filtersEqual(state.query.filters, state.filters) ||
        state.page.cursorStack.length === 0
      ) {
        return state;
      }
      const cursorStack = state.page.cursorStack.slice(0, -1);
      return startCandidate(state, {
        filters: state.filters,
        cursor: cursorStack.at(-1) ?? null,
        pageNumber: cursorStack.length + 1,
        cursorStack,
      });
    }
    case "list_request_started":
      if (!state.list.pending) return state;
      return {
        ...state,
        list: {
          ...state.list,
          requestId: action.requestId,
          requestQuery: state.candidateQuery,
          pending: false,
          loading: true,
          error: null,
        },
      };
    case "list_request_succeeded": {
      if (action.requestId !== state.list.requestId) return state;
      const query = state.list.requestQuery;
      if (!query) return state;
      return {
        ...state,
        page: {
          rows: action.rows,
          pageNumber: query.pageNumber,
          cursorStack: query.cursorStack,
          nextCursor: action.nextCursor,
        },
        query,
        candidateQuery: query,
        failedQuery: null,
        list: {
          ...state.list,
          hasLoaded: true,
          error: null,
        },
      };
    }
    case "list_request_failed":
      if (action.requestId !== state.list.requestId) return state;
      return {
        ...state,
        failedQuery: state.list.requestQuery,
        candidateQuery: state.list.requestQuery ?? state.candidateQuery,
        list: {
          ...state.list,
          error: action.message,
        },
      };
    case "list_request_finished":
      if (action.requestId !== state.list.requestId) return state;
      return {
        ...state,
        list: {
          ...state.list,
          requestId: null,
          requestQuery: null,
          loading: false,
        },
      };
    case "selected_event_changed":
      return { ...state, selectedEvent: action.event };
  }
}

export function auditFiltersEqual(
  left: AuditFilters,
  right: AuditFilters,
): boolean {
  return filtersEqual(left, right);
}

function firstQuery(filters: AuditFilters): AuditPageQuery {
  return {
    filters,
    cursor: null,
    pageNumber: 1,
    cursorStack: [],
  };
}

function startCandidate(
  state: AuditPageState,
  candidateQuery: AuditPageQuery,
  filters: AuditFilters = state.filters,
): AuditPageState {
  return {
    ...state,
    filters,
    candidateQuery,
    failedQuery: null,
    list: {
      ...state.list,
      requestId: null,
      requestQuery: null,
      pending: true,
      loading: false,
      error: null,
    },
  };
}

function filtersEqual(left: AuditFilters, right: AuditFilters): boolean {
  return (
    left.actorId === right.actorId &&
    left.subjectUserId === right.subjectUserId &&
    left.action === right.action &&
    left.status === right.status &&
    left.resourceKind === right.resourceKind &&
    left.resourceId === right.resourceId &&
    left.from === right.from &&
    left.to === right.to
  );
}
