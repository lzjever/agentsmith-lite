import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectAuditEvent } from "../../src/lib/api/client.js";
import {
  createAuditPageState,
  emptyAuditFilters,
  reduceAuditPageState,
} from "../../src/components/audit/auditPageState.js";

const event = (id: string): ProjectAuditEvent => ({
  id,
  projectId: "project_1",
  actorId: "user_actor",
  subjectUserId: "user_subject",
  action: "task.create",
  status: "accepted",
  resourceKind: "task",
  resourceId: `task_${id}`,
  createdAt: "2026-07-24T12:00:00.000Z",
  actorDisplayName: "Actor",
  actorEmail: "actor@example.test",
  subjectDisplayName: "Subject",
  subjectEmail: "subject@example.test",
});

function succeed(
  state: ReturnType<typeof createAuditPageState>,
  requestId: string,
  rows: ProjectAuditEvent[],
  nextCursor: string | null,
) {
  state = reduceAuditPageState(state, {
    type: "list_request_started",
    requestId,
  });
  state = reduceAuditPageState(state, {
    type: "list_request_succeeded",
    requestId,
    rows,
    nextCursor,
  });
  return reduceAuditPageState(state, {
    type: "list_request_finished",
    requestId,
  });
}

describe("audit page list state", () => {
  it("preserves last-good rows and selected detail while page and refresh requests run", () => {
    const first = event("first");
    const second = event("second");
    let state = succeed(
      createAuditPageState(),
      "page-1",
      [first],
      "cursor-2",
    );
    state = reduceAuditPageState(state, {
      type: "selected_event_changed",
      event: first,
    });
    state = reduceAuditPageState(state, { type: "next_page" });
    state = reduceAuditPageState(state, {
      type: "list_request_started",
      requestId: "page-2",
    });

    assert.deepEqual(state.page.rows, [first]);
    assert.strictEqual(state.selectedEvent, first);
    assert.equal(state.list.loading, true);

    state = reduceAuditPageState(state, {
      type: "list_request_succeeded",
      requestId: "page-2",
      rows: [second],
      nextCursor: null,
    });
    state = reduceAuditPageState(state, {
      type: "list_request_finished",
      requestId: "page-2",
    });
    state = reduceAuditPageState(state, { type: "refresh_requested" });
    state = reduceAuditPageState(state, {
      type: "list_request_started",
      requestId: "refresh",
    });
    state = reduceAuditPageState(state, {
      type: "list_request_failed",
      requestId: "refresh",
      message: "Refresh failed",
    });
    state = reduceAuditPageState(state, {
      type: "list_request_finished",
      requestId: "refresh",
    });

    assert.deepEqual(state.page.rows, [second]);
    assert.equal(state.page.pageNumber, 2);
    assert.strictEqual(state.selectedEvent, first);
    assert.equal(state.list.error, "Refresh failed");
  });

  it("ignores stale success and finally actions after an atomic filter change", () => {
    const first = event("first");
    let state = createAuditPageState();
    state = reduceAuditPageState(state, {
      type: "list_request_started",
      requestId: "stale",
    });
    state = reduceAuditPageState(state, {
      type: "filters_committed",
      filters: {
        ...emptyAuditFilters(),
        action: "task.create",
      },
    });
    state = reduceAuditPageState(state, {
      type: "list_request_started",
      requestId: "current",
    });

    const ownedByCurrent = state;
    state = reduceAuditPageState(state, {
      type: "list_request_succeeded",
      requestId: "stale",
      rows: [first],
      nextCursor: "wrong",
    });
    assert.strictEqual(state, ownedByCurrent);
    state = reduceAuditPageState(state, {
      type: "list_request_finished",
      requestId: "stale",
    });
    assert.strictEqual(state, ownedByCurrent);
  });

  it("retains the last-good page and retries the exact failed candidate", () => {
    const first = event("first");
    let state = succeed(
      createAuditPageState(),
      "initial",
      [first],
      "cursor-2",
    );
    const attemptedFilters = {
      ...emptyAuditFilters(),
      resourceId: "task_exact",
    };
    state = reduceAuditPageState(state, {
      type: "filters_committed",
      filters: attemptedFilters,
    });
    state = reduceAuditPageState(state, {
      type: "list_request_started",
      requestId: "failed-filter",
    });
    state = reduceAuditPageState(state, {
      type: "list_request_failed",
      requestId: "failed-filter",
      message: "Audit events could not be loaded.",
    });
    state = reduceAuditPageState(state, {
      type: "list_request_finished",
      requestId: "failed-filter",
    });

    assert.deepEqual(state.page.rows, [first]);
    assert.equal(state.query?.filters.resourceId, null);
    assert.equal(state.failedQuery?.filters.resourceId, "task_exact");
    assert.strictEqual(state.selectedEvent, null);

    state = reduceAuditPageState(state, { type: "retry_requested" });
    assert.equal(state.list.pending, true);
    assert.deepEqual(state.candidateQuery, state.failedQuery);
  });

  it("replaces cursor pages, navigates back, and keeps detail through popstate", () => {
    const first = event("first");
    const second = event("second");
    let state = succeed(
      createAuditPageState(),
      "page-1",
      [first],
      "cursor-2",
    );
    state = reduceAuditPageState(state, {
      type: "selected_event_changed",
      event: first,
    });
    state = reduceAuditPageState(state, { type: "next_page" });
    state = succeed(state, "page-2", [second], null);

    assert.deepEqual(state.page.rows, [second]);
    assert.equal(state.page.pageNumber, 2);
    assert.deepEqual(state.page.cursorStack, ["cursor-2"]);

    state = reduceAuditPageState(state, { type: "previous_page" });
    assert.equal(state.candidateQuery.cursor, null);
    assert.equal(state.candidateQuery.pageNumber, 1);

    state = reduceAuditPageState(state, {
      type: "route_changed",
      filters: {
        ...emptyAuditFilters(),
        status: "rejected",
      },
    });
    assert.equal(state.candidateQuery.pageNumber, 1);
    assert.deepEqual(state.candidateQuery.cursorStack, []);
    assert.strictEqual(state.selectedEvent, first);
  });
});
