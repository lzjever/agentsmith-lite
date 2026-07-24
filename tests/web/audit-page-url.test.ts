import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  auditCanonicalNavigation,
  auditCommittedNavigation,
  auditTimeInputValue,
  auditTimeValueFromInput,
  parseAuditPageFilters,
} from "../../src/components/audit/auditPageUrl.js";
import { emptyAuditFilters } from "../../src/components/audit/auditPageState.js";

describe("audit page URL state", () => {
  it("parses all eight canonical filters and preserves exact timestamp instants", () => {
    const from = "2026-07-24T10:30:45.123-07:00";
    const through = "2026-07-24T12:00:00.001Z";

    assert.deepEqual(
      parseAuditPageFilters(
        `actorId=system&subjectUserId=user_2&action=task.create&status=rejected&resourceKind=task&resourceId=task_exact&from=${encodeURIComponent(from)}&to=${encodeURIComponent(through)}`,
      ),
      {
        actorId: "system",
        subjectUserId: "user_2",
        action: "task.create",
        status: "rejected",
        resourceKind: "task",
        resourceId: "task_exact",
        from,
        to: through,
      },
    );
  });

  it("drops invalid enum and timestamp values during canonical replacement", () => {
    const filters = parseAuditPageFilters(
      "action=task.historical_terminal&status=unknown&resourceKind=unknown&from=invalid&resourceId=",
    );
    assert.deepEqual(filters, emptyAuditFilters());
    assert.deepEqual(
      auditCanonicalNavigation(
        "https://agentsmith.test/projects/project_1/audit?action=task.historical_terminal&cursor=opaque&eventId=event_1#events",
        filters,
      ),
      {
        kind: "replace",
        href: "/projects/project_1/audit#events",
      },
    );
  });

  it("pushes one canonical URL for a commit or clear without session cursor state", () => {
    assert.deepEqual(
      auditCommittedNavigation(
        "https://agentsmith.test/projects/project_1/audit?cursor=opaque&unknown=true#events",
        {
          ...emptyAuditFilters(),
          actorId: "user_1",
          resourceId: "task_1",
        },
      ),
      {
        kind: "push",
        href: "/projects/project_1/audit?actorId=user_1&resourceId=task_1#events",
      },
    );
    assert.equal(
      auditCommittedNavigation(
        "https://agentsmith.test/projects/project_1/audit?action=task.create",
        emptyAuditFilters(),
      ).href,
      "/projects/project_1/audit",
    );
  });

  it("uses local minute start/end only after a UI edit", () => {
    const exact = "2026-07-24T10:30:45.123Z";
    const input = "2026-07-24T10:30";

    assert.match(
      auditTimeInputValue(exact),
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    );
    assert.match(
      auditTimeValueFromInput(input, "from") ?? "",
      /:30:00\.000Z$/,
    );
    assert.match(
      auditTimeValueFromInput(input, "through") ?? "",
      /:30:59\.999Z$/,
    );
  });
});
