import type {
  ProjectAuditIdentity,
  ProjectAuditIdentityQuery,
} from "../../lib/api/client.js";

export const AUDIT_IDENTITY_PAGE_SIZE = 20;

type AuditIdentityRole = ProjectAuditIdentityQuery["role"];

export interface AuditIdentityListKey {
  projectId: string;
  role: AuditIdentityRole;
  query: string;
  cursor: string | null;
}

export interface AuditIdentityHydrationKey {
  projectId: string;
  role: AuditIdentityRole;
  value: string;
}

export interface AuditIdentityPresentation {
  key: string;
  identity: ProjectAuditIdentity;
}

interface AuditIdentityListState {
  candidate: AuditIdentityListKey;
  cursorStack: Array<string | null>;
  attempt: number;
  pending: boolean;
  request: {
    requestId: string;
    key: AuditIdentityListKey;
  } | null;
  page: {
    key: AuditIdentityListKey;
    items: ProjectAuditIdentity[];
    nextCursor: string | null;
  } | null;
  error: {
    key: AuditIdentityListKey;
    message: string;
  } | null;
}

interface AuditIdentityHydrationState {
  candidate: AuditIdentityHydrationKey | null;
  attempt: number;
  pending: boolean;
  request: {
    requestId: string;
    key: AuditIdentityHydrationKey;
  } | null;
  resolved: {
    key: AuditIdentityHydrationKey;
    identity: ProjectAuditIdentity | null;
  } | null;
  error: {
    key: AuditIdentityHydrationKey;
    message: string;
  } | null;
}

export interface AuditIdentityPickerState {
  list: AuditIdentityListState;
  hydration: AuditIdentityHydrationState;
}

export type AuditIdentityPickerAction =
  | {
      type: "context_changed";
      projectId: string;
      role: AuditIdentityRole;
    }
  | { type: "search_committed"; query: string }
  | { type: "next_page_requested" }
  | { type: "previous_page_requested" }
  | { type: "list_retry_requested" }
  | { type: "list_request_started"; requestId: string }
  | {
      type: "list_request_succeeded";
      requestId: string;
      items: ProjectAuditIdentity[];
      nextCursor: string | null;
    }
  | {
      type: "list_request_failed";
      requestId: string;
      message: string;
    }
  | { type: "list_request_finished"; requestId: string }
  | { type: "hydration_candidate_changed"; value: string | null }
  | { type: "hydration_retry_requested" }
  | { type: "hydration_request_started"; requestId: string }
  | {
      type: "hydration_request_succeeded";
      requestId: string;
      identity: ProjectAuditIdentity | null;
    }
  | {
      type: "hydration_request_failed";
      requestId: string;
      message: string;
    }
  | { type: "hydration_request_finished"; requestId: string };

export function createAuditIdentityPickerState(
  projectId: string,
  role: AuditIdentityRole,
): AuditIdentityPickerState {
  return {
    list: {
      candidate: listKey(projectId, role, "", null),
      cursorStack: [null],
      attempt: 1,
      pending: true,
      request: null,
      page: null,
      error: null,
    },
    hydration: {
      candidate: null,
      attempt: 0,
      pending: false,
      request: null,
      resolved: null,
      error: null,
    },
  };
}

