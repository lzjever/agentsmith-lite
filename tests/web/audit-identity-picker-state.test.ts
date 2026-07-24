import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  auditIdentityPresentationLabel,
  auditIdentityHydrationQuery,
  auditIdentityListPaging,
  createAuditIdentityPickerState,
  formatAuditIdentityLabel,
  reduceAuditIdentityPickerState,
} from "../../src/components/audit/auditIdentityPickerState.js";

const identity = {
  id: "user_1",
  displayName: "User One",
  email: "one@example.test",
};

describe("audit identity presentation", () => {
  it("formats identity fields consistently", () => {
    assert.equal(
      formatAuditIdentityLabel("user_1", "User One", "one@example.test"),
      "User One (one@example.test)",
    );
    assert.equal(
      formatAuditIdentityLabel("user_1", "User One", null),
      "User One",
    );
    assert.equal(
      formatAuditIdentityLabel("user_1", null, "one@example.test"),
      "one@example.test",
    );
    assert.equal(formatAuditIdentityLabel("user_1", null, null), "user_1");
  });

  it("uses a resolved label only for the current filter identity", () => {
    const presentation = {
      key: "user_1",
      identity,
    };

    assert.equal(
      auditIdentityPresentationLabel("user_1", presentation),
      "User One (one@example.test)",
    );
    assert.equal(
      auditIdentityPresentationLabel("user_2", presentation),
      "user_2",
    );
    assert.equal(auditIdentityPresentationLabel("user_2", null), "user_2");
  });
});

describe("audit identity picker list state", () => {
  it("keeps last-good options but removes stale paging authority for a failed search", () => {
    let state = createAuditIdentityPickerState("project_1", "actor");
    state = reduceAuditIdentityPickerState(state, {
      type: "list_request_started",
      requestId: "initial",
    });
    state = reduceAuditIdentityPickerState(state, {
      type: "list_request_succeeded",
      requestId: "initial",
      items: [identity],
      nextCursor: "old-next",
    });
    state = reduceAuditIdentityPickerState(state, {
      type: "list_request_finished",
      requestId: "initial",
    });

    state = reduceAuditIdentityPickerState(state, {
      type: "search_committed",
      query: "different",
    });
    state = reduceAuditIdentityPickerState(state, {
      type: "list_request_started",
      requestId: "search",
    });
    state = reduceAuditIdentityPickerState(state, {
      type: "list_request_failed",
      requestId: "search",
      message: "Identity results could not be loaded.",
    });
    state = reduceAuditIdentityPickerState(state, {
      type: "list_request_finished",
      requestId: "search",
    });

    assert.deepEqual(state.list.page?.items, [identity]);
    assert.deepEqual(auditIdentityListPaging(state), {
      pageNumber: 1,
      canPrevious: false,
      nextCursor: null,
    });
    assert.equal(state.list.error?.key.query, "different");

    state = reduceAuditIdentityPickerState(state, {
      type: "list_retry_requested",
    });
    assert.equal(state.list.pending, true);
    assert.equal(state.list.candidate.query, "different");

    const beforeStale = state;
    state = reduceAuditIdentityPickerState(state, {
      type: "list_request_succeeded",
      requestId: "initial",
      items: [],
      nextCursor: "stale",
    });
    assert.strictEqual(state, beforeStale);
  });

  it("pages only from a response owned by the current candidate key", () => {
    let state = createAuditIdentityPickerState("project_1", "subject");
    state = reduceAuditIdentityPickerState(state, {
      type: "list_request_started",
      requestId: "page-1",
    });
    state = reduceAuditIdentityPickerState(state, {
      type: "list_request_succeeded",
      requestId: "page-1",
      items: [identity],
      nextCursor: "subject-next",
    });
    state = reduceAuditIdentityPickerState(state, {
      type: "list_request_finished",
      requestId: "page-1",
    });
    state = reduceAuditIdentityPickerState(state, {
      type: "next_page_requested",
    });

    assert.equal(state.list.candidate.cursor, "subject-next");
    assert.deepEqual(auditIdentityListPaging(state), {
      pageNumber: 2,
      canPrevious: false,
      nextCursor: null,
    });
  });
});

describe("audit identity hydration state", () => {
  it("owns one bounded request per selected identity key and retries that key", () => {
    let state = createAuditIdentityPickerState("project_1", "actor");
    state = reduceAuditIdentityPickerState(state, {
      type: "hydration_candidate_changed",
      value: "former_user",
    });
    const sameCandidate = reduceAuditIdentityPickerState(state, {
      type: "hydration_candidate_changed",
      value: "former_user",
    });
    assert.strictEqual(sameCandidate, state);
    assert.deepEqual(
      auditIdentityHydrationQuery(state.hydration.candidate!),
      {
        role: "actor",
        q: "former_user",
        limit: 20,
      },
    );

    state = reduceAuditIdentityPickerState(state, {
      type: "hydration_request_started",
      requestId: "hydrate",
    });
    state = reduceAuditIdentityPickerState(state, {
      type: "hydration_request_failed",
      requestId: "hydrate",
      message: "Selected identity details could not be loaded.",
    });
    state = reduceAuditIdentityPickerState(state, {
      type: "hydration_request_finished",
      requestId: "hydrate",
    });
    state = reduceAuditIdentityPickerState(state, {
      type: "hydration_retry_requested",
    });

    assert.equal(state.hydration.pending, true);
    assert.equal(state.hydration.candidate?.value, "former_user");

    state = reduceAuditIdentityPickerState(state, {
      type: "hydration_candidate_changed",
      value: "new_user",
    });
    const ownedByNewValue = state;
    state = reduceAuditIdentityPickerState(state, {
      type: "hydration_request_succeeded",
      requestId: "hydrate",
      identity,
    });
    assert.strictEqual(state, ownedByNewValue);
  });
});
