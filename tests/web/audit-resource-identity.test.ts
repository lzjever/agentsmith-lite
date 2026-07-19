import assert from "node:assert/strict";
import test from "node:test";
import { auditResourceIdentity } from "../../src/components/resources/audit-resource-identity.js";

test("audit resource identity explains project-level provider calls", () => {
  assert.equal(auditResourceIdentity("provider", null), "Project-level provider activity");
  assert.equal(auditResourceIdentity("provider", "endpoint_1"), "endpoint_1");
  assert.equal(auditResourceIdentity("project", null), "-");
});
