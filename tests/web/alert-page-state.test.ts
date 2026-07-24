import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ActiveProjectAlert,
  InactiveProjectAlert,
  ProjectAlert
} from "../../packages/contracts/src/api.js";
import {
  createAlertPageState,
  reduceAlertPageState
} from "../../src/components/alerts/alertPageState.js";

const activeAlert = (
  id: string,
  overrides: Partial<ActiveProjectAlert> = {}
): ActiveProjectAlert => ({
  id,
  projectId: "project_1",
  type: "endpoint_failure",
  status: "active",
  deliveryStatus: "pending",
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
  resolvedAt: null,
  dismissedAt: null,
  ...overrides
});

const resolvedAlert = (
  id: string,
  overrides: Partial<InactiveProjectAlert> = {}
): InactiveProjectAlert => ({
  id,
  projectId: "project_1",
  type: "endpoint_failure",
  status: "resolved",
  deliveryStatus: "delivered",
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T01:00:00.000Z",
  resolvedAt: "2026-07-24T01:00:00.000Z",
  dismissedAt: null,
  ...overrides
});

function succeedList(
  state: ReturnType<typeof createAlertPageState>,
  requestId: string,
  rows: ProjectAlert[],
  nextCursor: string | null,
  activeCount: number
) {
  state = reduceAlertPageState(state, {
    type: "list_request_started",
    requestId
  });
  state = reduceAlertPageState(state, {
    type: "list_request_succeeded",
    requestId,
    rows,
    nextCursor,
    activeCount
  });
  return reduceAlertPageState(state, {
    type: "list_request_finished",
    requestId
  });
}

