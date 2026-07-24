import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalAlertPageNavigation,
  parseAlertPageRoute,
  tabAlertPageNavigation
} from "../../src/components/alerts/alertPageUrl.js";

describe("alert page URL state", () => {
  it("parses view and linked id together with active as the canonical default", () => {
    assert.deepEqual(
      parseAlertPageRoute("view=history&alertId=alert_1"),
      { view: "history", linkedAlertId: "alert_1" }
    );
    assert.deepEqual(
      parseAlertPageRoute("view=unsupported"),
      { view: "active", linkedAlertId: null }
    );
    assert.deepEqual(
      parseAlertPageRoute("view=rules&alertId="),
      { view: "rules", linkedAlertId: null }
    );
  });

  it("makes a user tab selection a push that clears the linked alert and preserves unrelated URL state", () => {
    assert.deepEqual(
      tabAlertPageNavigation(
        "https://agentsmith.test/projects/project_1/alerts?scope=mine&view=active&alertId=alert_1#results",
        "history"
      ),
      {
        kind: "push",
        href: "/projects/project_1/alerts?scope=mine&view=history#results"
      }
    );
  });

  it("makes reducer canonicalization a replace without dropping unrelated URL state", () => {
    assert.deepEqual(
      canonicalAlertPageNavigation(
        "https://agentsmith.test/projects/project_1/alerts?scope=mine&view=active&alertId=alert_1",
        { view: "history", linkedAlertId: "alert_1" }
      ),
      {
        kind: "replace",
        href: "/projects/project_1/alerts?scope=mine&view=history&alertId=alert_1"
      }
    );
  });
});