export function reduceAuditIdentityPickerState(
  state: AuditIdentityPickerState,
  action: AuditIdentityPickerAction,
): AuditIdentityPickerState {
  switch (action.type) {
    case "context_changed": {
      if (
        state.list.candidate.projectId === action.projectId &&
        state.list.candidate.role === action.role
      ) {
        return state;
      }
      return createAuditIdentityPickerState(action.projectId, action.role);
    }
    case "search_committed":
      return {
        ...state,
        list: {
          ...state.list,
          candidate: listKey(
            state.list.candidate.projectId,
            state.list.candidate.role,
            action.query.trim(),
            null,
          ),
          cursorStack: [null],
          attempt: state.list.attempt + 1,
          pending: true,
          request: null,
          error: null,
        },
      };
    case "next_page_requested": {
      const paging = auditIdentityListPaging(state);
      if (
        !paging.nextCursor ||
        state.list.pending ||
        state.list.request
      ) {
        return state;
      }
      return moveToCursor(state, [
        ...state.list.cursorStack,
        paging.nextCursor,
      ]);
    }
    case "previous_page_requested":
      if (
        !auditIdentityListPaging(state).canPrevious ||
        state.list.pending ||
        state.list.request
      ) {
        return state;
      }
      return moveToCursor(state, state.list.cursorStack.slice(0, -1));
    case "list_retry_requested":
      if (
        state.list.pending ||
        state.list.request ||
        !state.list.error ||
        !listKeysEqual(state.list.error.key, state.list.candidate)
      ) {
        return state;
      }
      return {
        ...state,
        list: {
          ...state.list,
          attempt: state.list.attempt + 1,
          pending: true,
          error: null,
        },
      };
    case "list_request_started":
      if (!state.list.pending || state.list.request) return state;
      return {
        ...state,
        list: {
          ...state.list,
          pending: false,
          request: {
            requestId: action.requestId,
            key: state.list.candidate,
          },
          error: null,
        },
      };
    case "list_request_succeeded":
      if (state.list.request?.requestId !== action.requestId) return state;
      return {
        ...state,
        list: {
          ...state.list,
          page: {
            key: state.list.request.key,
            items: action.items,
            nextCursor: action.nextCursor,
          },
          error: null,
        },
      };
    case "list_request_failed":
      if (state.list.request?.requestId !== action.requestId) return state;
      return {
        ...state,
        list: {
          ...state.list,
          error: {
            key: state.list.request.key,
            message: action.message,
          },
        },
      };
    case "list_request_finished":
      if (state.list.request?.requestId !== action.requestId) return state;
      return {
        ...state,
        list: {
          ...state.list,
          request: null,
        },
      };
    case "hydration_candidate_changed": {
      const candidate =
        action.value && action.value !== "system"
          ? {
              projectId: state.list.candidate.projectId,
              role: state.list.candidate.role,
              value: action.value,
            }
          : null;
      if (hydrationKeysEqual(candidate, state.hydration.candidate)) {
        return state;
      }
      return {
        ...state,
        hydration: {
          candidate,
          attempt: state.hydration.attempt + 1,
          pending: Boolean(candidate),
          request: null,
          resolved: null,
          error: null,
        },
      };
    }
    case "hydration_retry_requested":
      if (
        state.hydration.pending ||
        state.hydration.request ||
        !state.hydration.candidate ||
        !state.hydration.error ||
        !hydrationKeysEqual(
          state.hydration.error.key,
          state.hydration.candidate,
        )
      ) {
        return state;
      }
      return {
        ...state,
        hydration: {
          ...state.hydration,
          attempt: state.hydration.attempt + 1,
          pending: true,
          error: null,
        },
      };
    case "hydration_request_started":
      if (!state.hydration.pending || state.hydration.request) return state;
      if (!state.hydration.candidate) return state;
      return {
        ...state,
        hydration: {
          ...state.hydration,
          pending: false,
          request: {
            requestId: action.requestId,
            key: state.hydration.candidate,
          },
          error: null,
        },
      };
    case "hydration_request_succeeded":
      if (state.hydration.request?.requestId !== action.requestId) {
        return state;
      }
      return {
        ...state,
        hydration: {
          ...state.hydration,
          resolved: {
            key: state.hydration.request.key,
            identity: action.identity,
          },
          error: null,
        },
      };
    case "hydration_request_failed":
      if (state.hydration.request?.requestId !== action.requestId) {
        return state;
      }
      return {
        ...state,
        hydration: {
          ...state.hydration,
          error: {
            key: state.hydration.request.key,
            message: action.message,
          },
        },
      };
    case "hydration_request_finished":
      if (state.hydration.request?.requestId !== action.requestId) {
        return state;
      }
      return {
        ...state,
        hydration: {
          ...state.hydration,
          request: null,
        },
      };
  }
}

export function auditIdentityListQuery(
  key: AuditIdentityListKey,
): ProjectAuditIdentityQuery {
  return {
    role: key.role,
    q: key.query,
    ...(key.cursor ? { cursor: key.cursor } : {}),
    limit: AUDIT_IDENTITY_PAGE_SIZE,
  };
}

export function auditIdentityHydrationQuery(
  key: AuditIdentityHydrationKey,
): ProjectAuditIdentityQuery {
  return {
    role: key.role,
    q: key.value,
    limit: AUDIT_IDENTITY_PAGE_SIZE,
  };
}

export function formatAuditIdentityLabel(
  id: string,
  displayName: string | null,
  email: string | null,
): string {
  if (displayName && email) return `${displayName} (${email})`;
  return displayName ?? email ?? id;
}

export function auditIdentityPresentationLabel(
  value: string,
  presentation: AuditIdentityPresentation | null,
): string {
  if (
    presentation?.key !== value ||
    presentation.identity.id !== value
  ) {
    return value;
  }
  return formatAuditIdentityLabel(
    presentation.identity.id,
    presentation.identity.displayName,
    presentation.identity.email,
  );
}

export function auditIdentityListPaging(state: AuditIdentityPickerState): {
  pageNumber: number;
  canPrevious: boolean;
  nextCursor: string | null;
} {
  const pageIsCurrent =
    state.list.page &&
    listKeysEqual(state.list.page.key, state.list.candidate);
  return {
    pageNumber: state.list.cursorStack.length,
    canPrevious: Boolean(pageIsCurrent && state.list.cursorStack.length > 1),
    nextCursor: pageIsCurrent ? state.list.page?.nextCursor ?? null : null,
  };
}

export function auditIdentityHydratedIdentity(
  state: AuditIdentityPickerState,
): ProjectAuditIdentity | null {
  if (
    !state.hydration.resolved ||
    !hydrationKeysEqual(
      state.hydration.resolved.key,
      state.hydration.candidate,
    )
  ) {
    return null;
  }
  return state.hydration.resolved.identity;
}

function moveToCursor(
  state: AuditIdentityPickerState,
  cursorStack: Array<string | null>,
): AuditIdentityPickerState {
  const cursor = cursorStack.at(-1) ?? null;
  return {
    ...state,
    list: {
      ...state.list,
      candidate: {
        ...state.list.candidate,
        cursor,
      },
      cursorStack,
      attempt: state.list.attempt + 1,
      pending: true,
      error: null,
    },
  };
}

function listKey(
  projectId: string,
  role: AuditIdentityRole,
  query: string,
  cursor: string | null,
): AuditIdentityListKey {
  return { projectId, role, query, cursor };
}

function listKeysEqual(
  left: AuditIdentityListKey,
  right: AuditIdentityListKey,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.role === right.role &&
    left.query === right.query &&
    left.cursor === right.cursor
  );
}

function hydrationKeysEqual(
  left: AuditIdentityHydrationKey | null,
  right: AuditIdentityHydrationKey | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.projectId === right.projectId &&
    left.role === right.role &&
    left.value === right.value
  );
}