describe("alert page list state", () => {
  it("keeps the active count unknown on a direct Rules route without scheduling a hidden list read", () => {
    const state = createAlertPageState({ view: "rules" });

    assert.equal(state.view, "rules");
    assert.equal(state.page.activeCount, null);
    assert.equal(state.list.pending, false);
    assert.equal(state.list.loading, false);
  });

  it("models active, history, and rules views and resets list navigation on a view switch", () => {
    const row = activeAlert("alert_1");
    let state = succeedList(
      createAlertPageState(),
      "active-page-1",
      [row],
      "active-page-2",
      4
    );
    state = reduceAlertPageState(state, { type: "next_page" });

    assert.deepEqual(state.candidateQuery, {
      view: "active",
      cursor: "active-page-2",
      pageNumber: 2,
      cursorStack: ["active-page-2"]
    });

    state = reduceAlertPageState(state, {
      type: "view_changed",
      view: "history"
    });

    assert.equal(state.view, "history");
    assert.deepEqual(state.page, {
      rows: [],
      pageNumber: 1,
      cursorStack: [],
      nextCursor: null,
      activeCount: 4
    });
    assert.deepEqual(state.query, {
      view: "history",
      cursor: null,
      pageNumber: 1,
      cursorStack: []
    });
    assert.deepEqual(state.candidateQuery, state.query);

    state = reduceAlertPageState(state, {
      type: "view_changed",
      view: "rules"
    });
    assert.equal(state.view, "rules");
    assert.equal(state.query, null);
    assert.equal(state.candidateQuery, null);
    assert.deepEqual(state.page.rows, []);
    assert.equal(state.page.pageNumber, 1);
  });

  it("ignores stale responses and finally actions while preserving the last-good page on failure", () => {
    const current = activeAlert("alert_current");
    let state = succeedList(
      createAlertPageState(),
      "initial",
      [current],
      "cursor_2",
      2
    );
    state = reduceAlertPageState(state, {
      type: "selection_changed",
      alertId: current.id
    });
    state = reduceAlertPageState(state, { type: "next_page" });
    state = reduceAlertPageState(state, {
      type: "list_request_started",
      requestId: "stale"
    });
    state = reduceAlertPageState(state, {
      type: "list_request_started",
      requestId: "current"
    });

    const ownedByCurrent = state;
    const staleActions = [
      {
        type: "list_request_succeeded" as const,
        requestId: "stale",
        rows: [activeAlert("stale_row")],
        nextCursor: null,
        activeCount: 99
      },
      {
        type: "list_request_failed" as const,
        requestId: "stale",
        message: "stale failure"
      },
      {
        type: "list_request_finished" as const,
        requestId: "stale"
      }
    ];
    for (const action of staleActions) {
      state = reduceAlertPageState(state, action);
      assert.strictEqual(state, ownedByCurrent);
    }

    state = reduceAlertPageState(state, {
      type: "list_request_failed",
      requestId: "current",
      message: "Alerts are temporarily unavailable"
    });
    state = reduceAlertPageState(state, {
      type: "list_request_finished",
      requestId: "current"
    });

    assert.deepEqual(state.page.rows, [current]);
    assert.equal(state.page.pageNumber, 1);
    assert.deepEqual(state.page.cursorStack, []);
    assert.equal(state.page.nextCursor, "cursor_2");
    assert.deepEqual(state.query, {
      view: "active",
      cursor: null,
      pageNumber: 1,
      cursorStack: []
    });
    assert.deepEqual(state.candidateQuery, state.query);
    assert.equal(state.selectedAlertId, current.id);
    assert.equal(state.list.loading, false);
    assert.equal(state.list.error, "Alerts are temporarily unavailable");
  });

  it("replaces each cursor page and can navigate back to the preceding cursor", () => {
    const firstPage = [activeAlert("alert_1")];
    const secondPage = [activeAlert("alert_2")];
    let state = succeedList(
      createAlertPageState(),
      "page-1",
      firstPage,
      "cursor_2",
      2
    );

    state = reduceAlertPageState(state, { type: "next_page" });
    state = succeedList(state, "page-2", secondPage, "cursor_3", 2);

    assert.deepEqual(state.page.rows, secondPage);
    assert.equal(state.page.pageNumber, 2);
    assert.deepEqual(state.page.cursorStack, ["cursor_2"]);
    assert.deepEqual(state.query, {
      view: "active",
      cursor: "cursor_2",
      pageNumber: 2,
      cursorStack: ["cursor_2"]
    });

    state = reduceAlertPageState(state, { type: "previous_page" });
    assert.deepEqual(state.candidateQuery, {
      view: "active",
      cursor: null,
      pageNumber: 1,
      cursorStack: []
    });

    state = succeedList(state, "back-to-page-1", firstPage, "cursor_2", 2);
    assert.deepEqual(state.page.rows, firstPage);
    assert.equal(state.page.pageNumber, 1);
    assert.deepEqual(state.page.cursorStack, []);
  });

  it("replaces rows against current reducer state so sequential mutations do not lose updates", () => {
    const first = activeAlert("alert_1");
    const second = activeAlert("alert_2");
    let state = succeedList(
      createAlertPageState(),
      "initial",
      [first, second],
      null,
      2
    );
    const acknowledgedFirst = activeAlert("alert_1", {
      acknowledgedAt: "2026-07-24T01:00:00.000Z",
      acknowledgedBy: "user_1",
      updatedAt: "2026-07-24T01:00:00.000Z"
    });
    const silencedSecond = activeAlert("alert_2", {
      silencedUntil: "2026-07-24T02:00:00.000Z",
      updatedAt: "2026-07-24T01:01:00.000Z"
    });

    state = reduceAlertPageState(state, {
      type: "row_replaced",
      row: acknowledgedFirst
    });
    state = reduceAlertPageState(state, {
      type: "row_replaced",
      row: silencedSecond
    });

    assert.deepEqual(state.page.rows, [acknowledgedFirst, silencedSecond]);
  });

  it("revokes pre-mutation list authority and schedules a fresh current-view page after success", () => {
    const row = activeAlert("alert_1");
    const saved = activeAlert("alert_1", {
      acknowledgedAt: "2026-07-24T01:00:00.000Z",
      acknowledgedBy: "user_1",
      updatedAt: "2026-07-24T01:00:00.000Z"
    });
    let state = succeedList(
      createAlertPageState(),
      "initial",
      [row],
      "cursor_2",
      1
    );
    state = reduceAlertPageState(state, { type: "next_page" });
    state = reduceAlertPageState(state, {
      type: "list_request_started",
      requestId: "before-mutation"
    });
    state = reduceAlertPageState(state, {
      type: "mutation_started",
      requestId: "mutation-1",
      alert: row,
      action: "ack"
    });

    assert.equal(state.list.requestId, null);
    assert.equal(state.list.loading, false);
    assert.equal(state.list.pending, false);
    assert.deepEqual(state.candidateQuery, state.query);

    state = reduceAlertPageState(state, {
      type: "mutation_succeeded",
      requestId: "mutation-1",
      row: saved
    });
    assert.deepEqual(state.page.rows, [saved]);
    assert.equal(state.list.pending, true);
    assert.equal(state.candidateQuery?.view, "active");

    const afterMutation = state;
    state = reduceAlertPageState(state, {
      type: "list_request_succeeded",
      requestId: "before-mutation",
      rows: [activeAlert("stale")],
      nextCursor: null,
      activeCount: 99
    });
    assert.strictEqual(state, afterMutation);
    state = reduceAlertPageState(state, {
      type: "list_request_finished",
      requestId: "before-mutation"
    });
    assert.strictEqual(state, afterMutation);

    state = succeedList(
      state,
      "after-mutation",
      [saved],
      "cursor_2",
      1
    );
    assert.deepEqual(state.page.rows, [saved]);
    assert.equal(state.page.pageNumber, 1);
  });

  it("keeps mutation ownership, busy controls, and failures across view navigation", () => {
    const row = activeAlert("alert_1");
    let state = succeedList(
      createAlertPageState(),
      "initial",
      [row],
      null,
      1
    );
    state = reduceAlertPageState(state, {
      type: "mutation_started",
      requestId: "mutation-1",
      alert: row,
      action: "resolve"
    });
    state = reduceAlertPageState(state, {
      type: "view_changed",
      view: "rules"
    });

    assert.equal(state.view, "rules");
    assert.equal(state.mutation.requestId, "mutation-1");
    assert.equal(state.mutation.busyId, row.id);
    assert.equal(state.list.pending, false);

    state = reduceAlertPageState(state, {
      type: "mutation_failed",
      requestId: "mutation-1",
      message: "Alert could not be resolved"
    });
    state = reduceAlertPageState(state, {
      type: "mutation_finished",
      requestId: "mutation-1"
    });

    assert.equal(state.mutation.busyId, null);
    assert.equal(state.mutation.error, "Alert could not be resolved");

    state = reduceAlertPageState(state, {
      type: "route_changed",
      view: "history",
      linkedAlertId: null
    });
    assert.equal(state.mutation.error, "Alert could not be resolved");
    assert.equal(state.list.pending, true);
    assert.equal(state.candidateQuery?.view, "history");
  });

  it("refreshes the currently selected view when a mutation succeeds after navigation", () => {
    const row = activeAlert("alert_1");
    const saved = activeAlert("alert_1", {
      acknowledgedAt: "2026-07-24T01:00:00.000Z",
      acknowledgedBy: "user_1"
    });
    let state = succeedList(
      createAlertPageState(),
      "initial",
      [row],
      null,
      1
    );
    state = reduceAlertPageState(state, {
      type: "mutation_started",
      requestId: "mutation-1",
      alert: row,
      action: "ack"
    });
    state = reduceAlertPageState(state, {
      type: "view_changed",
      view: "history"
    });
    state = reduceAlertPageState(state, {
      type: "mutation_succeeded",
      requestId: "mutation-1",
      row: saved
    });

    assert.equal(state.view, "history");
    assert.equal(state.mutation.requestId, "mutation-1");
    assert.equal(state.list.pending, true);
    assert.deepEqual(state.candidateQuery, {
      view: "history",
      cursor: null,
      pageNumber: 1,
      cursorStack: []
    });
  });
});

