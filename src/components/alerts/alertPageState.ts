import type {
  ProjectAlert,
  ProjectAlertView
} from "../../../packages/contracts/src/api.js";

export type AlertPageView = "active" | "history" | "rules";
type AlertListView = ProjectAlertView;
type AlertMutationKind = "ack" | "silence" | "resolve" | "dismiss";

export interface AlertPageQuery {
  view: AlertListView;
  cursor: string | null;
  pageNumber: number;
  cursorStack: string[];
}

export interface AlertPageSnapshot {
  rows: ProjectAlert[];
  pageNumber: number;
  cursorStack: string[];
  nextCursor: string | null;
  activeCount: number | null;
}

interface ListRequestState {
  requestId: string | null;
  requestQuery: AlertPageQuery | null;
  loading: boolean;
  pending: boolean;
  hasLoaded: boolean;
  error: string | null;
}

interface LinkedLookupState {
  requestId: string | null;
  loading: boolean;
  pending: boolean;
  error: string | null;
  notFound: boolean;
}

export interface AlertMutationRetry {
  alert: ProjectAlert;
  action: "ack" | "silence";
  silencedUntil?: string | null;
}

interface MutationState {
  requestId: string | null;
  busyId: string | null;
  action: AlertMutationKind | null;
  error: string | null;
  notice: string | null;
  retry: AlertMutationRetry | null;
  dismissAlert: ProjectAlert | null;
}

export interface AlertPageState {
  view: AlertPageView;
  page: AlertPageSnapshot;
  query: AlertPageQuery | null;
  candidateQuery: AlertPageQuery | null;
  selectedAlertId: string | null;
  linkedAlertId: string | null;
  linkedAlert: ProjectAlert | null;
  list: ListRequestState;
  linkedLookup: LinkedLookupState;
  mutation: MutationState;
}

export type AlertPageAction =
  | { type: "view_changed"; view: AlertPageView }
  | {
      type: "route_changed";
      view: AlertPageView;
      linkedAlertId: string | null;
    }
  | { type: "next_page" }
  | { type: "previous_page" }
  | { type: "first_page" }
  | { type: "list_reload_requested" }
  | { type: "list_request_started"; requestId: string }
  | {
      type: "list_request_succeeded";
      requestId: string;
      rows: ProjectAlert[];
      nextCursor: string | null;
      activeCount: number;
    }
  | { type: "list_request_failed"; requestId: string; message: string }
  | { type: "list_request_finished"; requestId: string }
  | { type: "selection_changed"; alertId: string | null }
  | { type: "row_replaced"; row: ProjectAlert }
  | { type: "linked_lookup_retry_requested" }
  | { type: "linked_lookup_started"; requestId: string }
  | {
      type: "linked_lookup_succeeded";
      requestId: string;
      alert: ProjectAlert;
    }
  | {
      type: "linked_lookup_failed";
      requestId: string;
      reason: "not_found" | "transient";
      message: string;
    }
  | { type: "linked_lookup_finished"; requestId: string }
  | {
      type: "mutation_started";
      requestId: string;
      alert: ProjectAlert;
      action: AlertMutationKind;
    }
  | {
      type: "mutation_succeeded";
      requestId: string;
      row: ProjectAlert;
    }
  | {
      type: "mutation_failed";
      requestId: string;
      message: string;
      retry?: AlertMutationRetry;
    }
  | { type: "mutation_changed_elsewhere"; requestId: string }
  | { type: "mutation_finished"; requestId: string }
  | { type: "mutation_dismiss_changed"; alert: ProjectAlert | null }
  | { type: "mutation_feedback_cleared" }
  | { type: "mutation_cleared" };

const emptyPage = (activeCount: number | null = null): AlertPageSnapshot => ({
  rows: [],
  pageNumber: 1,
  cursorStack: [],
  nextCursor: null,
  activeCount
});

const firstQuery = (view: AlertListView): AlertPageQuery => ({
  view,
  cursor: null,
  pageNumber: 1,
  cursorStack: []
});

const idleList = (pending: boolean): ListRequestState => ({
  requestId: null,
  requestQuery: null,
  loading: false,
  pending,
  hasLoaded: false,
  error: null
});

const idleLookup = (pending: boolean): LinkedLookupState => ({
  requestId: null,
  loading: false,
  pending,
  error: null,
  notFound: false
});

const idleMutation = (): MutationState => ({
  requestId: null,
  busyId: null,
  action: null,
  error: null,
  notice: null,
  retry: null,
  dismissAlert: null
});

export function createAlertPageState(
  input: { view?: AlertPageView; linkedAlertId?: string | null } = {}
): AlertPageState {
  const view = input.view ?? "active";
  const linkedAlertId = input.linkedAlertId ?? null;
  const query = view === "rules" ? null : firstQuery(view);
  return {
    view,
    page: emptyPage(),
    query,
    candidateQuery: query,
    selectedAlertId: linkedAlertId,
    linkedAlertId,
    linkedAlert: null,
    list: idleList(view !== "rules" && linkedAlertId === null),
    linkedLookup: idleLookup(linkedAlertId !== null),
    mutation: idleMutation()
  };
}

