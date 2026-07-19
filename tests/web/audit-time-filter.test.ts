import assert from "node:assert/strict";
import test from "node:test";
import {
  auditTimeInputFromQuery,
  auditTimeQueryFromInput,
} from "../../src/components/resources/audit-time-filter.js";

test("round-trips audit datetime-local values through an ISO query value", () => {
  const input = "2026-07-18T10:30";
  const query = auditTimeQueryFromInput(input);

  assert.ok(query);
  assert.match(query, /^2026-07-18T\d{2}:30:00\.000Z$/);
  assert.equal(auditTimeInputFromQuery(query), input);
});

test("drops empty or invalid audit time filters", () => {
  assert.equal(auditTimeQueryFromInput(""), null);
  assert.equal(auditTimeQueryFromInput("not-a-time"), null);
  assert.equal(auditTimeInputFromQuery(null), "");
  assert.equal(auditTimeInputFromQuery("not-a-time"), "");
});