describe("alert deep-link state", () => {
  it("applies a route view and linked id atomically before lookup chooses the canonical view", () => {
    const row = activeAlert("listed");
    let state = succeedList(
      createAlertPageState(),
      "initial",
      [row],
      null,
      1
    );
    state = reduceAlertPageState(state, {
      type: "route_changed",
      view: "history",
      linkedAlertId: "linked"
    });

    assert.equal(state.view, "history");
    assert.equal(state.linkedAlertId, "linked");
    assert.equal(state.selectedAlertId, "linked");
    assert.equal(state.linkedLookup.pending, true);
    assert.equal(state.list.pending, false);
    assert.deepEqual(state.page.rows, []);
    assert.equal(state.candidateQuery?.view, "history");

    state = reduceAlertPageState(state, {
      type: "route_changed",
      view: "rules",
      linkedAlertId: null
    });
    assert.equal(state.view, "rules");
    assert.equal(state.linkedAlertId, null);
    assert.equal(state.linkedLookup.pending, false);
    assert.equal(state.list.pending, false);
    assert.equal(state.candidateQuery, null);
  });

  it("keeps linked detail outside list rows and selects history for a resolved alert", () => {
    const listed = activeAlert("listed");
    const linked = resolvedAlert("linked");
    let state = succeedList(
      createAlertPageState({ linkedAlertId: linked.id }),
      "shared-request-id",
      [listed],
      null,
      1
    );
    state = reduceAlertPageState(state, {
      type: "linked_lookup_started",
      requestId: "shared-request-id"
    });
    state = reduceAlertPageState(state, {
      type: "linked_lookup_succeeded",
      requestId: "shared-request-id",
      alert: linked
    });

    assert.equal(state.view, "history");
    assert.equal(state.linkedAlertId, linked.id);
    assert.strictEqual(state.linkedAlert, linked);
    assert.equal(state.selectedAlertId, linked.id);
    assert.deepEqual(state.page.rows, []);
  });

  it("preserves a linked id and last detail on transient failure but clears them on 404", () => {
    const linked = resolvedAlert("linked");
    let state = createAlertPageState({ linkedAlertId: linked.id });
    state = reduceAlertPageState(state, {
      type: "linked_lookup_started",
      requestId: "lookup-1"
    });
    state = reduceAlertPageState(state, {
      type: "linked_lookup_succeeded",
      requestId: "lookup-1",
      alert: linked
    });
    state = reduceAlertPageState(state, {
      type: "linked_lookup_started",
      requestId: "lookup-2"
    });
    state = reduceAlertPageState(state, {
      type: "linked_lookup_failed",
      requestId: "lookup-2",
      reason: "transient",
      message: "Alert detail is temporarily unavailable"
    });

    assert.equal(state.linkedAlertId, linked.id);
    assert.strictEqual(state.linkedAlert, linked);
    assert.equal(state.selectedAlertId, linked.id);
    assert.equal(
      state.linkedLookup.error,
      "Alert detail is temporarily unavailable"
    );

    state = reduceAlertPageState(state, {
      type: "linked_lookup_started",
      requestId: "lookup-3"
    });
    state = reduceAlertPageState(state, {
      type: "linked_lookup_failed",
      requestId: "lookup-3",
      reason: "not_found",
      message: "Alert not found"
    });

    assert.equal(state.linkedAlertId, null);
    assert.equal(state.linkedAlert, null);
    assert.equal(state.selectedAlertId, null);
  });
});