export function reduceAlertPageState(
  state: AlertPageState,
  action: AlertPageAction
): AlertPageState {
  switch (action.type) {
    case "view_changed":
      if (action.view === state.view && state.linkedAlertId === null) return state;
      return switchView(state, action.view, false);
    case "route_changed":
      if (
        action.view === state.view &&
        action.linkedAlertId === state.linkedAlertId
      ) {
        return state;
      }
      if (!action.linkedAlertId) {
        return switchView(state, action.view, false);
      }
      return {
        ...switchView(state, action.view, false),
        selectedAlertId: action.linkedAlertId,
        linkedAlertId: action.linkedAlertId,
        linkedLookup: idleLookup(true),
        list: idleList(false)
      };
    case "next_page": {
      if (!state.candidateQuery || !state.page.nextCursor || state.list.loading) {
        return state;
      }
      const cursorStack = [
        ...state.page.cursorStack,
        state.page.nextCursor
      ];
      return {
        ...state,
        candidateQuery: {
          view: state.candidateQuery.view,
          cursor: state.page.nextCursor,
          pageNumber: cursorStack.length + 1,
          cursorStack
        },
        list: { ...state.list, pending: true, error: null }
      };
    }
    case "previous_page": {
      if (
        !state.candidateQuery ||
        state.page.cursorStack.length === 0 ||
        state.list.loading
      ) {
        return state;
      }
      const cursorStack = state.page.cursorStack.slice(0, -1);
      return {
        ...state,
        candidateQuery: {
          view: state.candidateQuery.view,
          cursor: cursorStack.at(-1) ?? null,
          pageNumber: cursorStack.length + 1,
          cursorStack
        },
        list: { ...state.list, pending: true, error: null }
      };
    }
    case "first_page": {
      if (!state.candidateQuery || state.list.loading) return state;
      const query = firstQuery(state.candidateQuery.view);
      return {
        ...state,
        candidateQuery: query,
        list: { ...state.list, pending: true, error: null }
      };
    }
    case "list_reload_requested":
      if (!state.candidateQuery) return state;
      return {
        ...state,
        candidateQuery: state.query ?? state.candidateQuery,
        list: {
          ...state.list,
          requestId: null,
          requestQuery: null,
          loading: false,
          pending: true,
          error: null
        }
      };
    case "list_request_started":
      if (!state.candidateQuery) return state;
      return {
        ...state,
        list: {
          ...state.list,
          requestId: action.requestId,
          requestQuery: state.candidateQuery,
          loading: true,
          pending: false,
          error: null
        }
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
          activeCount: action.activeCount
        },
        query,
        candidateQuery: query,
        selectedAlertId: retainSelection(
          state.selectedAlertId,
          action.rows,
          state.linkedAlert
        ),
        list: {
          ...state.list,
          hasLoaded: true,
          error: null
        }
      };
    }
    case "list_request_failed":
      if (action.requestId !== state.list.requestId) return state;
      return {
        ...state,
        candidateQuery: state.query,
        list: {
          ...state.list,
          error: action.message
        }
      };
    case "list_request_finished":
      if (action.requestId !== state.list.requestId) return state;
      return {
        ...state,
        list: {
          ...state.list,
          requestId: null,
          requestQuery: null,
          loading: false
        }
      };
    case "selection_changed":
      return { ...state, selectedAlertId: action.alertId };
    case "row_replaced":
      return replaceRow(state, action.row);
    case "linked_lookup_retry_requested":
      if (!state.linkedAlertId || state.linkedLookup.loading) return state;
      return {
        ...state,
        linkedLookup: {
          ...state.linkedLookup,
          pending: true,
          error: null,
          notFound: false
        }
      };
    case "linked_lookup_started":
      if (!state.linkedAlertId) return state;
      return {
        ...state,
        linkedLookup: {
          ...state.linkedLookup,
          requestId: action.requestId,
          loading: true,
          pending: false,
          error: null,
          notFound: false
        }
      };
    case "linked_lookup_succeeded": {
      if (action.requestId !== state.linkedLookup.requestId) return state;
      const view = action.alert.status === "active" ? "active" : "history";
      const switched = switchView(state, view, true);
      return {
        ...switched,
        selectedAlertId: action.alert.id,
        linkedAlertId: action.alert.id,
        linkedAlert: action.alert,
        linkedLookup: {
          ...state.linkedLookup,
          error: null,
          notFound: false
        }
      };
    }
    case "linked_lookup_failed":
      if (action.requestId !== state.linkedLookup.requestId) return state;
      if (action.reason === "not_found") {
        return {
          ...state,
          selectedAlertId: null,
          linkedAlertId: null,
          linkedAlert: null,
          linkedLookup: {
            ...state.linkedLookup,
            error: null,
            notFound: true
          },
          list: {
            ...state.list,
            pending: state.view !== "rules"
          }
        };
      }
      return {
        ...state,
        linkedLookup: {
          ...state.linkedLookup,
          error: action.message,
          notFound: false
        }
      };
    case "linked_lookup_finished":
      if (action.requestId !== state.linkedLookup.requestId) return state;
      return {
        ...state,
        linkedLookup: {
          ...state.linkedLookup,
          requestId: null,
          loading: false
        }
      };
    case "mutation_started":
      return {
        ...state,
        candidateQuery: state.query,
        list: {
          ...state.list,
          requestId: null,
          requestQuery: null,
          loading: false,
          pending: false
        },
        mutation: {
          ...state.mutation,
          requestId: action.requestId,
          busyId: action.alert.id,
          action: action.action,
          error: null,
          notice: null,
          retry: null
        }
      };
    case "mutation_succeeded": {
      if (action.requestId !== state.mutation.requestId) return state;
      const replaced = replaceRow(state, action.row);
      const targetView =
        action.row.status === "active" ? "active" : "history";
      const presented =
        state.linkedAlert?.id === action.row.id &&
        state.view !== targetView
          ? switchView(replaced, targetView, true)
          : replaced;
      const candidateQuery =
        presented.view === "rules"
          ? null
          : firstQuery(presented.view);
      return {
        ...presented,
        candidateQuery,
        list: {
          ...presented.list,
          requestId: null,
          requestQuery: null,
          loading: false,
          pending: candidateQuery !== null,
          error: null
        },
        mutation: {
          ...state.mutation,
          error: null,
          notice: null,
          retry: null,
          dismissAlert: null
        }
      };
    }
    case "mutation_failed":
      if (action.requestId !== state.mutation.requestId) return state;
      return {
        ...state,
        mutation: {
          ...state.mutation,
          error: action.message,
          notice: null,
          retry: action.retry ?? null
        }
      };
    case "mutation_changed_elsewhere":
      if (action.requestId !== state.mutation.requestId) return state;
      {
        const candidateQuery =
          state.view === "rules" ? null : firstQuery(state.view);
        return {
          ...state,
          candidateQuery,
          list: {
            ...state.list,
            requestId: null,
            requestQuery: null,
            loading: false,
            pending: candidateQuery !== null,
            error: null
          },
          mutation: {
            ...state.mutation,
            error: null,
            notice:
              "Alert changed elsewhere. Latest state loaded; review it before trying another action.",
            retry: null,
            dismissAlert: null
          }
        };
      }
    case "mutation_finished":
      if (action.requestId !== state.mutation.requestId) return state;
      return {
        ...state,
        mutation: {
          ...state.mutation,
          requestId: null,
          busyId: null,
          action: null
        }
      };
    case "mutation_dismiss_changed":
      if (state.mutation.busyId !== null) return state;
      return {
        ...state,
        mutation: {
          ...state.mutation,
          dismissAlert: action.alert,
          error: null
        }
      };
    case "mutation_feedback_cleared":
      return {
        ...state,
        mutation: {
          ...state.mutation,
          error: null,
          notice: null,
          retry: null
        }
      };
    case "mutation_cleared":
      return { ...state, mutation: idleMutation() };
  }
}

function switchView(
  state: AlertPageState,
  view: AlertPageView,
  preserveLinked: boolean
): AlertPageState {
  const query = view === "rules" ? null : firstQuery(view);
  return {
    ...state,
    view,
    page: emptyPage(state.page.activeCount),
    query,
    candidateQuery: query,
    selectedAlertId: preserveLinked ? state.selectedAlertId : null,
    linkedAlertId: preserveLinked ? state.linkedAlertId : null,
    linkedAlert: preserveLinked ? state.linkedAlert : null,
    list: idleList(view !== "rules"),
    linkedLookup: preserveLinked ? state.linkedLookup : idleLookup(false),
    mutation: state.mutation
  };
}

function replaceRow(
  state: AlertPageState,
  row: ProjectAlert
): AlertPageState {
  const previous =
    state.page.rows.find((item) => item.id === row.id) ??
    (state.linkedAlert?.id === row.id ? state.linkedAlert : undefined);
  const activeDelta = !previous
    ? 0
    : previous.status === "active" && row.status !== "active"
      ? -1
      : previous.status !== "active" && row.status === "active"
        ? 1
        : 0;
  return {
    ...state,
    page: {
      ...state.page,
      rows: state.page.rows.map((item) => item.id === row.id ? row : item),
      activeCount:
        state.page.activeCount === null
          ? null
          : Math.max(0, state.page.activeCount + activeDelta)
    },
    linkedAlert: state.linkedAlert?.id === row.id ? row : state.linkedAlert
  };
}

function retainSelection(
  selectedAlertId: string | null,
  rows: ProjectAlert[],
  linkedAlert: ProjectAlert | null
): string | null {
  if (!selectedAlertId) return null;
  return rows.some((row) => row.id === selectedAlertId) ||
    linkedAlert?.id === selectedAlertId
    ? selectedAlertId
    : null;
}
